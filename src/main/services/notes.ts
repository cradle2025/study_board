import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join, parse as parsePath } from 'node:path'

import { MAX_NOTE_BYTES, MAX_NOTE_FILE_BYTES, MAX_NOTE_TITLE, NOTE_HEAD_BYTES } from '@shared/limits'
import type { NoteDoc, NoteEditorMode, NoteMeta, NoteWriteInput } from '@shared/types'

import { ensureDir, newId, safeJoin } from '../paths'
import { parseFrontmatter, scalar, stringifyFrontmatter, type Frontmatter } from './frontmatter'

/**
 * 笔记库存储。
 *
 * 核心取向：**磁盘上的 .md 文件才是本体，索引只是加速用的**。
 *
 *  - 目录结构就是 Obsidian Vault，不需要任何转换；
 *  - 用户在 Obsidian（或任何编辑器）里新增 / 改名 / 删除笔记，
 *    本应用下次 `list()` 时会自动对账把它们认出来；
 *  - `.study-board/index.json` 只存 id ↔ 文件名 的映射，丢了也能重建，
 *    重建时会**优先从文件自己的 frontmatter 里把 id 捡回来**，
 *    这样课程卡片与笔记的关联不会因为丢一个索引文件就断掉。
 *
 * 删除走「移到回收站」而不是真删：笔记是用户自己写的东西，
 * 误删一次的代价远大于目录里多占几 KB。
 */

const INDEX_VERSION = 1
const INDEX_DIR = '.study-board'
const TRASH_DIR = 'trash'
const NOTE_EXT = '.md'

