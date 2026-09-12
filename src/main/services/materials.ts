import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync, copyFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { shell } from 'electron'

import {
  MATERIAL_HEAD_BYTES,
  MATERIAL_MAGIC,
  isMaterialExtension,
  materialRejectReason,
  type MaterialExtension
} from '@shared/materials'
import {
  MAX_MATERIAL_BATCH,
  MAX_MATERIAL_BYTES,
  MAX_MATERIAL_TITLE,
  MAX_MATERIALS
} from '@shared/limits'
import type { MaterialImportInput, MaterialImportResult, MaterialItem } from '@shared/types'

import { ensureDir, newId, safeJoin } from '../paths'
import { safeNoteTitle } from './notes'

/**
 * 课程资料存储：PDF / PPT / Word / Excel 的「附件库」。
 *
 * 位置在**笔记库内**（attachments/），与课表图片、站点图标的「数据目录」不同——
 * 资料要跟笔记待在一起：Obsidian 原生能预览库里的 PDF，笔记里可以用
 * `![[文件名]]` 嵌入，备份/同步也只管一个文件夹。
 *
 * 与课表 / 门户同一套规矩：单个 JSON 索引、原子写入、坏了就备份重建。
 * **磁盘上的文件是本体**，索引只是簿记；对账只把「索引有、磁盘没了」标记成
 * missing 而不摘除——文件多半只是被挪走了，摘掉关联就真找不回来了。
 *
 * 导入是**复制**而不是移动：用户的下载目录是个人领地，应用一个字节都不动
 * （收件箱是唯一的例外——那是应用与扩展约定的中转站，见 ipc/materials.ts）。
 */

const CONFIG_VERSION = 1

interface MaterialsContent {
  version: number
  items: MaterialItem[]
}

/** 读文件头若干字节，做魔数校验用 */
function readHead(file: string, bytes: number): Buffer {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也不影响后续 */
      }
    }
  }
}

function matchesMagic(head: Buffer, ext: MaterialExtension): boolean {
  return MATERIAL_MAGIC[ext].some((magic) => {
    const prefix = Buffer.from(magic, 'binary')
    return head.length >= prefix.length && head.subarray(0, prefix.length).equals(prefix)
  })
}

/**
 * 入库文件名 = 课程名_资料名.扩展名。
 *
 * 课程名放进去是给「在 Obsidian / 资源管理器里翻文件」用的——归属本身靠
 * courseCardId，课程后来改名了文件名不会跟着改（与卡片「不复制课表信息」
 * 同一个取舍：文件名只是导入那一刻的快照）。
 *
 * 返回 base（文件名主体）与 title（用户可读名 = 清洗后的资料名本身）。
 */
function buildFileBase(
  title: string,
  courseName: string
): { base: string; title: string } {
  const cleanTitle = safeNoteTitle(title)
  const prefix = courseName.trim().length > 0 ? `${safeNoteTitle(courseName)}_` : ''
  return {
    base: safeNoteTitle(`${prefix}${cleanTitle}`).slice(0, MAX_MATERIAL_TITLE),
    title: cleanTitle.slice(0, MAX_MATERIAL_TITLE)
  }
}

function sanitizeItem(raw: unknown): MaterialItem | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = String(input['id'] ?? '').trim()
  const fileName = String(input['fileName'] ?? '').trim()
  const extRaw = extname(fileName).slice(1).toLowerCase()
  if (!id || !fileName || fileName.includes('/') || fileName.includes('\\')) return null
  if (!isMaterialExtension(extRaw) || fileName.startsWith('.')) return null

  return {
    id: id.slice(0, 64),
    fileName,
    title: String(input['title'] ?? '').slice(0, MAX_MATERIAL_TITLE),
    ext: extRaw as MaterialExtension,
    bytes: Number.isFinite(Number(input['bytes'])) ? Math.max(0, Math.trunc(Number(input['bytes']))) : 0,
    courseCardId: String(input['courseCardId'] ?? '').slice(0, 64),
    sourceName: String(input['sourceName'] ?? '').slice(0, 255),
    importedAt: String(input['importedAt'] ?? '') || new Date().toISOString(),
    missing: false
  }
}

export class MaterialsStore {
  #dir: string
  #file: string
  #content: MaterialsContent

  constructor(notesLibraryDir: string) {
    this.#dir = ensureDir(join(notesLibraryDir, 'attachments'))
    this.#file = join(this.#dir, '.materials.json')
    this.#content = this.#load()
  }

