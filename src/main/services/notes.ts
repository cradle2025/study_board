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

import {
  MAX_GROUP_DEPTH,
  MAX_GROUP_NAME,
  MAX_NOTE_BYTES,
  MAX_NOTE_FILE_BYTES,
  MAX_NOTE_GROUPS,
  MAX_NOTE_TITLE,
  NOTE_HEAD_BYTES
} from '@shared/limits'
import type { NoteDoc, NoteEditorMode, NoteGroup, NoteMeta, NoteWriteInput } from '@shared/types'

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
/** 笔记正文的扩展名。文件监听要靠它把「笔记」和别的杂项文件分开 */
export const NOTE_EXT = '.md'

/**
 * 写入指纹的保留量。
 *
 * 自动保存每 800ms 落一次盘，指纹表会一直长；超过这个量就把老的清掉。
 * 清早了也不会出错——只是那条写入可能被当成外部改动，多刷一次界面而已。
 */
const MAX_WRITE_MARKS = 64

/** 指纹的存活时间：这么久都没再用上就可以扔了 */
const WRITE_MARK_TTL = 30_000

/** 只认形状像 uuid 的 id：随手写的 `id: 1` 不该被当成一篇笔记的身份 */
function isNoteId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value)
}

/**
 * 一次对账发现的变化。
 *
 * 三组之间**互不重叠**：同一个 id 不会既出现在 added 又出现在 removed 里。
 * 这个不变式由对账自己保证，而不是指望调用方去重——调用方很容易只处理
 * removed 那半边，于是把卡片关联白白解掉一轮。
 */
export interface NotesReconcileDiff {
  /** 磁盘上新出现、索引里没有的笔记 */
  added: NoteMeta[]
  /** id 不变、文件名变了的笔记（外部改名） */
  renamed: NoteMeta[]
  /** 索引里有、磁盘上没了，且没有以别的文件名重新出现 */
  removed: Array<{ id: string; fileName: string }>
}

function emptyDiff(): NotesReconcileDiff {
  return { added: [], renamed: [], removed: [] }
}

/** Windows 上的保留文件名：叫这些名字的文件根本创建不出来 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

interface IndexContent {
  version: number
  notes: Record<string, NoteMeta>
  /**
   * 分组树。**平铺存放**，父子关系靠 `parentId` 表达。
   *
   * 不用嵌套结构存，是因为增删改的代价差太多：嵌套存法下
   * 「把一个分组挪到另一处」要先把整棵子树摘下来再插进去，
   * 而平铺存法只是改一个 `parentId`，不可能写出「子树丢了一半」这种 bug。
   * 树在渲染时才拼——反正那本来就要递归一次。
   */
  groups: NoteGroup[]
}

