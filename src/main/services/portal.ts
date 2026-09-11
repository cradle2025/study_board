import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { MAX_PORTAL_SITES, PORTAL_ICON_EDGE } from '@shared/limits'
import { colorForSite, normalizeSiteName, normalizeSiteUrl, sanitizeColor } from '@shared/portal'
import type { PortalSite, PortalSiteInput } from '@shared/types'

import { ensureDir, newId, safeJoin } from '../paths'

/**
 * 网站门户存储。
 *
 * 落盘格式同样是单个 JSON（`portal.json`），理由与课表一致：条目很少、
 * 需要能被人直接看和改、也不该为了几个快捷方式引入数据库。
 *
 * 内置站点（慕课 / B站 / 知网）的处理有一点讲究：
 *  - 用**固定 id** 而不是每次生成，这样「已隐藏」的状态能一直对得上，
 *    不会因为重启又冒出来；
 *  - 只能隐藏、不能删除——需求里这三个是默认就该有的，删了就找不回来。
 */

const CONFIG_VERSION = 1

/** 图标文件名：uuid.png（防御被篡改的配置文件指向目录外的文件） */
const ICON_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

interface BuiltinSeed {
  id: string
  name: string
  url: string
  color: string
}

/** 需求里点名的三个默认学习站点 */
const BUILTIN_SITES: readonly BuiltinSeed[] = [
  { id: 'builtin-mooc', name: '中国大学 MOOC', url: 'https://www.icourse163.org/', color: '#d64545' },
  { id: 'builtin-bilibili', name: '哔哩哔哩', url: 'https://www.bilibili.com/', color: '#fb7299' },
  { id: 'builtin-cnki', name: '中国知网', url: 'https://www.cnki.net/', color: '#3b6ef0' }
]

interface PortalContent {
  version: number
  sites: PortalSite[]
}

function byOrder(a: PortalSite, b: PortalSite): number {
  return a.order - b.order
}

function sanitizeSite(raw: unknown, index: number): PortalSite | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = String(input['id'] ?? '').trim()
  const name = normalizeSiteName(input['name'])
  const url = String(input['url'] ?? '').trim()

  if (!id || name.length === 0 || url.length === 0) return null

  const host = String(input['host'] ?? '')
  const fallback = colorForSite(name, host || url)

  return {
    id: id.slice(0, 64),
    name,
    url: url.slice(0, 2048),
    iconFile: ICON_FILE_PATTERN.test(String(input['iconFile'] ?? ''))
      ? String(input['iconFile'])
      : '',
    color: sanitizeColor(input['color'], fallback),
    builtin: input['builtin'] === true,
    hidden: input['hidden'] === true,
    order: Number.isFinite(Number(input['order'])) ? Math.trunc(Number(input['order'])) : index
  }
}

function sanitizeContent(raw: unknown): PortalContent {
  const input = (raw ?? {}) as Record<string, unknown>
  const sites: PortalSite[] = []

  if (Array.isArray(input['sites'])) {
    for (let i = 0; i < input['sites'].length && sites.length < MAX_PORTAL_SITES; i += 1) {
      const site = sanitizeSite(input['sites'][i], i)
      if (site) sites.push(site)
    }
  }
  return { version: CONFIG_VERSION, sites }
}

export class PortalStore {
  #file: string
  #iconsDir: string
  #content: PortalContent

  constructor(file: string, iconsDir: string) {
    this.#file = file
    this.#iconsDir = ensureDir(iconsDir)
    ensureDir(dirname(file))
    this.#content = this.#load()
    this.#seedBuiltins()
  }

  #load(): PortalContent {
    if (!existsSync(this.#file)) return { version: CONFIG_VERSION, sites: [] }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf-8'))
      return sanitizeContent(parsed)
    } catch (error) {
      console.error('[portal] 门户文件解析失败，已备份并重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败也不能因此启动不了 */
      }
      return { version: CONFIG_VERSION, sites: [] }
    }
  }