  #load(): MaterialsContent {
    if (!existsSync(this.#file)) return { version: CONFIG_VERSION, items: [] }
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf-8')) as { items?: unknown }
      const items: MaterialItem[] = []
      if (Array.isArray(raw.items)) {
        for (const entry of raw.items) {
          if (items.length >= MAX_MATERIALS) break
          const item = sanitizeItem(entry)
          if (item) items.push(item)
        }
      }
      return { version: CONFIG_VERSION, items }
    } catch (error) {
      console.error('[materials] 索引解析失败，已备份并重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败也不能因此启动不了 */
      }
      return { version: CONFIG_VERSION, items: [] }
    }
  }

  #persist(): void {
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#content, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  /** 目录里的资料文件（忽略点开头的隐藏文件——索引文件自己就是这么被跳过的） */
  #scan(): string[] {
    try {
      return readdirSync(this.#dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.'))
        .filter((name) => isMaterialExtension(extname(name).slice(1)))
    } catch {
      return []
    }
  }

  /**
   * 与磁盘对账。索引里有、磁盘上没了 → 标 missing，**不摘除**：
   * 文件多半只是被挪了位置，摘掉的话「挂在哪门课」这条信息就永久丢了。
   */
  #reconcile(): void {
    const onDisk = new Set(this.#scan().map((name) => name.toLowerCase()))
    let changed = false
    for (const item of this.#content.items) {
      const missing = !onDisk.has(item.fileName.toLowerCase())
      if (item.missing !== missing) {
        item.missing = missing
        changed = true
      }
    }
    if (changed) this.#persist()
  }

  list(): MaterialItem[] {
    this.#reconcile()
    return this.#content.items
      .map((item) => ({ ...item }))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
  }

  find(id: unknown): MaterialItem | null {
    const target = String(id ?? '')
    this.#reconcile()
    return this.#content.items.find((item) => item.id === target) ?? null
  }

  /** 库内文件的完整路径。渲染层永远不传路径，只传 id / 文件名 */
  pathOf(fileName: string): string {
    return safeJoin(this.#dir, fileName)
  }

  /**
   * 导入：四道闸（数量 → 扩展名 → 大小 → 魔数）+ 复制入库 + 登记。
   *
   * 逐条独立成败，失败原因原样回传（`{added, errors}`，与课表图片导入同一模式）。
   * `courseName` 由 IPC 层查出传入——归属前缀要用它，但跨存储的查询不该进 store。
   */
  async import(
    input: MaterialImportInput,
    courseName: string
  ): Promise<MaterialImportResult> {
    const errors: string[] = []
    const recycled: string[] = []
    let added = 0
    const paths = Array.isArray(input?.paths) ? input.paths.map((p) => String(p)) : []

    if (paths.length > MAX_MATERIAL_BATCH) {
      errors.push(`一次最多导入 ${MAX_MATERIAL_BATCH} 个文件`)
    }

    for (const rawPath of paths.slice(0, MAX_MATERIAL_BATCH)) {
      try {
        const source = String(rawPath ?? '')
        if (source.length === 0) throw new Error('空路径')
        const sourceName = basename(source)
        const extRaw = extname(sourceName).slice(1).toLowerCase()
        if (!isMaterialExtension(extRaw)) throw new Error(materialRejectReason(sourceName))
        const ext = extRaw as MaterialExtension

        const stat = statSync(source)
        if (!stat.isFile()) throw new Error('不是普通文件')
        if (stat.size > MAX_MATERIAL_BYTES) {
          throw new Error(`超过大小上限（${Math.round(MAX_MATERIAL_BYTES / 1024 / 1024)} MB）`)
        }
        if (stat.size === 0) throw new Error('空文件')

        // 魔数校验：扩展名是「自称」，文件头才是「出身」
        const head = readHead(source, MATERIAL_HEAD_BYTES)
        if (!matchesMagic(head, ext)) {
          throw new Error('文件内容与扩展名不符（可能是伪装或损坏的文件）')
        }

        if (this.#content.items.length >= MAX_MATERIALS) {
          throw new Error(`资料最多 ${MAX_MATERIALS} 份`)
        }

        const { base, title } = buildFileBase(
          input?.title && input.title.trim().length > 0 ? input.title : sourceName.slice(0, -extname(sourceName).length),
          courseName
        )
        if (base.length === 0) throw new Error('资料名无效')
        const fileName = this.#uniqueName(base, ext)

        // 先写临时名再改名：半截复制的文件不会顶着正式名字留在库里
        const target = safeJoin(this.#dir, fileName)
        const tmp = `${target}.importing`
        copyFileSync(source, tmp)
        renameSync(tmp, target)

        const now = new Date().toISOString()
        this.#content.items.push({
          id: newId(),
          fileName,
          title,
          ext,
          bytes: statSync(target).size,
          courseCardId: String(input?.courseCardId ?? '').slice(0, 64),
          sourceName,
          importedAt: now,
          missing: false
        })
        added += 1
        recycled.push(source)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        errors.push(`${basename(String(rawPath ?? ''))}：${reason}`)
      }
    }

    // 先落盘再收尾：移入回收站是 Windows 的 Shell 操作，可能要等上几百毫秒甚至更久，
    // 放在 persist 前会让 IPC 迟迟不返回、界面卡在「导入中」。
    // 它只是收尾——失败也不影响导入结果，但要让用户知道原文件还躺在原地
    if (added > 0) this.#persist()
    if (input?.sourcePolicy === 'recycle') {
      for (const source of recycled) {
        try {
          await shell.trashItem(source)
        } catch (error) {
          console.warn('[materials] 原文件移入回收站失败（保留在收件箱）：', error)
          errors.push(`${basename(source)}：已导入，但原文件移入回收站失败，仍留在收件箱`)
        }
      }
    }
    return { materials: this.list(), added, errors }
  }

