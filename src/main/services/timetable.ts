import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'

import {
  DEFAULT_WEEK_COUNT,
  MAX_PERIODS,
  MAX_TIMETABLE_IMAGES,
  MAX_WEEK_COUNT,
  MIN_PERIODS
} from '@shared/limits'
import type { CourseImage, PeriodRow, TimetableCell, WeekRule } from '@shared/types'

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
  /**
   * key = "节:列"，值是**这一格上的所有课**。
   *
   * 从 v1 的单对象改成数组，是为了让「同一时间段、不同周次上不同课」
   * 能并存（单周一门、双周另一门）。形状变更由数据闸口的 v1→v2 迁移负责。
   */
  cells: Record<string, TimetableCell[]>
  /** 一学期多少周 */
  weekCount: number
  /** 当前查看第几周；0 = 不按周次过滤 */
  currentWeek: number
  images: CourseImage[]
}

function emptyContent(): TimetableContent {
  return {
    version: CONFIG_VERSION,
    rows: [],
    cells: {},
    weekCount: DEFAULT_WEEK_COUNT,
    currentWeek: 0,
    images: []
  }
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/** 只保留非空文本字段的比较——id / weeks 不参与「内容有没有变」的判断 */
type CellBody = Pick<TimetableCell, 'courseName' | 'teacher' | 'location' | 'duration' | 'remark'>

function isBlankCell(cell: CellBody): boolean {
  return (
    cell.courseName === '' &&
    cell.teacher === '' &&
    cell.location === '' &&
    cell.duration === '' &&
    cell.remark === ''
  )
}

/** 两个单元格内容是否完全一致——用来跳过「值没变却照样重写一遍文件」 */
function sameCell(left: TimetableCell | undefined, right: CellBody & { weeks: WeekRule }): boolean {
  if (!left) return false
  return (
    left.courseName === right.courseName &&
    left.teacher === right.teacher &&
    left.location === right.location &&
    left.duration === right.duration &&
    left.remark === right.remark &&
    sameWeeks(left.weeks, right.weeks)
  )
}

function sameWeeks(left: WeekRule, right: WeekRule): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'list' && right.kind === 'list') {
    if (left.weeks.length !== right.weeks.length) return false
    return left.weeks.every((week, index) => week === right.weeks[index])
  }
  return true
}

/** 两格的课程列表是否一致（按 id 对齐，顺序无关） */
function sameCellList(left: readonly TimetableCell[] | undefined, right: readonly TimetableCell[]): boolean {
  if (!left || left.length !== right.length) return false
  for (const cell of right) {
    const found = left.find((item) => item.id === cell.id)
    if (!found || !sameCell(found, cell)) return false
  }
  return true
}

/**
 * 周次规则的形状校验。
 *
 * 认不出的一律返回 null（调用方决定是丢弃还是回落到「每周」），
 * 而不是「猜一个最接近的」——把「双周」猜成「每周」会让用户在错误的
 * 周次看到课，比直接报错更难发现。
 */
function sanitizeWeekRule(raw: unknown): WeekRule | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const kind = input['kind']
  if (kind === 'all' || kind === 'odd' || kind === 'even') return { kind }
  if (kind !== 'list') return null

  const source = input['weeks']
  if (!Array.isArray(source)) return null
  const seen = new Set<number>()
  for (const item of source) {
    const week = Math.trunc(Number(item))
    if (!Number.isFinite(week) || week < 1 || week > MAX_WEEK_COUNT) continue
    seen.add(week)
  }
  if (seen.size === 0) return null
  return { kind: 'list', weeks: [...seen].sort((a, b) => a - b) }
}

function sanitizeId(value: unknown): string {
  return String(value ?? '').trim().slice(0, 64)
}

/** 周数收敛到 1–MAX_WEEK_COUNT；认不出来（含未提供）时用默认学期长度 */
function clampWeekCount(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WEEK_COUNT
  return Math.min(MAX_WEEK_COUNT, n)
}

/** 当前周次：0 表示「看全部」，其余收敛到 1–weekCount */
function clampCurrentWeek(value: unknown, weekCount: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(weekCount, n)
}

/** 写入口读到的单元格内容。`id` 可能为空串（表示新增） */
interface CellInput extends CellBody {
  id: string
  weeks: WeekRule
}

