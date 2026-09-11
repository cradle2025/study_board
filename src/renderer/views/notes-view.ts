import { MAX_NOTE_BYTES } from '@shared/limits'
import type { LibraryChangedEvent, NoteMeta } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { MODE_HINT, MODE_LABEL, type EditorHandle, type EditorMode } from '../lib/editor/commands'
import { createEditorToolbar } from '../lib/editor/toolbar'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'

/**
 * 笔记页。
 *
 * 需求：「编辑器采用 md 或者 word 格式编辑（用户可自行选择两者其一），
 * 这个编辑器要有主流 md 格式编辑器和 word 的所有主要功能」。
 *
 * 做法是**双模式共用一份 .md 源文件**：
 *  - Markdown 模式用 CodeMirror 6，直接写源码；
 *  - 富文本模式用 TipTap，像 Word 那样所见即所得；
 *  - 切模式时把当前内容转过去，磁盘上始终只有那一份 .md。
 *
 * 编辑器**按需创建、切走就销毁**：两个编辑器加起来是笔不小的开销，
 * 让它们常驻只会让每个打开过笔记的会话都白白扛着。
 *
 * 自动保存是「停止输入 800ms 写一次」+「切走页面或离开笔记时补写一次」，
 * 既不会每敲一个字就落一次盘，也不会因为忘了按保存而丢东西。
 *
 * 磁盘上的文件还可能被别的程序改动（这个目录本来就是 Obsidian 库），
 * 所以主进程会推 `library-changed` 过来，见下面「外部改动」那一节。
 */

const AUTOSAVE_DELAY = 800