  /** 同名自动加 " (2)"、" (3)"……与笔记重名的行为一致 */
  #uniqueName(base: string, ext: MaterialExtension): string {
    let candidate = `${base}.${ext}`
    for (let n = 2; existsSync(safeJoin(this.#dir, candidate)); n += 1) {
      candidate = `${base} (${n}).${ext}`
    }
    return candidate
  }

  /**
   * 改名。改的是「用户可读名」，文件名跟着重建——文件名里带着归属前缀和这个名字，
   * 在 Obsidian / 资源管理器里才有辨识度。
   */
  async rename(id: unknown, title: string): Promise<MaterialItem[]> {
    const item = this.find(id)
    if (!item) throw new Error('资料不存在')
    const clean = safeNoteTitle(title)
    if (clean.length === 0) throw new Error('资料名不能为空')

    // 前缀沿用现在文件名里的课程前缀（导入那一刻的快照），不改归属
    const oldBase = item.fileName.slice(0, -extname(item.fileName).length)
    const separator = oldBase.indexOf('_')
    const prefix = separator > 0 ? `${oldBase.slice(0, separator)}_` : ''
    const nextBase = safeNoteTitle(`${prefix}${clean}`).slice(0, MAX_MATERIAL_TITLE)
    if (nextBase.length === 0) throw new Error('资料名无效')

    const nextName = this.#uniqueName(nextBase, item.ext)
    if (nextName !== item.fileName) {
      renameSync(safeJoin(this.#dir, item.fileName), safeJoin(this.#dir, nextName))
      item.fileName = nextName
    }
    item.title = clean
    this.#persist()
    return this.list()
  }

  /** 删除 = 文件进系统回收站（可恢复），索引摘除 */
  async remove(id: unknown): Promise<MaterialItem[]> {
    const item = this.find(id)
    if (!item) return this.list()
    try {
      await shell.trashItem(this.pathOf(item.fileName))
    } catch (error) {
      console.error('[materials] 移入回收站失败：', error)
      throw new Error('移入回收站失败，文件可能正被其它程序打开')
    }
    this.#content.items = this.#content.items.filter((entry) => entry.id !== item.id)
    this.#persist()
    return this.list()
  }

  /** 改归属。卡片删除后这里留着悬空的 id，界面上显示成「未归类」 */
  setCard(id: unknown, courseCardId: unknown): MaterialItem[] {
    const item = this.find(id)
    if (!item) return this.list()
    item.courseCardId = String(courseCardId ?? '').slice(0, 64)
    this.#persist()
    return this.list()
  }

  /**
   * 库里没有、但躺在资料目录里的文件。
   *
   * 资料没有 frontmatter 那样的 id 载体，外部新增**不自动认领**——
   * 用户手动拷进来的东西，由他决定收不收（claim 走同一套导入闸口）。
   */
  unregistered(): { fileName: string; bytes: number }[] {
    this.#reconcile()
    const known = new Set(this.#content.items.map((item) => item.fileName.toLowerCase()))
    return this.#scan()
      .filter((name) => !known.has(name.toLowerCase()))
      .map((name) => {
        try {
          return { fileName: name, bytes: statSync(safeJoin(this.#dir, name)).size }
        } catch {
          return { fileName: name, bytes: 0 }
        }
      })
  }

  /** 收编一个未登记文件：走同一套魔数校验，成功后补登记 */
  async claim(fileName: string, courseCardId: string, courseName: string): Promise<MaterialImportResult> {
    const clean = String(fileName ?? '')
    if (clean.includes('/') || clean.includes('\\') || clean.startsWith('.')) {
      throw new Error('非法的文件名')
    }
    const full = this.pathOf(clean)
    if (!existsSync(full)) throw new Error('文件不存在')
    return this.import({ paths: [full], courseCardId }, courseName)
  }

  get dir(): string {
    return this.#dir
  }
}