/** 分组名清洗：去空白、限长。空名不允许（用户没法指着它说话） */
function safeGroupName(raw: unknown): string {
  const name = scalar(raw).replace(/\s+/g, ' ').trim()
  if (name.length > MAX_GROUP_NAME) return name.slice(0, MAX_GROUP_NAME).trim()
  return name
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
    // 开头的点和空格也必须剥掉：#scan 会把 . 开头的文件当隐藏文件忽略
    // （.study-board / .obsidian 这类），一旦写出 . 开头的文件名，
    // 下一次对账就会把它当成「被外部删除」把索引摘掉——笔记明明还在磁盘上，
    // 界面里却凭空消失。「能写出来的文件名」和「能扫回来的文件名」必须是一组集合
    .replace(/^[. ]+/, '')

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
  /**
   * 「这个文件是我们自己刚写的」——按文件名记下写入后的 size + mtime。
   *
   * 文件监听会把我们自己写盘的动静也报上来。不过滤的话，自动保存每 800ms
   * 写一次，用户每打一个字编辑器就会被重载一次，完全没法用。
   *
   * 为什么按指纹记而不是「多少毫秒内写的一律忽略」：时间窗是个猜出来的数，
   * 短了会漏、长了会把用户紧接着做的外部修改也一起吃掉。指纹是确定的——
   * 写完立刻 stat 一次，之后文件再被人动过，size 或 mtime 必有一个变。
   */
  #written = new Map<string, { size: number; mtimeMs: number; at: number }>()

  constructor(dir: string) {
    this.#dir = ensureDir(dir)
    this.#indexFile = join(ensureDir(join(this.#dir, INDEX_DIR)), 'index.json')
    this.#index = this.#loadIndex()
  }

  get dir(): string {
    return this.#dir
  }

  #loadIndex(): IndexContent {
    if (!existsSync(this.#indexFile)) return { version: INDEX_VERSION, notes: {}, groups: [] }
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
            updatedAt: String(meta.updatedAt ?? '') || new Date().toISOString(),
            groupId: String(meta.groupId ?? '').slice(0, 64)
          }
        }
      }

      /**
       * 分组要**逐条验**，不能照单全收。
       *
       * 索引是用户可以手改的（它就是个 JSON），也可能被半个版本的旧程序写过。
       * 一条 `parentId` 指向不存在的分组、或者自己指向自己的记录，
       * 会让下面拼树的递归直接转不出来——那是启动即挂，比丢几个分组严重得多。
       * 所以这里把不合法的关系一律**降级成顶层**，而不是拒绝整个索引：
       * 用户的笔记还在，分组顶多乱一点，还能自己拖回去。
       */
      const groups: NoteGroup[] = []
      const seenIds = new Set<string>()
      if (Array.isArray(parsed.groups)) {
        for (const raw of parsed.groups) {
          if (groups.length >= MAX_NOTE_GROUPS) break
          const entry = (raw ?? {}) as Partial<NoteGroup>
          const id = String(entry.id ?? '').trim()
          const name = safeGroupName(entry.name)
          if (!id || !name || seenIds.has(id)) continue
          seenIds.add(id)
          groups.push({ id: id.slice(0, 64), name, parentId: String(entry.parentId ?? '').slice(0, 64) })
        }
      }
      // 第二遍：父节点不存在、或自引用的，拉平到顶层
      for (const group of groups) {
        if (group.parentId && (group.parentId === group.id || !seenIds.has(group.parentId))) {
          group.parentId = ''
        }
      }
      // 第三遍：断链（A→B→C 里 B 被删掉的情况）也拉平。
      // 走一遍「沿 parentId 往上数」来判断，顺手把过深的层级也削平
      for (const group of groups) {
        let cursor = group.parentId
        let depth = 0
        while (cursor && depth <= MAX_NOTE_GROUPS) {
          const parent: NoteGroup | undefined = groups.find((item) => item.id === cursor)
          if (!parent) {
            group.parentId = ''
            break
          }
          depth += 1
          if (depth >= MAX_GROUP_DEPTH) {
            group.parentId = ''
            break
          }
          cursor = parent.parentId
        }
      }

      return { version: INDEX_VERSION, notes, groups }
    } catch (error) {
      // 索引坏了不是灾难：文件名就是标题，id 还能从 frontmatter 里捡回来。
      // 分组会一起丢——它是纯结构信息，没有第二处可以还原。
      console.error('[notes] 索引文件解析失败，将从目录重建：', error)
      try {
        renameSync(this.#indexFile, `${this.#indexFile}.broken`)
      } catch {
        /* 备份失败就算了，不能让笔记库用不了 */
      }
      return { version: INDEX_VERSION, notes: {}, groups: [] }
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
   * 与磁盘对账，**并把差异报出来**。
   *
   * 三种情况：
   *  - 索引里有、磁盘上也在 → 标题可能被外部改名了，跟着文件名走；
   *  - 磁盘上有、索引里没有 → 外部新建的笔记，给它分配一个 id
   *    （优先沿用 frontmatter 里已有的 id）；
   *  - 索引里有、磁盘上没了 → 外部删除的，从索引里摘掉。
   *
   * 返回值要给文件监听拿去广播事件，所以这里必须把两件容易搞错的事做对：
   *
   *  1. **外部改名不是「删一篇 + 加一篇」**。我们的文件里写着 id，改名之后
   *     frontmatter 还在，所以能把 id 认回来。只有认回来，
   *     用户在 Obsidian 里改个文件名才不会把课程卡片与笔记的关联弄断。
   *  2. **同一个 id 不能既报 removed 又报 added**。否则调用方会先解开卡片关联、
   *     再重新关联，白折腾一轮；更糟的是调用方很容易只处理其中一边。
   */
  reconcile(): NotesReconcileDiff {
    const diff = emptyDiff()
    let changed = false
    const files = this.#scan()
    const onDisk = new Set(files.map((name) => name.toLowerCase()))

    const byFileName = new Map<string, string>()
    for (const [id, meta] of Object.entries(this.#index.notes)) {
      byFileName.set(meta.fileName.toLowerCase(), id)
    }

    const seen = new Set<string>()

    for (const fileName of files) {
      const title = parsePath(fileName).name
      const knownId = byFileName.get(fileName.toLowerCase())

      if (knownId) {
        seen.add(knownId)
        const meta = this.#index.notes[knownId]
        // 文件名只有大小写变了。Windows / macOS 的编辑器干得出这种事，
        // 而文件系统本身不区分大小写，不专门看一眼就会被漏掉
        if (meta && meta.fileName !== fileName) {
          meta.fileName = fileName
          meta.title = title
          meta.updatedAt = new Date().toISOString()
          diff.renamed.push({ ...meta })
          changed = true
        }
        continue
      }

      const filePath = safeJoin(this.#dir, fileName)
      const head = readHead(filePath, NOTE_HEAD_BYTES)
      const { data } = parseFrontmatter(head)
      const claimed = scalar(data['id'])
      const existing = isNoteId(claimed) ? this.#index.notes[claimed] : undefined

      // 认得出 id、而它原来那个文件名已经不在硬盘上了 → 这是**外部改名**。
      // 「旧文件还在不在」这一条不能省：同一个 id 的两份文件同时存在
      // （用户复制了一份）会让它们来回抢同一个 id，每次对账都翻一次面
      if (existing && !onDisk.has(existing.fileName.toLowerCase())) {
        existing.fileName = fileName
        existing.title = title
        existing.updatedAt = new Date().toISOString()
        seen.add(existing.id)
        diff.renamed.push({ ...existing })
        changed = true
        continue
      }

      // 全新的一篇。只认「格式像 uuid 且索引里没用过」的 id，
      // 防止两份笔记互相抢同一个 id
      const usable = isNoteId(claimed) && !(claimed in this.#index.notes)
      const id = usable ? claimed : newId()

      let createdAt = new Date().toISOString()
      try {
        createdAt = statSync(filePath).mtime.toISOString()
      } catch {
        /* 拿不到时间就用当前时间 */
      }

      const meta: NoteMeta = {
        id,
        title,
        fileName,
        mode: modeOf(data['mode']),
        createdAt: String(data['createdAt'] ?? '') || createdAt,
        updatedAt: createdAt,
        // 外部新建的笔记默认未分组。分组是应用内的结构，
        // 别人在 Obsidian 里新建的文件不可能知道自己该进哪一组
        groupId: ''
      }
      this.#index.notes[id] = meta
      seen.add(id)
      diff.added.push({ ...meta })
      changed = true
    }

    for (const [id, meta] of Object.entries(this.#index.notes)) {
      if (seen.has(id)) continue
      diff.removed.push({ id, fileName: meta.fileName })
      delete this.#index.notes[id]
      changed = true
    }

    if (changed) this.#persistIndex()
    return diff
  }

  list(): NoteMeta[] {
    this.reconcile()
    return Object.values(this.#index.notes)
      .map((meta) => ({ ...meta }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  find(id: unknown): NoteMeta | null {
    const target = String(id ?? '')
    this.reconcile()
    return this.#index.notes[target] ?? null
  }

  /* -------------------------------------------------------------- 分组 */

  /**
   * 全部分组，按「树里的顺序」返回：父在前、子紧随其后。
   *
   * 为什么在这里就排好，而不是让渲染层自己拼树：**排序规则只该有一份**。
   * 侧栏要按这个顺序画，将来若要导出目录结构、或做「上一个/下一个分组」
   * 这类导航，都得用同一个顺序，各排一次必然出现「侧栏的顺序和导出对不上」。
   */
  listGroups(): NoteGroup[] {
    const out: NoteGroup[] = []
    const children = new Map<string, NoteGroup[]>()
    for (const group of this.#index.groups) {
      const bucket = children.get(group.parentId)
      if (bucket) bucket.push(group)
      else children.set(group.parentId, [group])
    }
    for (const bucket of children.values()) {
      bucket.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }

    const walk = (parentId: string, depth: number): void => {
      if (depth > MAX_GROUP_DEPTH) return
      for (const group of children.get(parentId) ?? []) {
        out.push({ ...group })
        walk(group.id, depth + 1)
      }
    }
    walk('', 1)
    return out
  }

  /** 某个分组在树里的深度（顶层 = 1）。不存在返回 0 */
  #depthOf(id: string): number {
    let cursor = this.#index.groups.find((group) => group.id === id)?.parentId ?? ''
    let depth = 1
    // 上限就是分组总数：真出现环也会停下来，不会把主进程转死
    for (let guard = 0; cursor && guard <= this.#index.groups.length; guard += 1) {
      const parent = this.#index.groups.find((group) => group.id === cursor)
      if (!parent) break
      depth += 1
      cursor = parent.parentId
    }
    return depth
  }

  #groupExists(id: unknown): boolean {
    const target = String(id ?? '')
    return target.length > 0 && this.#index.groups.some((group) => group.id === target)
  }

  /** 某个分组的整棵子树（含自己）的 id 集合。移动时用来防环 */
  #subtreeIds(id: string): Set<string> {
    const found = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const group of this.#index.groups) {
        if (!found.has(group.id) && found.has(group.parentId)) {
          found.add(group.id)
          grew = true
        }
      }
    }
    return found
  }

  createGroup(rawName: string, rawParentId = ''): NoteGroup[] {
    const name = safeGroupName(rawName)
    if (name.length === 0) throw new Error('分组名不能为空')
    if (this.#index.groups.length >= MAX_NOTE_GROUPS) {
      throw new Error(`分组最多 ${MAX_NOTE_GROUPS} 个`)
    }
    const parentId = this.#groupExists(rawParentId) ? String(rawParentId) : ''
    // 新分组挂在父节点下面，所以它的深度是父深度 + 1
    const depth = parentId ? this.#depthOf(parentId) + 1 : 1
    if (depth > MAX_GROUP_DEPTH) {
      throw new Error(`分组最多嵌套 ${MAX_GROUP_DEPTH} 层`)
    }

    this.#index.groups.push({ id: newId(), name, parentId })
    this.#persistIndex()
    return this.listGroups()
  }

  renameGroup(id: unknown, rawName: string): NoteGroup[] {
    const group = this.#index.groups.find((item) => item.id === String(id ?? ''))
    if (!group) throw new Error('分组不存在')
    const name = safeGroupName(rawName)
    if (name.length === 0) throw new Error('分组名不能为空')
    group.name = name
    this.#persistIndex()
    return this.listGroups()
  }

  /**
   * 把一个分组挪到另一个分组下面（`parentId` 传空串 = 挪到顶层）。
   *
   * 这里必须防环：把 A 挪进 A 的子孙里，树就断了——
   * `listGroups` 从根往下走，那一段会整片消失（笔记还在，但从侧栏里找不到了）。
   * 用户完全看不出发生了什么，只会觉得「我的笔记没了」。
   */
  moveGroup(id: unknown, rawParentId: unknown): NoteGroup[] {
    const target = String(id ?? '')
    const group = this.#index.groups.find((item) => item.id === target)
    if (!group) throw new Error('分组不存在')
    const parentId = this.#groupExists(rawParentId) ? String(rawParentId) : ''

    if (parentId) {
      if (parentId === target) throw new Error('不能把分组挪到自己里面')
      if (this.#subtreeIds(target).has(parentId)) {
        throw new Error('不能把分组挪进它自己的子分组里')
      }
    }

    // 挪完之后的深度 = 新父的深度 + 子树高度。只算「自己这一层」是不够的：
    // 把一个两层的小树挂到第 3 层，实际会到第 5 层，超限的是最深的那个孙子
    const height = this.#subtreeHeight(target)
    const base = parentId ? this.#depthOf(parentId) : 0
    if (base + height > MAX_GROUP_DEPTH) {
      throw new Error(`分组最多嵌套 ${MAX_GROUP_DEPTH} 层`)
    }

    group.parentId = parentId
    this.#persistIndex()
    return this.listGroups()
  }

  /** 以某个分组为根的子树高度（自己算 1 层） */
  #subtreeHeight(id: string): number {
    const childrenOf = (parentId: string): NoteGroup[] =>
      this.#index.groups.filter((group) => group.parentId === parentId)
    const walk = (parentId: string, depth: number): number => {
      const kids = childrenOf(parentId)
      if (kids.length === 0) return depth
      return Math.max(...kids.map((kid) => walk(kid.id, depth + 1)))
    }
    return walk(id, 1)
  }

  /**
   * 删除分组。
   *
   * **不删笔记**，也不删子分组——它们统统上移到被删分组的父级。
   * 「删掉一个分组」在用户心里的意思是「这个筐我不要了」，
   * 而不是「把筐里的东西一起扔了」。真要删笔记，那是笔记自己的删除按钮的事。
   *
   * 返回受影响的两份数据，调用方（IPC 层）拿去广播。
   */
  removeGroup(id: unknown): { groups: NoteGroup[]; notes: NoteMeta[] } {
    const target = String(id ?? '')
    const group = this.#index.groups.find((item) => item.id === target)
    if (!group) throw new Error('分组不存在')

    const parentId = group.parentId
    // 直接子分组升一级
    for (const child of this.#index.groups) {
      if (child.parentId === target) child.parentId = parentId
    }
    // 组里的笔记也升一级
    for (const meta of Object.values(this.#index.notes)) {
      if (meta.groupId === target) meta.groupId = parentId
    }
    this.#index.groups = this.#index.groups.filter((item) => item.id !== target)
    this.#persistIndex()

    return { groups: this.listGroups(), notes: this.list() }
  }

  /** 把一篇笔记放进某个分组（空串 = 移出分组） */
  setNoteGroup(id: unknown, rawGroupId: unknown): NoteMeta[] {
    const meta = this.#index.notes[String(id ?? '')]
    if (!meta) throw new Error('笔记不存在')
    const groupId = this.#groupExists(rawGroupId) ? String(rawGroupId) : ''
    if (meta.groupId === groupId) return this.list()
    meta.groupId = groupId
    this.#persistIndex()
    return this.list()
  }

  /** 按文件名找笔记。文件监听给的是路径，不是 id */
  #metaByFileName(fileName: string): NoteMeta | null {
    const key = fileName.toLowerCase()
    for (const meta of Object.values(this.#index.notes)) {
      if (meta.fileName.toLowerCase() === key) return meta
    }
    return null
  }

  /**
   * 外部改动之后把时间戳跟上去。
   *
   * 列表是按 updatedAt 排的。用户在 Obsidian 里改完笔记切回来，
   * 如果这篇还排在老位置、日期还是上周的，会让人以为压根没同步。
   *
   * 时间取文件的 mtime 而不是「现在」：mtime 才是这次改动真正发生的时间，
   * 而且它跟我们自己写盘时的 updatedAt 落在同一个刻度上（都是那一次写入的时刻）。
   */
  touch(fileName: string): NoteMeta | null {
    const meta = this.#metaByFileName(fileName)
    if (!meta) return null

    try {
      meta.updatedAt = statSync(safeJoin(this.#dir, fileName)).mtime.toISOString()
    } catch {
      meta.updatedAt = new Date().toISOString()
    }
    this.#persistIndex()
    return { ...meta }
  }

  /**
   * 记下「这个文件是我们自己刚写的」。
   *
   * 写完立刻 stat 一次取指纹。这一步必须紧跟在写之后：中间被别人插一脚，
   * 指纹就记成别人的了，后果是我们会把那次外部改动当成自己的动静忽略掉。
   */
  #remember(fileName: string): void {
    const key = fileName.toLowerCase()
    try {
      const stat = statSync(safeJoin(this.#dir, fileName))
      this.#written.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, at: Date.now() })
    } catch {
      this.#written.delete(key)
      return
    }

    if (this.#written.size > MAX_WRITE_MARKS) {
      const cutoff = Date.now() - WRITE_MARK_TTL
      for (const [name, mark] of this.#written) {
        if (mark.at < cutoff) this.#written.delete(name)
      }
    }
  }

  /** 磁盘上的这个文件是不是我们自己刚写的 */
  isSelfWrite(fileName: string): boolean {
    const mark = this.#written.get(fileName.toLowerCase())
    if (!mark) return false
    try {
      const stat = statSync(safeJoin(this.#dir, fileName))
      return stat.size === mark.size && stat.mtimeMs === mark.mtimeMs
    } catch {
      // 文件已经不在（例如刚刚被自己收进回收站）→ 不算「自己写的」
      return false
    }
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
    // 紧跟着记指纹：文件监听马上就会为这次写入报事件，得认得出来是自己干的
    this.#remember(fileName)
  }

  create(rawTitle: string, content = '', rawGroupId = ''): NoteDoc {
    const title = safeNoteTitle(rawTitle)
    const fileName = this.#uniqueFileName(title)
    const now = new Date().toISOString()
    const id = newId()
    // 分组必须真实存在，否则当作未分组——不然会写进一个永远显示不出来的归属
    const groupId = this.#groupExists(rawGroupId) ? String(rawGroupId) : ''

    this.#writeFile(fileName, { id, mode: 'markdown', createdAt: now }, content)

    const meta: NoteMeta = {
      id,
      title: parsePath(fileName).name,
      fileName,
      mode: 'markdown',
      createdAt: now,
      updatedAt: now,
      groupId
    }
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
      // 额外键放在展开之后：调用方（目前是 Notion 同步）明确要写的值优先，
      // 否则写回一个已存在的 notionId 会被文件里的旧值盖掉
      ...(input?.extra ?? {}),
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
    // 指纹跟着一起清掉。留着的话，下次真有同名文件出现时，
    // 万一 size 与 mtime 又恰好撞上，那次外部改动就会被我们当成自己的动静放过
    this.#written.delete(meta.fileName.toLowerCase())
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