/** Windows 上的保留文件名：叫这些名字的文件根本创建不出来 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

interface IndexContent {
  version: number
  notes: Record<string, NoteMeta>
}

/** 把标题洗成可以当文件名用的字符串 */
export function safeNoteTitle(raw: unknown): string {
  let title = scalar(raw)
    // 路径分隔符与 Windows 不允许的字符
    .replace(/[\\/:*?"<>|]/g, ' ')
    // 控制字符
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 结尾的点和空格在 Windows 上会被静默吃掉，干脆提前去掉
    .replace(/[. ]+$/, '')

  if (title.length > MAX_NOTE_TITLE) title = title.slice(0, MAX_NOTE_TITLE).trim()
  if (title.length === 0) title = '未命名笔记'
  if (RESERVED_NAMES.has(title.toLowerCase())) title = `_${title}`
  return title
}

/** 只读文件头部若干字节：对账时用，避免为了拿一个 id 把整篇大笔记读进来 */
function readHead(file: string, bytes: number): string {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf-8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function sameName(a: string, b: string): boolean {
  // Windows / macOS 的文件系统大小写不敏感，比较时统一折叠
  return a.toLowerCase() === b.toLowerCase()
}

function modeOf(value: unknown): NoteEditorMode {
  return value === 'richtext' ? 'richtext' : 'markdown'
}

export class NotesStore {
  #dir: string
  #indexFile: string
  #index: IndexContent

  constructor(dir: string) {
    this.#dir = ensureDir(dir)
    this.#indexFile = join(ensureDir(join(this.#dir, INDEX_DIR)), 'index.json')
    this.#index = this.#loadIndex()
  }

  get dir(): string {
    return this.#dir
  }

  #loadIndex(): IndexContent {
    if (!existsSync(this.#indexFile)) return { version: INDEX_VERSION, notes: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.#indexFile, 'utf-8')) as Partial<IndexContent>
      const notes: Record<string, NoteMeta> = {}
      if (parsed && typeof parsed === 'object' && parsed.notes && typeof parsed.notes === 'object') {
        for (const [id, raw] of Object.entries(parsed.notes)) {
          const meta = raw as Partial<NoteMeta>
          const fileName = String(meta.fileName ?? '')
          if (!id || !fileName) continue
          notes[id] = {
            id,
            title: scalar(meta.title) || parsePath(fileName).name,
            fileName,
            mode: modeOf(meta.mode),
            createdAt: String(meta.createdAt ?? '') || new Date().toISOString(),
            updatedAt: String(meta.updatedAt ?? '') || new Date().toISOString()
          }
        }
      }
      return { version: INDEX_VERSION, notes }
    } catch (error) {
      // 索引坏了不是灾难：文件名就是标题，id 还能从 frontmatter 里捡回来
      console.error('[notes] 索引文件解析失败，将从目录重建：', error)
      try {
        renameSync(this.#indexFile, `${this.#indexFile}.broken`)
      } catch {
        /* 备份失败就算了，不能让笔记库用不了 */
      }
      return { version: INDEX_VERSION, notes: {} }
    }
  }

  #persistIndex(): void {
    const tmp = `${this.#indexFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#index, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#indexFile)
  }

  /** 目录里的 .md 文件（忽略 .study-board 这类隐藏目录） */
  #scan(): string[] {
    try {
      return readdirSync(this.#dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.'))
        .filter((name) => extname(name).toLowerCase() === NOTE_EXT)
    } catch {
      return []
    }
  }

  /**
   * 与磁盘对账。
   *
   * 三种情况：
   *  - 索引里有、磁盘上也在 → 标题可能被外部改名了，跟着文件名走；
   *  - 磁盘上有、索引里没有 → 外部新建的笔记，给它分配一个 id
   *    （优先沿用 frontmatter 里已有的 id）；
   *  - 索引里有、磁盘上没了 → 外部删除的，从索引里摘掉。
   */
  #reconcile(): boolean {
    let changed = false
    const files = this.#scan()
    const byFileName = new Map<string, string>()
    for (const [id, meta] of Object.entries(this.#index.notes)) {
      byFileName.set(meta.fileName.toLowerCase(), id)
    }

    const seen = new Set<string>()

    for (const fileName of files) {
      const title = parsePath(fileName).name
      const id = byFileName.get(fileName.toLowerCase())

      if (id) {
        seen.add(id)
        const meta = this.#index.notes[id] as NoteMeta
        if (meta.fileName !== fileName) {
          // 外部改名：标题跟着走。id 不变，卡片关联不受影响
          meta.fileName = fileName
          meta.title = title
          meta.updatedAt = new Date().toISOString()
          changed = true
        }
        continue
      }

      const filePath = safeJoin(this.#dir, fileName)
      const head = readHead(filePath, NOTE_HEAD_BYTES)
      const { data } = parseFrontmatter(head)
      const claimed = scalar(data['id'])
      // 只认「格式像 uuid 且索引里没用过」的 id，防止两份笔记互相抢同一个 id
      const usable =
        /^[0-9a-fA-F-]{36}$/.test(claimed) && !(claimed in this.#index.notes)
      const newIdValue = usable ? claimed : newId()

      let createdAt = new Date().toISOString()
      try {
        createdAt = statSync(filePath).mtime.toISOString()
      } catch {
        /* 拿不到时间就用当前时间 */
      }

      this.#index.notes[newIdValue] = {
        id: newIdValue,
        title,
        fileName,
        mode: modeOf(data['mode']),
        createdAt: String(data['createdAt'] ?? '') || createdAt,
        updatedAt: createdAt
      }
      seen.add(newIdValue)
      changed = true
    }

    for (const id of Object.keys(this.#index.notes)) {
      if (!seen.has(id)) {
        delete this.#index.notes[id]
        changed = true
      }
    }

    if (changed) this.#persistIndex()
    return changed
  }

  list(): NoteMeta[] {
    this.#reconcile()
    return Object.values(this.#index.notes)
      .map((meta) => ({ ...meta }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  find(id: unknown): NoteMeta | null {
    const target = String(id ?? '')
    this.#reconcile()
    return this.#index.notes[target] ?? null
  }

  read(id: unknown): NoteDoc {
    const meta = this.find(id)
    if (!meta) throw new Error('笔记不存在')

    const filePath = safeJoin(this.#dir, meta.fileName)
    let raw = ''
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (error) {
      throw new Error(`读不到笔记文件：${error instanceof Error ? error.message : String(error)}`)
    }

    const parsed = parseFrontmatter(raw)
    // 文件被外部改过的话，模式可能也变了，跟着文件走
    const mode = modeOf(parsed.data['mode'] ?? meta.mode)
    if (mode !== meta.mode) {
      meta.mode = mode
      this.#persistIndex()
    }

    return { ...meta, content: parsed.content, frontmatter: parsed.data }
  }

  /** 生成一个不与现有文件冲突的文件名 */
  #uniqueFileName(title: string, exceptFileName?: string): string {
    const taken = new Set(
      this.#scan()
        .filter((name) => !exceptFileName || !sameName(name, exceptFileName))
        .map((name) => name.toLowerCase())
    )

    for (let n = 1; n < 500; n += 1) {
      const suffix = n === 1 ? '' : ` (${n})`
      const trimmed = title.slice(0, MAX_NOTE_TITLE - suffix.length).trim() || '未命名笔记'
      const candidate = `${trimmed}${suffix}${NOTE_EXT}`
      if (Buffer.byteLength(candidate, 'utf-8') > MAX_NOTE_FILE_BYTES) continue
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    // 极端情况下退回 uuid 文件名，至少保证能创建成功
    return `${newId()}${NOTE_EXT}`
  }

  #writeFile(fileName: string, data: Frontmatter, content: string): void {
    const payload = stringifyFrontmatter(data, content)
    if (Buffer.byteLength(payload, 'utf-8') > MAX_NOTE_BYTES) {
      throw new Error(`笔记内容过大（上限 ${Math.round(MAX_NOTE_BYTES / 1024 / 1024)}MB）`)
    }
    const filePath = safeJoin(this.#dir, fileName)
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, filePath)
  }

  create(rawTitle: string, content = ''): NoteDoc {
    const title = safeNoteTitle(rawTitle)
    const fileName = this.#uniqueFileName(title)
    const now = new Date().toISOString()
    const id = newId()

    this.#writeFile(fileName, { id, mode: 'markdown', createdAt: now }, content)

    const meta: NoteMeta = { id, title: parsePath(fileName).name, fileName, mode: 'markdown', createdAt: now, updatedAt: now }
    this.#index.notes[id] = meta
    this.#persistIndex()

    return { ...meta, content, frontmatter: { id, mode: 'markdown', createdAt: now } }
  }

  write(input: NoteWriteInput): NoteDoc {
    const current = this.find(input?.id)
    if (!current) throw new Error('笔记不存在')

    const filePath = safeJoin(this.#dir, current.fileName)
    let existing: Frontmatter = {}
    let previousContent = ''
    try {
      const parsed = parseFrontmatter(readFileSync(filePath, 'utf-8'))
      existing = parsed.data
      previousContent = parsed.content
    } catch {
      /* 文件不在了也允许写：下面会重新创建 */
    }

    const content = typeof input?.content === 'string' ? input.content : previousContent
    const mode = input?.mode ? modeOf(input.mode) : current.mode

    // 标题变了就顺手改名（保持 id 不变，卡片关联不受影响）
    let fileName = current.fileName
    if (input?.title !== undefined) {
      const nextTitle = safeNoteTitle(input.title)
      if (nextTitle !== current.title) {
        fileName = this.#uniqueFileName(nextTitle, current.fileName)
      }
    }

    const now = new Date().toISOString()
    const data: Frontmatter = {
      ...existing,
      id: current.id,
      mode,
      createdAt: current.createdAt,
      updatedAt: now
    }

    this.#writeFile(fileName, data, content)
    // 改名时把旧文件收掉，否则会在库里留一个同名不同后缀的副本
    if (!sameName(fileName, current.fileName)) {
      try {
        rmSync(safeJoin(this.#dir, current.fileName), { force: true })
      } catch {
        /* 删不掉旧的也不影响新文件可用 */
      }
    }

    const meta: NoteMeta = {
      ...current,
      title: parsePath(fileName).name,
      fileName,
      mode,
      updatedAt: now
    }
    this.#index.notes[current.id] = meta
    this.#persistIndex()

    return { ...meta, content, frontmatter: data }
  }

  rename(id: unknown, title: string): NoteDoc {
    const current = this.find(id)
    if (!current) throw new Error('笔记不存在')
    return this.write({ id: current.id, content: readContentOrEmpty(this, current.id), title })
  }

  /** 删除 = 移到笔记库里的 .study-board/trash，不真删 */
  remove(id: unknown): void {
    const meta = this.find(id)
    if (!meta) return

    const source = safeJoin(this.#dir, meta.fileName)
    try {
      const trash = ensureDir(join(this.#dir, INDEX_DIR, TRASH_DIR))
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(source, join(trash, `${stamp}__${basename(meta.fileName)}`))
    } catch (error) {
      console.error('[notes] 移入回收站失败，改为直接删除：', error)
      try {
        rmSync(source, { force: true })
      } catch {
        /* 删不掉也不该让界面崩 */
      }
    }

    delete this.#index.notes[meta.id]
    this.#persistIndex()
  }

  /**
   * 备份一篇笔记，返回备份文件的相对路径。
   *
   * 用在「切到富文本模式」这种**可能改变文件格式**的操作之前：
   * md 表达不了的东西（合并单元格、文字颜色）在互转时会退化，
   * 与其到时候跟用户说「抱歉丢了一点」，不如先把原文件留一份。
   * 备份放在 .study-board/backups 里，紧挨着笔记库，用户自己也能翻到。
   */
  backup(id: unknown): string {
    const meta = this.find(id)
    if (!meta) throw new Error('笔记不存在')

    const source = safeJoin(this.#dir, meta.fileName)
    const dir = ensureDir(join(this.#dir, INDEX_DIR, 'backups'))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${stamp}__${basename(meta.fileName)}`)
    try {
      copyFileSync(source, target)
    } catch (error) {
      throw new Error(
        `备份失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
    return `${INDEX_DIR}/backups/${basename(target)}`
  }

  /** 让设置页能创建目录，同时保证 .study-board 索引目录存在 */
  static ensureLibrary(dir: string): string {
    mkdirSync(join(dir, INDEX_DIR), { recursive: true })
    return dir
  }
}

/** rename 需要先把正文读出来再整体写回，单独抽出来是为了让异常信息更清楚 */
function readContentOrEmpty(store: NotesStore, id: string): string {
  try {
    return store.read(id).content
  } catch {
    return ''
  }
}