  /**
   * 补齐缺失的内置站点。
   * 只补「id 不存在」的，所以用户隐藏掉的内置站点不会在下一次启动时复活。
   */
  #seedBuiltins(): void {
    let changed = false
    for (const seed of BUILTIN_SITES) {
      if (this.#content.sites.some((site) => site.id === seed.id)) continue
      this.#content.sites.push({
        id: seed.id,
        name: seed.name,
        url: seed.url,
        iconFile: '',
        color: seed.color,
        builtin: true,
        hidden: false,
        order: this.#content.sites.length
      })
      changed = true
    }
    if (changed) this.#persist()
  }

  #persist(): void {
    const payload = JSON.stringify(this.#content, null, 2)
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  #nextOrder(): number {
    let max = -1
    for (const site of this.#content.sites) max = Math.max(max, site.order)
    return max + 1
  }

  /** 只读快照（深拷贝），与课表存储保持同一套约定 */
  list(): PortalSite[] {
    return structuredClone(this.#content.sites).sort(byOrder)
  }

  find(id: unknown): PortalSite | null {
    const target = String(id ?? '')
    return this.#content.sites.find((site) => site.id === target) ?? null
  }

  /**
   * 新建或更新一个站点。
   *
   * 网址换掉时会**清掉已缓存的图标**：旧图标属于旧网址，留着只会误导人。
   * 用户可以点「重新抓取」补回来。
   */
  upsert(input: PortalSiteInput): PortalSite[] {
    const name = normalizeSiteName(input?.name)
    if (name.length === 0) throw new Error('请填写站点名称')

    const checked = normalizeSiteUrl(input?.url)
    if (!checked.ok) throw new Error(checked.error)

    const id = String(input?.id ?? '').trim()
    const existing = id ? this.find(id) : null

    if (existing) {
      existing.name = name
      // 网址换了就丢掉旧图标：旧图标属于旧网址，留着只会误导人
      existing.iconFile = existing.url === checked.url ? existing.iconFile : ''
      existing.url = checked.url
      existing.color = sanitizeColor(input?.color, existing.color)
      if (input?.hidden !== undefined) existing.hidden = input.hidden === true
      this.#persist()
      return this.list()
    }

    if (this.#content.sites.length >= MAX_PORTAL_SITES) {
      throw new Error(`最多只能添加 ${MAX_PORTAL_SITES} 个站点`)
    }

    this.#content.sites.push({
      id: newId(),
      name,
      url: checked.url,
      iconFile: '',
      color: sanitizeColor(input?.color, colorForSite(name, checked.host)),
      builtin: false,
      hidden: false,
      order: this.#nextOrder()
    })
    this.#persist()
    return this.list()
  }

  remove(id: unknown): PortalSite[] {
    const target = this.find(id)
    if (!target) return this.list()
    if (target.builtin) throw new Error('内置站点不能删除，可以隐藏')

    this.#content.sites = this.#content.sites.filter((site) => site.id !== target.id)
    this.#persist()

    // 先删记录再删文件：万一删文件失败，也只是留个孤儿文件，不会出现「记录指向不存在的文件」
    if (target.iconFile) this.#dropIcon(target.iconFile)
    return this.list()
  }

  /** 抓取图标成功后回写文件名 */
  setIcon(id: unknown, iconFile: string): PortalSite[] {
    const target = this.find(id)
    if (!target) throw new Error('站点不存在')
    const previous = target.iconFile
    target.iconFile = iconFile
    this.#persist()
    if (previous && previous !== iconFile) this.#dropIcon(previous)
    return this.list()
  }

  #dropIcon(fileName: string): void {
    try {
      rmSync(safeJoin(this.#iconsDir, fileName), { force: true })
    } catch (error) {
      console.error('[portal] 删除图标文件失败：', error)
    }
  }

  /** 图标落盘：只接受已经过 nativeImage 解码并重新编码过的 PNG 字节 */
  writeIcon(data: Buffer): string {
    const fileName = `${newId()}.png`
    writeFileSync(safeJoin(this.#iconsDir, fileName), data, { mode: 0o600 })
    return fileName
  }

  get iconsDir(): string {
    return this.#iconsDir
  }

  get iconEdge(): number {
    return PORTAL_ICON_EDGE
  }

  /** 清理「有文件但没记录」的孤儿图标，防止图标目录无限膨胀 */
  sweepOrphans(): number {
    const known = new Set(this.#content.sites.map((site) => site.iconFile).filter(Boolean))
    let removed = 0
    try {
      for (const entry of readdirSync(this.#iconsDir)) {
        if (known.has(entry)) continue
        try {
          rmSync(safeJoin(this.#iconsDir, entry), { force: true })
          removed += 1
        } catch {
          /* 单个文件删不掉不影响其它 */
        }
      }
    } catch {
      /* 目录读不了就跳过 */
    }
    return removed
  }

  get filePath(): string {
    return this.#file
  }
}