/**
 * 写入路径的读取。
 *
 * 与读取路径（`sanitizeCell`）刻意分开：**写**的时候允许没有 id
 * （那是「新增一门课」），缺 weeks 时回落到「每周」；而**读磁盘**时
 * 两者都必须存在且合法——磁盘上的数据是迁移过或程序自己写的，
 * 不该出现半截形状。
 */
function readCellInput(raw: unknown): CellInput {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    id: sanitizeId(input['id']),
    courseName: text(input['courseName'], MAX_COURSE_NAME),
    teacher: text(input['teacher'], MAX_TEACHER),
    location: text(input['location'], MAX_LOCATION),
    duration: text(input['duration'], MAX_DURATION),
    remark: text(input['remark'], MAX_REMARK),
    weeks: sanitizeWeekRule(input['weeks']) ?? { kind: 'all' }
  }
}

function sameRows(left: readonly PeriodRow[], right: readonly PeriodRow[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (!a || !b || a.index !== b.index || a.start !== b.start || a.end !== b.end) return false
  }
  return true
}

/**
 * 读磁盘路径的单元格校验。
 *
 * **没有 `id` 或 `weeks` 非法一律丢弃**：id 是所有「按 id 增删改」
 * 操作的依据，缺了它这门课就没法单独编辑或删除；weeks 认不出来则
 * 意味着我们不知道该在哪几周显示它。两种情况都宁可不显示，
 * 也不要凭空猜一个形状——猜错会让用户在错误的周次看到课。
 */
