import { existsSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

import { watch, type FSWatcher } from 'chokidar'

import type { NoteMeta } from '@shared/types'

import { NOTE_EXT, type NotesStore } from './notes'

/**
 * 笔记库文件监听：把「别的程序动了库里的文件」变成一组语义事件。
 *
 * 「这个目录可以直接当 Obsidian 库用」这句话还差最后一段——光能读还不够，
 * 用户在 Obsidian / VS Code 里写完切回来，界面得自己跟上。
 *
 * 四件容易做错的事，各自在下面有一个明确的处理：
 *
 *  1. **自己写的不能当成外面的改动**。自动保存每 800ms 写一次盘，
 *     不过滤的话用户每打一个字编辑器就会被重载一次。过滤交给
 *     NotesStore 的写入指纹（isSelfWrite）——它比时间窗可靠。
 *  2. **一次保存往往报上来好几个事件**。写文件、改权限、改 mtime 各算一次，
 *     还可能因为编辑器「先删再建」而多出一次删除。防抖合成一批再统一对账。
 *  3. **半截文件**。别人可能正写到一半，这时读到的是残缺内容。
 *     awaitWriteFinish 等文件大小稳定下来再报。
 *  4. **删除不能看一眼就上报**。见下面 CONFIRM_DELETE_MS 的注释。
 */

/** 收到事件后等一小会儿，把同一次保存引起的一串事件合成一批 */
const DEBOUNCE_MS = 120

/**
 * 第一次发现文件不见了之后，隔这么久再看一眼才确认是删除。
 *
 * 有些编辑器保存文件是「先把原文件删掉，再写一个新的」。中间那一小段真空期
 * 如果被当成删除，指向这篇笔记的课程卡片就会被解开关联——等文件回来时
 * id 虽然还能从 frontmatter 里认回来，关联却回不来了。
 * 代价是真删除晚一秒才反映到界面上，对一个「跟随外部改动」的功能完全无感，
 * 而查错一次的成本是用户丢一个关联。
 */
const CONFIRM_DELETE_MS = 800

export type NotesSyncEvent =
  | { kind: 'add'; note: NoteMeta }
  | { kind: 'change'; note: NoteMeta }
  | { kind: 'unlink'; id: string; fileName: string }

/**
 * 监听器只管「磁盘上发生了什么」，不碰存储、也不碰别的模块。
 * 要不要解开卡片关联、要不要推事件给界面，由调用方决定——
 * 那两件事需要同时看到笔记与卡片两个存储，不适合塞在这里。
 */
export class NotesSync {
  #store: NotesStore
  #onEvent: (event: NotesSyncEvent) => void
  #root: string
  #watcher: FSWatcher | null = null
  /** 攒着等对账的文件名（已经过滤成「库根目录下的 .md」） */
  #pending = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  /** 见过一次、还没确认的删除。key 是文件名小写 */
  #unconfirmed = new Map<string, { id: string; fileName: string }>()
  #confirmTimer: ReturnType<typeof setTimeout> | null = null

  constructor(store: NotesStore, onEvent: (event: NotesSyncEvent) => void) {
    this.#store = store
    this.#onEvent = onEvent
    this.#root = resolve(store.dir)
  }

  get dir(): string {
    return this.#root
  }

  start(): void {
    if (this.#watcher) return
    try {
      const watcher = watch(this.#root, {
        ignoreInitial: true,
        // 编辑器「先删再建」式的保存别被拆成两个事件报上来
        atomic: true,
        ignored: (path: string) => this.#ignored(path),
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 40 }
      })
      watcher.on('all', (event: string, path: string) => this.#onRaw(event, path))
      watcher.on('error', (error: unknown) => {
        console.error('[notes] 文件监听出错：', error)
      })
      this.#watcher = watcher
    } catch (error) {
      // 监听起不来不该让应用也用不了：笔记照常读写，只是不会自动跟随外部改动
      console.error('[notes] 文件监听启动失败，笔记库将不会自动跟随外部改动：', error)
    }
  }

  stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#confirmTimer) {
      clearTimeout(this.#confirmTimer)
      this.#confirmTimer = null
    }
    this.#pending.clear()
    this.#unconfirmed.clear()
    const watcher = this.#watcher
    this.#watcher = null
    if (watcher) void watcher.close().catch(() => undefined)
  }

  /**
   * 隐藏文件与隐藏目录不看。
   *
   * `.study-board` 里装着索引、备份和回收站——备份与回收站里都是 `.md`，
   * 一旦被当成笔记认出来，用户会在列表里看到一堆 `2026-09-11T…__xxx.md`。
   */
  #ignored(path: string): boolean {
    const abs = resolve(path)
    if (abs === this.#root) return false
    return basename(abs).startsWith('.')
  }

  /**
   * 只认「笔记库根目录下的 .md」。子目录里的一律不管——
   * 笔记库是平的（与 #scan 的口径一致），不这么收着会看进来一堆无关文件。
   */
  #relative(file: string): string | null {
    const abs = resolve(file)
    const rel = relative(this.#root, abs)
    if (!rel || rel.startsWith('..')) return null
    if (rel.includes(sep) || rel.includes('/') || rel.includes('\\')) return null
    if (rel.startsWith('.')) return null
    if (extname(rel).toLowerCase() !== NOTE_EXT) return null
    return rel
  }

  /**
   * 文件系统事件的原始入口。
   *
   * 刻意**不按事件类型分流**（change 就当成改内容、unlink 就当成删除）：
   * 事件类型只在「一次保存被拆成好几个事件」这种时候才需要区分，
   * 而已知文件到底怎么了，重新扫一遍目录比对是最不容易错的办法。
   */
  #onRaw(event: string, path: string): void {
    if (!this.#watcher) return
    if (event === 'addDir' || event === 'unlinkDir') return
    const fileName = this.#relative(path)
    if (!fileName) return
    this.#pending.add(fileName)
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#flush()
    }, DEBOUNCE_MS)
  }

  /**
   * 待确认的删除到点了：文件确实还没回来，才算删除。
   *
   * 这一步必须**直接看文件在不在**，不能再看一次对账结果——第一次对账
   * 已经把那条索引删掉了，第二次对账根本不会再报它一遍，
   * 于是「等一会儿再看一眼」会永远等不到确认，删除反而丢了。
   */
  #settleDeletes(): void {
    for (const [key, gone] of [...this.#unconfirmed]) {
      this.#unconfirmed.delete(key)
      if (existsSync(join(this.#root, gone.fileName))) {
        // 文件回来了：是保存的中间态。它自己带来的事件会让界面正常刷新
        continue
      }
      this.#onEvent({ kind: 'unlink', id: gone.id, fileName: gone.fileName })
    }
  }

  /** `confirming` 表示这一趟是「回来看一眼删除」的确认趟 */
  #flush(confirming = false): void {
    const files = [...this.#pending]
    this.#pending.clear()

    if (confirming) this.#settleDeletes()

    // 上一轮挂着的待确认删除也要走一遍，所以不能只看 pending
    if (files.length === 0 && this.#unconfirmed.size === 0) return

    let diff
    try {
      diff = this.#store.reconcile()
    } catch (error) {
      console.error('[notes] 对账失败：', error)
      return
    }

    // 上一趟以为删掉了、其实只是编辑器保存的中间态：文件回来了就撤销这次删除。
    // 同一个 id 又被认回来就说明是同一篇——id 写在 frontmatter 里，
    // 改名也认得回来，所以比文件名可靠
    const reappeared = new Set([...diff.added, ...diff.renamed].map((note) => note.id))
    for (const [key, gone] of [...this.#unconfirmed]) {
      if (reappeared.has(gone.id)) this.#unconfirmed.delete(key)
    }

    /** 这一批已经报过的文件名，免得同一次变化既报「新增」又报「内容变了」 */
    const reported = new Set<string>()

    for (const note of diff.added) {
      reported.add(note.fileName.toLowerCase())
      this.#onEvent({ kind: 'add', note })
    }
    for (const note of diff.renamed) {
      reported.add(note.fileName.toLowerCase())
      // 改名对外就是「这篇变了」：列表里标题要跟着换，正在编辑的那篇要重新载入
      this.#onEvent({ kind: 'change', note })
    }
    for (const gone of diff.removed) {
      // 先记下来，等确认趟回来再说——见 #settleDeletes
      reported.add(gone.fileName.toLowerCase())
      this.#unconfirmed.set(gone.fileName.toLowerCase(), gone)
    }

    // 剩下的是「文件名没变、只是内容变了」。对账只看文件名，看不出这一种，
    // 所以得靠监听报上来的文件名反过来找是哪一篇
    for (const fileName of files) {
      const key = fileName.toLowerCase()
      if (reported.has(key)) continue
      if (this.#store.isSelfWrite(fileName)) continue
      const note = this.#store.touch(fileName)
      if (!note) continue
      this.#onEvent({ kind: 'change', note })
    }

    if (this.#unconfirmed.size > 0 && !this.#confirmTimer) {
      this.#confirmTimer = setTimeout(() => {
        this.#confirmTimer = null
        this.#flush(true)
      }, CONFIRM_DELETE_MS)
    }
  }
}
