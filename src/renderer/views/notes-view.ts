import { findAiProvider, isLoopbackBaseUrl } from '@shared/aiProviders'
import {
  EXPORT_EXTENSIONS,
  MAX_AI_CONTEXT,
  MAX_AI_INSTRUCTION,
  MAX_NOTE_BYTES
} from '@shared/limits'
import type { ExportFormat, LibraryChangedEvent, NoteMeta } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { MODE_HINT, MODE_LABEL, type EditorHandle, type EditorMode } from '../lib/editor/commands'
import { createEditorToolbar } from '../lib/editor/toolbar'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction, openModalCard, showFloating } from '../lib/overlay'

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

/**
 * 导出格式清单。
 *
 * 按「离原始内容越近越靠前」排：.md 是原文本身，.docx 是最常拿来交作业的。
 * 四种格式一屏放得下，不需要再分组或折叠。
 */
const EXPORT_ITEMS: ReadonlyArray<{ format: ExportFormat; label: string }> = [
  { format: 'md', label: 'Markdown 原文' },
  { format: 'html', label: '网页' },
  { format: 'docx', label: 'Word 文档' },
  { format: 'pdf', label: 'PDF 文档' }
]

/**
 * 常用的整理要求。
 *
 * 给几个「按一下就能用」的起点，比让用户对着空输入框自己想措辞友好得多。
 * 它们只是把文字填进输入框，用户可以随手改——所以这些是**例句**不是枚举值。
 */
