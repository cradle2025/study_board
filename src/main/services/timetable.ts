import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'

import { MAX_PERIODS, MAX_TIMETABLE_IMAGES, MIN_PERIODS } from '@shared/limits'
import type { CourseImage, PeriodRow, TimetableCell } from '@shared/types'

import { ensureDir, newId, safeJoin } from '../paths'
import { extOf, normalizeImage } from './imageImport'

/**
 * 课表内容存储。
 *
 * 只负责「录入内容」：每节的时间、每天的课程单元格、课表照片。
 * 「形状」（当前是表格还是图片模式、每天几节、星期表头叫什么）存在设置里，
 * 由 ipc/timetable.ts 组装成完整的 TimetableData。
 *
 * 落盘格式：单个 timetable.json，原子写入（先写 .tmp 再 rename）。
 * 内容量很小（几十个单元格），比起数据库，纯 JSON 更通用、更好人工查看、
 * 也更容易被 Git 管理——符合本项目「最底层、最通用」的取向。
 */

const CONFIG_VERSION = 1

/** 单元格 key："节次:列号"，列号 0=周一 … 6=周日 */
const CELL_KEY_PATTERN = /^([1-9]\d?):([0-6])$/
/** HH:mm */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
/** 落盘图片文件名：uuid + 白名单扩展名（防御被篡改的配置文件指向目录外） */
const IMAGE_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/

const MAX_COURSE_NAME = 60
const MAX_TEACHER = 40
const MAX_LOCATION = 60
const MAX_DURATION = 40
const MAX_REMARK = 300

export interface TimetableContent {
  version: number
  rows: PeriodRow[]
  cells: Record<string, TimetableCell>
  images: CourseImage[]
}

function emptyContent(): TimetableContent {
  return { version: CONFIG_VERSION, rows: [], cells: {}, images: [] }
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function isBlankCell(cell: TimetableCell): boolean {
  return (
    cell.courseName === '' &&
    cell.teacher === '' &&
    cell.location === '' &&
    cell.duration === '' &&
    cell.remark === ''
  )
}

function sanitizeCell(raw: unknown): TimetableCell {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    courseName: text(input['courseName'], MAX_COURSE_NAME),
    teacher: text(input['teacher'], MAX_TEACHER),
    location: text(input['location'], MAX_LOCATION),
    duration: text(input['duration'], MAX_DURATION),
    remark: text(input['remark'], MAX_REMARK)
  }
}

function sanitizeTime(value: unknown): string {
  const raw = String(value ?? '').trim()
  return TIME_PATTERN.test(raw) ? raw : ''
}

function sanitizeRow(raw: unknown): PeriodRow | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const index = Math.trunc(Number(input['index']))
  if (!Number.isFinite(index) || index < MIN_PERIODS || index > MAX_PERIODS) return null
  return { index, start: sanitizeTime(input['start']), end: sanitizeTime(input['end']) }
}

function sanitizeImage(raw: unknown): CourseImage | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = String(input['id'] ?? '').trim()
  const fileName = String(input['fileName'] ?? '').trim()
  if (!id || !IMAGE_FILE_PATTERN.test(fileName)) return null
  const width = Math.trunc(Number(input['width']))
  const height = Math.trunc(Number(input['height']))
  const bytes = Math.trunc(Number(input['bytes']))
  return {
    id: id.slice(0, 64),
    fileName,
    sourceName: text(input['sourceName'], 200) || fileName,
    addedAt: String(input['addedAt'] ?? '') || new Date().toISOString(),
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  }
}

/** 把磁盘上的原始 JSON 收敛成可信结构；任何一条数据不合法就丢掉它，而不是整个文件报废 */
function sanitizeContent(raw: unknown): TimetableContent {
  const input = (raw ?? {}) as Record<string, unknown>
  const result = emptyContent()

  if (Array.isArray(input['rows'])) {
    for (const item of input['rows']) {
      const row = sanitizeRow(item)
      if (row) result.rows.push(row)
    }
  }

  if (input['cells'] && typeof input['cells'] === 'object') {
    for (const [key, value] of Object.entries(input['cells'] as Record<string, unknown>)) {
      const match = CELL_KEY_PATTERN.exec(key)
      if (!match) continue
      const cell = sanitizeCell(value)
      if (isBlankCell(cell)) continue
      result.cells[key] = cell
    }
  }

  if (Array.isArray(input['images'])) {
    for (const item of input['images']) {
      const image = sanitizeImage(item)
      if (image) result.images.push(image)
      if (result.images.length >= MAX_TIMETABLE_IMAGES) break
    }
  }

  return result
}

export class TimetableStore {
  #file: string
  #imagesDir: string
  #content: TimetableContent

  constructor(file: string, imagesDir: string) {
    this.#file = file
    this.#imagesDir = ensureDir(imagesDir)
    ensureDir(dirname(file))
    this.#content = this.#load()
  }

  #load(): TimetableContent {
    if (!existsSync(this.#file)) return emptyContent()
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf-8'))
      return sanitizeContent(parsed)
    } catch (error) {
      // 配置文件损坏时不阻塞启动：备份一份现场，然后用空内容继续
      console.error('[timetable] 课表文件解析失败，已备份并重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败就算了，不能因此启动不了 */
      }
      return emptyContent()
    }
  }