function sanitizeCell(raw: unknown): TimetableCell | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = sanitizeId(input['id'])
  if (id === '') return null
  const weeks = sanitizeWeekRule(input['weeks'])
  if (!weeks) return null
  return {
    id,
    courseName: text(input['courseName'], MAX_COURSE_NAME),
    teacher: text(input['teacher'], MAX_TEACHER),
    location: text(input['location'], MAX_LOCATION),
    duration: text(input['duration'], MAX_DURATION),
    remark: text(input['remark'], MAX_REMARK),
    weeks
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
      if (!CELL_KEY_PATTERN.test(key)) continue
      // v1 的「一个对象」形状在这里**被拒绝**：迁移没跑到的数据不该被
      // 悄悄当成一门课读进来，否则会掩盖「闸口没生效」这个真问题
      if (!Array.isArray(value)) continue
      const list: TimetableCell[] = []
      for (const item of value) {
        const cell = sanitizeCell(item)
        if (!cell || isBlankCell(cell)) continue
        list.push(cell)
      }
      if (list.length > 0) result.cells[key] = list
    }
  }

  result.weekCount = clampWeekCount(input['weekCount'])
  result.currentWeek = clampCurrentWeek(input['currentWeek'], result.weekCount)

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

  /**
   * 只读快照（深拷贝，避免调用方改到内部状态）。
   *
   * 这是**唯一**做深拷贝的地方：所有写方法都返回 void，
   * 一次写操作只在这里克隆一次，不再像以前那样
   * 「写方法克隆一份、组装响应时又克隆一份」。
   */
  get(): TimetableContent {
    return structuredClone(this.#content)
  }

  /** 每节的时间设置。只有非空的时间才会被保留，避免存一堆空行 */
  setRows(raw: unknown): void {
    if (!Array.isArray(raw)) throw new Error('rows 必须是数组')
    const rows: PeriodRow[] = []
    for (const item of raw) {
      const row = sanitizeRow(item)
      if (!row) continue
      if (row.start === '' && row.end === '') continue
      rows.push(row)
    }
    if (sameRows(this.#content.rows, rows)) return
    this.#content.rows = rows
    this.#persist()
  }

  /**
   * 写入一格里的**一门课**。
   *
   * - 带 `id` 且这一格里有同 id 的课 → 替换那一门（其它课不动）
   * - 带 `id` 但这一格里没有 → 当作新增
   * - 不带 `id` → 追加一门
   * - 传 null → 清空整格
   * - 内容全空 → 有 id 则删掉那一门（编辑器里把字段清空再保存的语义）
   *
   * 「其它课不动」是这套接口存在的全部意义：早先「整格覆盖」的写法
   * 会让编辑一门课把同格其它周次的课静默删掉。
   */
  setCell(key: unknown, raw: unknown): void {
    const name = String(key ?? '')
    if (!CELL_KEY_PATTERN.test(name)) throw new Error('单元格坐标不合法')

    if (raw === null || raw === undefined) {
      if (!(name in this.#content.cells)) return
      delete this.#content.cells[name]
      this.#persist()
      return
    }

    const input = readCellInput(raw)
    const list = this.#content.cells[name] ?? []

    if (isBlankCell(input)) {
      if (input.id === '') return
      const index = list.findIndex((cell) => cell.id === input.id)
      if (index < 0) return
      list.splice(index, 1)
      if (list.length === 0) delete this.#content.cells[name]
      else this.#content.cells[name] = list
      this.#persist()
      return
    }

    const index = input.id === '' ? -1 : list.findIndex((cell) => cell.id === input.id)
    if (index >= 0) {
      if (sameCell(list[index], input)) return
      list[index] = { ...input }
    } else {
      list.push({ ...input, id: input.id || newId() })
    }
    this.#content.cells[name] = list
    this.#persist()
  }

  /** 按 id 删掉一格里的某一门课，同格其它课不受影响 */
  removeCell(key: unknown, id: unknown): void {
    const name = String(key ?? '')
    if (!CELL_KEY_PATTERN.test(name)) throw new Error('单元格坐标不合法')
    const target = sanitizeId(id)
    if (target === '') throw new Error('缺少课程 id')

    const list = this.#content.cells[name]
    if (!list) return
    const index = list.findIndex((cell) => cell.id === target)
    if (index < 0) return

    list.splice(index, 1)
    if (list.length === 0) delete this.#content.cells[name]
    this.#persist()
  }

  /**
   * 批量写入多个格子。
   *
   * 一次调用只 `#persist()` 一次 —— 逐格调用 `setCell` 会让 N 个格子
   * 变成 N 次整份 JSON 重写，中途失败还会留下写了一半的结果。
   * 值是**整格的完整课程列表**：空数组等价于清空该格。
   */
  setCells(entries: unknown): void {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('cells 必须是对象')
    }

    let changed = false
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!CELL_KEY_PATTERN.test(key)) throw new Error('单元格坐标不合法')
      if (!Array.isArray(value)) throw new Error('每个格子必须是课程数组')

      const list: TimetableCell[] = []
      for (const item of value) {
        const input = readCellInput(item)
        if (isBlankCell(input)) continue
        list.push({ ...input, id: input.id || newId() })
      }

      if (list.length === 0) {
        if (key in this.#content.cells) {
          delete this.#content.cells[key]
          changed = true
        }
        continue
      }
      if (sameCellList(this.#content.cells[key], list)) continue
      this.#content.cells[key] = list
      changed = true
    }

    if (changed) this.#persist()
  }

  /** 学期周数与当前查看周次。周数缩小时当前周次跟着收敛，避免停在不存在的周 */
  setWeekSettings(input: { weekCount?: unknown; currentWeek?: unknown }): void {
    let changed = false

    if (input.weekCount !== undefined) {
      const next = clampWeekCount(input.weekCount)
      if (next !== this.#content.weekCount) {
        this.#content.weekCount = next
        changed = true
      }
    }

    if (input.currentWeek !== undefined) {
      const next = clampCurrentWeek(input.currentWeek, this.#content.weekCount)
      if (next !== this.#content.currentWeek) {
        this.#content.currentWeek = next
        changed = true
      }
    } else if (this.#content.currentWeek > this.#content.weekCount) {
      // 只改了周数：原本停在第 20 周，学期缩到 16 周后不该还显示第 20 周
      this.#content.currentWeek = this.#content.weekCount
      changed = true
    }

    if (changed) this.#persist()
  }

  /**
   * 导入课表照片。
   * 逐张处理，单张失败不影响其它——失败原因回传给界面，用户能知道哪张为什么没进来。
   */
  async addImages(paths: readonly string[]): Promise<{ added: number; errors: string[] }> {
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
    return { added, errors }
  }

  removeImage(id: unknown): void {
    const target = String(id ?? '')
    const index = this.#content.images.findIndex((image) => image.id === target)
    if (index < 0) return

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