const AI_PRESETS: ReadonlyArray<{ label: string; instruction: string }> = [
  { label: '整理成大纲', instruction: '把这篇笔记整理成层级清晰的大纲，保留原有信息，不要增删事实' },
  { label: '提炼要点', instruction: '提炼出这篇笔记的核心要点，用无序列表逐条列出，每条一句话' },
  { label: '复习提纲', instruction: '根据这篇笔记生成一份复习提纲，按知识点分组，标出需要重点记忆的地方' },
  { label: '解释难点', instruction: '找出这篇笔记里最难的几个概念，用更通俗的话解释一遍，可以打比方' },
  { label: '出练习题', instruction: '根据这篇笔记出 5 道练习题并附答案，覆盖主要知识点' },
  { label: '润色文字', instruction: '把这篇笔记的文字润色得更通顺，去掉口语和重复，不要改变原意' }
]

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
      <aside class="sb-notes__list" data-role="list">
        <div class="sb-notes__course" data-role="course-materials" hidden>
          <div class="sb-notes__course-head">本课资料</div>
          <div data-role="course-materials-list"></div>
        </div>
      </aside>
      <section class="sb-notes__editor">
        <p class="sb-empty" data-role="placeholder">从左边选一篇笔记，或者新建一篇。</p>
        <div class="sb-notes__pane" data-role="pane" hidden>
          <div class="sb-notes__pane-head">
            <input class="sb-input sb-notes__title" data-role="title" type="text" maxlength="80" aria-label="笔记标题" />
            <div class="sb-toolbar">
              <span class="sb-badge" data-role="meta"></span>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="materials">插资料</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="ai">AI 助手</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="export">导出</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="notion">推送到 Notion</button>
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
      void refreshCourseMaterials()
    } catch (error) {
      toast(`打不开这篇笔记：${formatError(error)}`, 'error')
    }
  }

  /* ------------------------------------------------- 本课资料（侧栏 + 插引用） */

  /**
   * 当前笔记所属课程的资料。
   *
   * 笔记和课程的关联记在卡片身上（noteId），所以这里要反向查一次卡片；
   * 查不到（未关联 / 已解绑）就把「本课资料」整块藏起来，不占侧栏地方。
   */
  async function refreshCourseMaterials(): Promise<void> {
    const block = element.querySelector<HTMLElement>('[data-role="course-materials"]')
    const host = element.querySelector<HTMLElement>('[data-role="course-materials-list"]')
    if (!block || !host) return
    if (!activeId) {
      block.hidden = true
      return
    }
    try {
      const cards = await unwrap(bridge().cards.list())
      const card = cards.find((entry) => entry.noteId === activeId)
      const materials = card
        ? (await unwrap(bridge().materials.list())).filter(
            (item) => item.courseCardId === card.id && !item.missing
          )
        : []
      if (!card || materials.length === 0) {
        block.hidden = true
        return
      }
      block.hidden = false
      host.innerHTML = materials
        .map(
          (item) => `
            <button class="sb-notes__material" type="button" data-material="${escapeHtml(item.id)}"
                    title="${escapeHtml(item.fileName)}（点击打开）">
              <span class="sb-notes__material-kind">${escapeHtml(item.ext.toUpperCase())}</span>
              <span class="sb-notes__material-name">${escapeHtml(item.title)}</span>
            </button>
          `
        )
        .join('')
    } catch {
      block.hidden = true
    }
  }

  async function insertMaterialReference(): Promise<void> {
    if (!editor || !activeId) {
      toast('先选一篇笔记再插资料', 'info')
      return
    }
    try {
      const cards = await unwrap(bridge().cards.list())
      const card = cards.find((entry) => entry.noteId === activeId)
      const items = await unwrap(bridge().materials.list())
      const { openMaterialPickDialog } = await import('../components/material-form')
      const picked = await openMaterialPickDialog(items, card?.id ?? '')
      if (!picked) return
      // Obsidian 的嵌入语法：库内文件名即路径，Obsidian 里能直接预览 PDF
      editor.insertText(`![[${picked.fileName}]]`)
      setStatus('已插入资料引用')
    } catch (error) {
      toast(`插入失败：${formatError(error)}`, 'error')
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

  /* ---------------------------------------------------------------- 导出 */

  /**
   * 点「导出」弹出来的格式菜单。
   *
   * 选完立刻关掉：菜单里点一下、保存对话框紧接着就弹出来，
   * 菜单还挂在那儿只会挡住对话框。
   */
  function openExportMenu(anchor: HTMLElement): void {
    if (!activeId) return
    const menu = showFloating({ className: 'sb-menu', anchor: anchor.getBoundingClientRect() })
    menu.element.innerHTML = EXPORT_ITEMS.map(
      (item) => `
        <button class="sb-menu__item" type="button" data-format="${item.format}">
          <span>${escapeHtml(item.label)}</span>
          <span class="sb-menu__hint">.${EXPORT_EXTENSIONS[item.format]}</span>
        </button>
      `
    ).join('')

    menu.element.addEventListener('click', (event) => {
      const format = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-format]')
        ?.dataset['format'] as ExportFormat | undefined
      if (!format) return
      menu.close()
      void runExport(format)
    })
  }

  async function runExport(format: ExportFormat): Promise<void> {
    const noteId = activeId
    if (!noteId) return

    // 导出读的是磁盘上那份文件，所以先把编辑器里还没落盘的内容写下去。
    // 少了这一步，用户刚敲的一段话会在「导出成功」的提示里凭空消失
    await flush()
    setStatus('导出中…')
    try {
      const result = await unwrap(bridge().exporter.note({ noteId, format }))
      if (result.cancelled || !result.filePath) {
        setStatus('')
        return
      }
      const path = result.filePath
      setStatus('已导出')
      // 导出十有八九是为了把文件发给别人，顺手把目录打开能省一步找文件
      const reveal = await confirmAction({
        title: '导出完成',
        message: `已保存到：\n${path}`,
        confirmText: '打开所在文件夹',
        cancelText: '知道了'
      })
      if (reveal) await unwrap(bridge().app.revealPath(path))
    } catch (error) {
      setStatus('')
      toast(`导出失败：${formatError(error)}`, 'error')
    }
  }

  /* ------------------------------------------------------------- AI 助手 */

  /**
   * AI 助手：把整篇笔记 + 用户的要求发给大模型，拿回一段整理好的 Markdown。
   *
   * 三条设计上的取舍：
   *  - **结果先预览，不直接改正文**。模型偶尔会跑偏，插进正文再让人自己删，
   *    比「生成完直接替换」要麻烦得多。
   *  - **不做「逐段改写」**。那需要把正文切成块、一块块往返，
   *    既慢又容易在中途失败时留下半新半旧的正文。
   *  - **认的是编辑器里的内容**，不是磁盘上那份：用户常常是写完一段就想整理一下，
   *    这时候那一段还在编辑器里，没落盘。
   */
  async function openAiAssistant(): Promise<void> {
    if (!editor || !activeId) return

    const source = editor.getMarkdown()
    if (!source.trim()) {
      toast('这篇笔记还是空的，先写点内容再让 AI 整理', 'error')
      return
    }

    const settings = ctx.getSettings()
    const preset = findAiProvider(settings.ai.provider)
    // 「有没有密钥」不等于「能不能用」：指向本机的地址不校验密钥。
    // 这条判据要和主进程一致（看地址，不看预设 id），否则界面放行、主进程拦下
    if (!settings.ai.hasApiKey && !isLoopbackBaseUrl(settings.ai.baseUrl)) {
      const go = await confirmAction({
        title: '还没配置 AI 服务',
        message:
          '请先在「设置 → AI 助手」里选一个服务商并保存 API Key。密钥是加密存在本机的，不会明文落盘，界面也不会回读。',
        confirmText: '去设置'
      })
      if (go) ctx.navigate('settings')
      return
    }

    let armTimer = 0
    const modal = openModalCard({
      className: 'sb-modal__card--ai',
      onClose: () => window.clearTimeout(armTimer)
    })

    const scope = `${escapeHtml(preset?.label ?? '自定义')} · ${escapeHtml(settings.ai.model || '未设置模型')}`
    modal.card.innerHTML = `
      <div class="sb-modal__title">AI 助手</div>
      <p class="sb-modal__message">处理整篇笔记（约 ${source.length} 字）· ${scope}</p>

      <div class="sb-ai__presets" data-role="presets">
        ${AI_PRESETS.map(
          (item, index) =>
            `<button class="sb-chip" type="button" data-preset="${index}">${escapeHtml(item.label)}</button>`
        ).join('')}
      </div>

      <div class="sb-field">
        <label for="sb-ai-instruction">整理要求</label>
        <textarea id="sb-ai-instruction" class="sb-textarea" rows="3"
                  placeholder="例如：把这篇笔记整理成一份复习提纲"></textarea>
      </div>
      <div class="sb-field">
        <label for="sb-ai-focus">参考重点（可选）</label>
        <input id="sb-ai-focus" class="sb-input" type="text" placeholder="例如：只看第三章" />
      </div>

      <div class="sb-ai__result" data-role="result" hidden>
        <div class="sb-ai__preview" data-role="preview"></div>
        <p class="sb-hint" data-role="usage"></p>
        <div class="sb-inline sb-ai__apply">
          <button class="sb-btn" type="button" data-role="replace">替换全文</button>
          <button class="sb-btn sb-btn--primary" type="button" data-role="append">插入到文末</button>
        </div>
      </div>

      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">关闭</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="run">生成</button>
      </div>
    `

    const instruction = modal.card.querySelector<HTMLTextAreaElement>('#sb-ai-instruction')
    const focusInput = modal.card.querySelector<HTMLInputElement>('#sb-ai-focus')
    const resultBox = modal.card.querySelector<HTMLElement>('[data-role="result"]')
    const preview = modal.card.querySelector<HTMLElement>('[data-role="preview"]')
    const usageEl = modal.card.querySelector<HTMLElement>('[data-role="usage"]')
    const runButton = modal.card.querySelector<HTMLButtonElement>('[data-role="run"]')
    const cancelButton = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const replaceButton = modal.card.querySelector<HTMLButtonElement>('[data-role="replace"]')

    let generated: string | null = null
    let armed = false

    function disarm(): void {
      armed = false
      window.clearTimeout(armTimer)
      if (!replaceButton) return
      replaceButton.textContent = '替换全文'
      replaceButton.classList.remove('sb-btn--danger')
    }

    modal.card.querySelector('[data-role="presets"]')?.addEventListener('click', (event) => {
      const raw = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-preset]')
        ?.dataset['preset']
      const item = raw === undefined ? undefined : AI_PRESETS[Number(raw)]
      if (!item || !instruction) return
      instruction.value = item.instruction
      instruction.focus()
      // 换了要求，上一次的结果就作废了——留着会让人以为新要求已经生效
      generated = null
      if (resultBox) resultBox.hidden = true
      disarm()
    })

    async function run(): Promise<void> {
      if (!instruction) return
      const text = instruction.value.trim()
      if (!text) {
        toast('先写下你想要的整理方式', 'error')
        instruction.focus()
        return
      }
      // 渲染层先拦一次是为了给出人话提示（别等发出去才报错）；主进程那边还会再收敛一次
      if (source.length > MAX_AI_CONTEXT) {
        toast(`这篇笔记太长了（${source.length} 字），超出单次能发送的上限`, 'error')
        return
      }

      if (runButton) {
        runButton.disabled = true
        runButton.textContent = '生成中…'
      }
      if (cancelButton) cancelButton.disabled = true
      try {
        const result = await unwrap(
          bridge().ai.complete({
            instruction: text.slice(0, MAX_AI_INSTRUCTION),
            focus: (focusInput?.value ?? '').trim(),
            context: source
          })
        )
        generated = result.text
        disarm()
        if (resultBox) resultBox.hidden = false
        if (usageEl) {
          usageEl.textContent = `${result.model} · 输入 ${result.usage.promptTokens} / 输出 ${result.usage.completionTokens} tokens`
        }
        if (preview) {
          // 预览用的是和富文本编辑器**同一份** Markdown 解析器，
          // 所以是「所见即所插」——不会出现预览好看、插进去变形
          const { markdownFragmentToHtml } = await import('../lib/editor/convert')
          preview.innerHTML = markdownFragmentToHtml(result.text)
        }
        if (runButton) runButton.textContent = '重新生成'
      } catch (error) {
        toast(`AI 请求失败：${formatError(error)}`, 'error')
        if (runButton) runButton.textContent = '生成'
      } finally {
        if (runButton) runButton.disabled = false
        if (cancelButton) cancelButton.disabled = false
      }
    }

    /**
     * 把结果落进正文。
     *
     * **不能指望编辑器的 onChange**：Markdown 那边 `dispatch` 会触发，
     * 富文本那边 `setContent(..., { emitUpdate: false })` 明确不触发。
     * 靠事件的话就变成「富文本模式下插入的内容永远不保存」——所以这里自己喊一次保存。
     */
    function applyResult(text: string, replaceAll: boolean): void {
      if (!editor) return
      const body = text.trim()
      const next = replaceAll ? body : `${editor.getMarkdown().replace(/\s+$/, '')}\n\n${body}\n`
      editor.setMarkdown(next)
      scheduleSave()
      toolbar?.refresh()
    }

    modal.card.querySelector('[data-role="append"]')?.addEventListener('click', () => {
      if (!generated) return
      applyResult(generated, false)
      modal.close()
      toast('已插入到笔记末尾', 'success')
    })

    replaceButton?.addEventListener('click', () => {
      if (!generated) return
      if (!armed) {
        // 就地二次确认，不再叠一层确认框：那个新框和这个框都监听 Esc，
        // 按一下会把两个一起关掉，连预览都没了
        armed = true
        replaceButton.textContent = '确认替换全文？'
        replaceButton.classList.add('sb-btn--danger')
        armTimer = window.setTimeout(disarm, 4000)
        return
      }
      window.clearTimeout(armTimer)
      applyResult(generated, true)
      modal.close()
      toast('已用 AI 的结果替换全文', 'success')
    })

    runButton?.addEventListener('click', () => void run())
    cancelButton?.addEventListener('click', () => modal.close())
    instruction?.focus()
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

  // 侧栏「本课资料」：点一下用系统默认程序打开（PDF 阅读器 / Office / WPS）
  element
    .querySelector('[data-role="course-materials-list"]')
    ?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null
      const id = target?.closest<HTMLElement>('[data-material]')?.dataset['material']
      if (!id) return
      try {
        await unwrap(bridge().materials.open(id))
      } catch (error) {
        toast(`打不开：${formatError(error)}`, 'error')
      }
    })

  // 资料在任何页面被导入 / 删除后，本课资料列表跟着刷新
  const onMaterialsChanged = (): void => {
    void refreshCourseMaterials()
  }
  window.addEventListener('sb:materials-changed', onMaterialsChanged)

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

  element.querySelector('[data-action="materials"]')?.addEventListener('click', () => {
    void insertMaterialReference()
  })
  element.querySelector('[data-action="ai"]')?.addEventListener('click', () => {
    void openAiAssistant()
  })

  element.querySelector('[data-action="export"]')?.addEventListener('click', (event) => {
    openExportMenu(event.currentTarget as HTMLElement)
  })

  /**
   * 推送当前这篇到 Notion。
   *
   * 推之前先把编辑器里还没落盘的内容写下去——与导出同一个道理：
   * 少了这一步，用户刚敲的一段话不会跟着上去，而界面上还显示「推送成功」。
   */
  element.querySelector('[data-action="notion"]')?.addEventListener('click', async (event) => {
    if (!activeId) return
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    setStatus('正在推送到 Notion…')
    try {
      await flush()
      const result = await unwrap(bridge().notion.push([activeId]))
      setStatus('已推送到 Notion')
      toast(
        result.skipped > 0 && result.pushed === 0
          ? '这篇没有变化，已跳过'
          : `已推送到 Notion（${result.pushed} 篇）`,
        'success'
      )
    } catch (error) {
      setStatus('')
      toast(`推送失败：${formatError(error)}`, 'error')
    } finally {
      button.disabled = false
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
      window.removeEventListener('sb:materials-changed', onMaterialsChanged)
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