export function createNotesView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">笔记</h1>
        <p class="sb-view__desc">纯 Markdown 存在本地，目录可以直接作为 Obsidian 库打开。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="open">打开笔记库</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="new">新建笔记</button>
      </div>
    </div>

    <div class="sb-notice" data-role="lib-path">读取中…</div>

    <div class="sb-notes">
      <aside class="sb-notes__list" data-role="list"></aside>
      <section class="sb-notes__editor">
        <p class="sb-empty" data-role="placeholder">从左边选一篇笔记，或者新建一篇。</p>
        <div class="sb-notes__pane" data-role="pane" hidden>
          <div class="sb-notes__pane-head">
            <input class="sb-input sb-notes__title" data-role="title" type="text" maxlength="80" aria-label="笔记标题" />
            <div class="sb-toolbar">
              <span class="sb-badge" data-role="meta"></span>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="rename">重命名</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="delete">删除</button>
            </div>
          </div>

          <div class="sb-notes__modebar">
            <div class="sb-modeswitch" role="radiogroup" aria-label="编辑模式">
              <button class="sb-modeswitch__item" type="button" role="radio" data-mode="markdown">Markdown</button>
              <button class="sb-modeswitch__item" type="button" role="radio" data-mode="richtext">富文本</button>
            </div>
            <span class="sb-hint" data-role="mode-hint"></span>
          </div>

          <div data-role="toolbar"></div>
          <div class="sb-notes__stage" data-role="stage"></div>

          <div class="sb-notes__foot">
            <span class="sb-hint" data-role="status"></span>
            <span class="sb-hint" data-role="count"></span>
          </div>
        </div>
      </section>
    </div>
  `

  const listEl = element.querySelector<HTMLElement>('[data-role="list"]')
  const pathEl = element.querySelector<HTMLElement>('[data-role="lib-path"]')
  const placeholder = element.querySelector<HTMLElement>('[data-role="placeholder"]')
  const pane = element.querySelector<HTMLElement>('[data-role="pane"]')
  const titleInput = element.querySelector<HTMLInputElement>('[data-role="title"]')
  const metaBadge = element.querySelector<HTMLElement>('[data-role="meta"]')
  const statusEl = element.querySelector<HTMLElement>('[data-role="status"]')
  const countEl = element.querySelector<HTMLElement>('[data-role="count"]')
  const modeHint = element.querySelector<HTMLElement>('[data-role="mode-hint"]')
  const stage = element.querySelector<HTMLElement>('[data-role="stage"]')
  const toolbarSlot = element.querySelector<HTMLElement>('[data-role="toolbar"]')
  const modeButtons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-mode]'))

  let notes: readonly NoteMeta[] = []
  let activeId: string | null = null
  let mode: EditorMode = 'markdown'
  let editor: EditorHandle | null = null
  let toolbar: ReturnType<typeof createEditorToolbar> | null = null
  let dirty = false
  let timer = 0
  let countTimer = 0
  /** 正在切模式时不要触发保存，否则会把中间态写回磁盘 */
  let switching = false

  /* ------------------------------------------------------------ 基础渲染 */

  function setStatus(text: string): void {
    if (statusEl) statusEl.textContent = text
  }

  function renderModeSwitch(): void {
    for (const button of modeButtons) {
      const active = button.dataset['mode'] === mode
      button.setAttribute('aria-checked', active ? 'true' : 'false')
      button.classList.toggle('sb-modeswitch__item--on', active)
    }
    if (modeHint) modeHint.textContent = MODE_HINT[mode]
    if (metaBadge) metaBadge.textContent = MODE_LABEL[mode]
  }

  function renderList(): void {
    if (!listEl) return
    if (notes.length === 0) {
      listEl.innerHTML = '<p class="sb-empty">笔记库还是空的，点右上角「新建笔记」。</p>'
      return
    }
    listEl.innerHTML = notes
      .map(
        (note) => `
        <button class="sb-notes__item${note.id === activeId ? ' sb-notes__item--active' : ''}"
                type="button" data-note="${escapeHtml(note.id)}">
          <span class="sb-notes__item-title">${escapeHtml(note.title)}</span>
          <span class="sb-notes__item-date">${escapeHtml(note.updatedAt.slice(0, 10))}</span>
        </button>
      `
      )
      .join('')
  }

  async function refreshList(): Promise<void> {
    try {
      notes = await unwrap(bridge().notes.list())
    } catch (error) {
      toast(`笔记列表加载失败：${formatError(error)}`, 'error')
      notes = []
    }
    renderList()
  }

  /* -------------------------------------------------------------- 编辑器 */

  /**
   * 收起编辑器，回到「没选中任何笔记」的样子。
   *
   * 有个坑：必须把「待保存」标记和定时器一起清掉。否则编辑器没了、
   * 保存定时器还在跑，`flush()` 会拿着已经作废的内容往存储里写。
   */
  function clearEditor(): void {
    window.clearTimeout(timer)
    window.clearTimeout(countTimer)
    dirty = false
    activeId = null
    teardownEditor()
    if (pane) pane.hidden = true
    if (placeholder) placeholder.hidden = false
    setStatus('')
  }

  /** 只销毁编辑器。工具栏不跟着走——它只是换个绑定对象而已 */
  function teardownEditor(): void {
    editor?.destroy()
    editor = null
    stage?.replaceChildren()
  }

  /**
   * 工具栏只创建一次，之后靠 bind 换绑到新的编辑器上。
   *
   * 之前是「跟着编辑器一起重建」，结果工具栏元素在 DOM 里越堆越多，
   * 而 `querySelector` 永远取到最旧的那个——那个已经解除了事件监听，
   * 于是点上去毫无反应，还很难看出为什么。
   */
  function bindToolbar(next: EditorHandle): void {
    if (toolbar) {
      toolbar.bind(next)
      return
    }
    toolbar = createEditorToolbar({
      handle: next,
      onNotice: (message) => toast(message, 'info')
    })
    toolbarSlot?.appendChild(toolbar.element)
  }

  /**
   * 建编辑器。
   *
   * 两个编辑器都用**动态 import**：CodeMirror + TipTap 合起来是 2MB 出头，
   * 静态引入会让它们被塞进启动就要解析的主 bundle——
   * 而「打开应用先看课表」的路径上根本用不到笔记编辑器。
   * 拆成独立 chunk 之后，只有真的打开笔记页才会去加载。
   */
  async function mountEditor(md: string, nextMode: EditorMode): Promise<void> {
    teardownEditor()
    mode = nextMode

    const shared = {
      value: md,
      placeholder: '在这里写……',
      onChange: () => {
        scheduleSave()
        toolbar?.refresh()
      }
    }

    if (nextMode === 'markdown') {
      const { createMarkdownEditor } = await import('../lib/editor/markdown-editor')
      editor = createMarkdownEditor(shared)
    } else {
      const { createRichTextEditor } = await import('../lib/editor/richtext-editor')
      editor = createRichTextEditor(shared)
    }
    stage?.appendChild(editor.element)

    bindToolbar(editor)
    renderModeSwitch()
    updateCount()
  }

  function updateCount(): void {
    if (!countEl || !editor) return
    const text = editor.getMarkdown()
    countEl.textContent = `${text.length} 字 · ${text.split('\n').length} 行`
  }

  /**
   * 字数统计单独防抖。
   *
   * 富文本模式下 `getMarkdown()` 要把整篇 HTML 走一遍 turndown 转换，
   * 每次敲键都算一次的话，长笔记会上手就卡。改成停手一会儿再算。
   */
  function scheduleCount(): void {
    window.clearTimeout(countTimer)
    countTimer = window.setTimeout(updateCount, 1200)
  }

  /* ------------------------------------------------------------ 保存流程 */

  async function flush(): Promise<void> {
    if (!dirty || !activeId || !editor || switching) return
    window.clearTimeout(timer)
    // 先把内容取出来：写入是异步的，期间编辑器可能已经被销毁（切页面时就是这样）
    const markdown = editor.getMarkdown()
    const noteId = activeId
    dirty = false
    try {
      await unwrap(bridge().notes.write({ id: noteId, content: markdown, mode }))
      setStatus('已保存')
      await refreshList()
    } catch (error) {
      dirty = true
      setStatus('保存失败')
      toast(`保存失败：${formatError(error)}`, 'error')
    }
  }

  function scheduleSave(): void {
    dirty = true
    setStatus('编辑中…')
    scheduleCount()
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void flush()
    }, AUTOSAVE_DELAY)
  }

  async function open(noteId: string): Promise<void> {
    await flush()
    try {
      const doc = await unwrap(bridge().notes.read(noteId))
      activeId = doc.id
      if (titleInput) titleInput.value = doc.title
      if (placeholder) placeholder.hidden = true
      if (pane) pane.hidden = false
      setStatus('')
      dirty = false
      await mountEditor(doc.content, doc.mode)
      renderList()
    } catch (error) {
      toast(`打不开这篇笔记：${formatError(error)}`, 'error')
    }
  }

  /* ------------------------------------------------------------ 模式切换 */

  async function switchMode(next: EditorMode): Promise<void> {
    if (!editor || !activeId || next === mode) return

    // 切到富文本前先备份：md 表达不了的东西（合并单元格、文字颜色）互转时会退化
    if (next === 'richtext') {
      const confirmed = await confirmAction({
        title: '切到富文本模式？',
        message:
          '富文本用同一份 .md 文件做后端，Markdown 表达不了的格式（文字颜色、合并单元格等）在两者之间转换时会退化。\n\n切换前会自动把当前文件备份到笔记库的 .study-board/backups 目录。',
        confirmText: '切换'
      })
      if (!confirmed) return

      try {
        const saved = await unwrap(bridge().notes.backup(activeId))
        console.info('[notes] 已备份到', saved)
      } catch (error) {
        // 备份失败就别切了——宁可让用户重试一次，也不要在没有退路的情况下转换格式
        toast(`备份失败，已取消切换：${formatError(error)}`, 'error')
        return
      }
    }

    switching = true
    try {
      // 先把当前内容落盘，再拿它去建另一个编辑器——不然转换的是编辑器里的旧内容
      const markdown = editor.getMarkdown()
      dirty = false
      window.clearTimeout(timer)
      await unwrap(bridge().notes.write({ id: activeId, content: markdown, mode: next }))
      await mountEditor(markdown, next)
      setStatus('已切换模式')
      toast(next === 'richtext' ? '已切到富文本模式' : '已切到 Markdown 模式', 'success')
    } catch (error) {
      toast(`切换失败：${formatError(error)}`, 'error')
    } finally {
      switching = false
    }
  }

  /* ------------------------------------------------- 外部改动（文件监听） */

  /**
   * 别的程序动了笔记库，主进程推过来了。
   *
   * 我们自己的写入在主进程就被过滤掉了，不会走到这里，所以下面这几种
   * 都可以当成「外面有人改」来对待。
   */
  async function handleLibraryEvent(event: LibraryChangedEvent): Promise<void> {
    if (event.kind === 'reset') {
      // 笔记库换目录了。正在编辑的这篇已经不属于当前库，硬留着的话
      // 下一次自动保存会拿着旧 id 去新库里找，只会得到一个「笔记不存在」
      clearEditor()
      await refreshList()
      return
    }

    await refreshList()

    // 变的不是正在编辑的那一篇：列表刷新过就够了
    if (!activeId || event.id !== activeId) return

    if (event.kind === 'unlink') {
      // 正在编辑的这篇被外面删了。必须把编辑器收起来——留着的话，
      // 自动保存会把刚被删掉的文件又写回来，用户会觉得「怎么删都删不掉」
      clearEditor()
      toast('这篇笔记在外部被删除了，已从编辑器里收起来', 'error')
      return
    }

    // 剩下的都意味着「这篇在磁盘上被改过」——包括外部改名（id 从 frontmatter
    // 里认了回来，报成 change）和文件被删掉之后又被人放回来（报成 add）
    if (event.kind !== 'change' && event.kind !== 'add') return
    if (switching) return
    await reloadFromDisk()
  }

  /**
   * 磁盘上的内容变了，要不要盖掉编辑器里正在写的？
   *
   * 没改过就直接换掉：用户看到的就是最新的，这正是「双向同步」的意思。
   * 改过就必须问一句——自动保存马上就会把编辑器里的内容写回磁盘，
   * 这时无论选哪边都是覆盖另一边，不能替用户做这个决定。
   */
  async function reloadFromDisk(): Promise<void> {
    const id = activeId
    if (!id) return

    if (dirty) {
      const useDisk = await confirmAction({
        title: '这篇笔记在外部被修改了',
        message:
          '你正在编辑的内容还没有保存。载入磁盘版本会丢掉刚输入的内容；保留你的内容的话，稍后的自动保存会覆盖磁盘上这次的改动。',
        confirmText: '载入磁盘版本',
        cancelText: '保留我的内容',
        danger: true
      })
      if (!useDisk) {
        setStatus('外部已修改 · 保留了你正在编辑的内容')
        return
      }
      // 一定要先把「待保存」清掉：open() 开头会 flush() 一次，
      // 不清的话它会把我们刚刚决定丢掉的那份内容又写回磁盘，
      // 磁盘上的新版就这么被自己的旧版盖掉了——恰好是最该避免的事
      window.clearTimeout(timer)
      dirty = false
    }

    await open(id)
    setStatus('已从磁盘刷新')
  }

  /* ---------------------------------------------------------------- 事件 */

  // app-shell 每次切路由都会重建视图，所以退订是必须的：
  // 不退的话主进程那边会攒下一串永远没人调用的监听器
  const offLibrary = bridge().events.onLibraryChanged((payload) => {
    void handleLibraryEvent(payload)
  })

  listEl?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const id = target?.closest<HTMLElement>('[data-note]')?.dataset['note']
    if (id && id !== activeId) void open(id)
  })

  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset['mode'] as EditorMode | undefined
      if (next) void switchMode(next)
    })
  }

  // 光标移动要刷新工具栏的高亮状态（这一段在加粗里，B 就该亮着）
  stage?.addEventListener('keyup', () => toolbar?.refresh())
  stage?.addEventListener('mouseup', () => toolbar?.refresh())

  titleInput?.addEventListener('input', () => {
    dirty = true
    setStatus('标题待保存…')
  })

  function renderPath(): void {
    if (pathEl) pathEl.textContent = `笔记库目录：${ctx.getSettings().notesLibraryDir}`
  }

  element.querySelector('[data-action="open"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().app.openPath(ctx.getSettings().notesLibraryDir))
    } catch (error) {
      toast(`无法打开目录：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="new"]')?.addEventListener('click', async () => {
    try {
      const doc = await unwrap(bridge().notes.create('未命名笔记'))
      await refreshList()
      await open(doc.id)
      titleInput?.focus()
      titleInput?.select()
    } catch (error) {
      toast(`新建失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="rename"]')?.addEventListener('click', async () => {
    if (!activeId || !titleInput) return
    const next = titleInput.value.trim()
    if (next.length === 0) {
      toast('标题不能为空', 'error')
      return
    }
    try {
      const doc = await unwrap(bridge().notes.rename({ id: activeId, title: next }))
      activeId = doc.id
      titleInput.value = doc.title
      await refreshList()
      setStatus('已重命名')
    } catch (error) {
      toast(`重命名失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!activeId) return
    const current = notes.find((note) => note.id === activeId)
    const confirmed = await confirmAction({
      title: `删除「${current?.title ?? '这篇笔记'}」？`,
      message: '文件会被移入笔记库的 .study-board/trash 目录，不会真正抹掉，需要时可以自己找回来。',
      confirmText: '删除',
      danger: true
    })
    if (!confirmed) return

    try {
      const id = activeId
      dirty = false
      window.clearTimeout(timer)
      await unwrap(bridge().notes.remove(id))
      clearEditor()
      await refreshList()
      toast('已移入回收站', 'success')
    } catch (error) {
      toast(`删除失败：${formatError(error)}`, 'error')
    }
  })

  // 内容太长时提前拦住，别等到主进程才报错、用户白写一场
  stage?.addEventListener('blur', () => {
    if (editor && editor.getMarkdown().length * 4 > MAX_NOTE_BYTES) {
      toast('这篇笔记已经很大了，建议拆分成多篇', 'error')
    }
  })

  renderPath()
  renderModeSwitch()

  return {
    element,
    async onEnter() {
      await ctx.reloadSettings()
      renderPath()
      await refreshList()

      // 从课程卡片的「记笔记」跳过来时，直接定位到那篇
      const pending = ctx.consumePendingNote()
      if (pending) await open(pending)
    },
    dispose() {
      offLibrary()
      // 路由切走：把没保存的内容补写一次，不然最后敲的几个字就没了。
      // 内容必须**同步**取出来（teardownEditor 之后编辑器就没了），
      // 所以这里不复用 flush()
      window.clearTimeout(timer)
      window.clearTimeout(countTimer)
      if (dirty && activeId && editor) {
        const markdown = editor.getMarkdown()
        const noteId = activeId
        void bridge()
          .notes.write({ id: noteId, content: markdown, mode })
          .then((result) => {
            if (!result.ok) console.error('[notes] 离开页面时保存失败：', result.error)
          })
      }
      teardownEditor()
      toolbar?.destroy()
      toolbar?.element.remove()
      toolbar = null
    }
  }
}