  #persist(): void {
    const payload = JSON.stringify(this.#content, null, 2)
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  /** 只读快照（深拷贝，避免调用方改到内部状态） */
  get(): TimetableContent {
    return structuredClone(this.#content)
  }

  /** 每节的时间设置。只有非空的时间才会被保留，避免存一堆空行 */
  setRows(raw: unknown): TimetableContent {
    if (!Array.isArray(raw)) throw new Error('rows 必须是数组')
    const rows: PeriodRow[] = []
    for (const item of raw) {
      const row = sanitizeRow(item)
      if (!row) continue
      if (row.start === '' && row.end === '') continue
      rows.push(row)
    }
    this.#content.rows = rows
    this.#persist()
    return this.get()
  }

  /** 写入 / 清空单个单元格。传入空白单元格等价于清空 */
  setCell(key: unknown, raw: unknown): TimetableContent {
    const name = String(key ?? '')
    if (!CELL_KEY_PATTERN.test(name)) throw new Error('单元格坐标不合法')

    if (raw === null || raw === undefined) {
      delete this.#content.cells[name]
      this.#persist()
      return this.get()
    }

    const cell = sanitizeCell(raw)
    if (isBlankCell(cell)) delete this.#content.cells[name]
    else this.#content.cells[name] = cell

    this.#persist()
    return this.get()
  }

  /**
   * 导入课表照片。
   * 逐张处理，单张失败不影响其它——失败原因回传给界面，用户能知道哪张为什么没进来。
   */
  async addImages(paths: readonly string[]): Promise<{ content: TimetableContent; added: number; errors: string[] }> {
    const errors: string[] = []
    let added = 0

    for (const rawPath of paths) {
      const displayName = basename(String(rawPath ?? '')) || '未命名图片'
      if (this.#content.images.length >= MAX_TIMETABLE_IMAGES) {
        errors.push(`${displayName}：最多只能保留 ${MAX_TIMETABLE_IMAGES} 张课表图片`)
        continue
      }
      try {
        const source = String(rawPath)
        const raw = await readFile(source)
        const normalized = await normalizeImage(raw, displayName)

        const id = newId()
        const fileName = `${id}.${normalized.ext}`
        const target = safeJoin(this.#imagesDir, fileName)
        await writeFile(target, normalized.data, { mode: 0o600 })

        this.#content.images.push({
          id,
          fileName,
          sourceName: normalized.ext === extOf(displayName) ? displayName : `${displayName} → .${normalized.ext}`,
          addedAt: new Date().toISOString(),
          width: normalized.width,
          height: normalized.height,
          bytes: normalized.data.length
        })
        added += 1
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        errors.push(`${displayName}：${reason}`)
      }
    }

    if (added > 0) this.#persist()
    return { content: this.get(), added, errors }
  }

  removeImage(id: unknown): TimetableContent {
    const target = String(id ?? '')
    const index = this.#content.images.findIndex((image) => image.id === target)
    if (index < 0) return this.get()

    const [removed] = this.#content.images.splice(index, 1)
    this.#persist()

    // 先删记录再删文件：万一删文件失败，也只是留个孤儿文件，不会出现「记录指向不存在的文件」
    if (removed) {
      try {
        rmSync(safeJoin(this.#imagesDir, removed.fileName), { force: true })
      } catch (error) {
        console.error('[timetable] 删除课表图片失败：', error)
      }
    }
    return this.get()
  }

  /**
   * 清理「有文件但没记录」的孤儿图片。
   * 启动时跑一次，成本很低，能防止长期使用后目录里堆垃圾。
   */
  sweepOrphans(): number {
    const known = new Set(this.#content.images.map((image) => image.fileName))
    let removed = 0
    try {
      for (const entry of readdirSync(this.#imagesDir)) {
        if (entry.endsWith('.json') || entry.endsWith('.tmp') || entry.endsWith('.broken')) continue
        if (known.has(entry)) continue
        try {
          rmSync(safeJoin(this.#imagesDir, entry), { force: true })
          removed += 1
        } catch {
          /* 单个文件删不掉不影响其它 */
        }
      }
    } catch {
      /* 目录读不了就跳过，不阻塞启动 */
    }
    return removed
  }

  get filePath(): string {
    return this.#file
  }
}

/**
 * 按当前节数把「存下来的时间设置」补全成完整的行列表。
 * 节数调大时新增的行是空时间，调小时多出来的时间设置**保留在文件里**，
 * 这样用户来回调整节数不会丢已经填好的时间。
 */
export function buildRows(stored: readonly PeriodRow[], periodCount: number): PeriodRow[] {
  const byIndex = new Map<number, PeriodRow>()
  for (const row of stored) byIndex.set(row.index, row)

  const rows: PeriodRow[] = []
  for (let index = 1; index <= periodCount; index += 1) {
    const found = byIndex.get(index)
    rows.push({ index, start: found?.start ?? '', end: found?.end ?? '' })
  }
  return rows
}
