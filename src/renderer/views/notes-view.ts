import { MAX_NOTE_BYTES } from '@shared/limits'
import type { NoteMeta } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'

/**
 * 笔记页。
 *
 * 本轮的目标是把**存储与联动**跑通：列表、新建、重命名、删除，
 * 以及从课程卡片「记笔记」跳过来能定位到具体某一篇。
 *
 * 编辑器本身目前是最朴素的 textarea —— 它只是暂时的落脚点，
 * 下一轮会换成 CodeMirror 6（Markdown 模式）与 TipTap（富文本模式），
 * 双模式共用同一份 .md 源文件。**存储格式、保存时机、与卡片的关联已经定型**，
 * 换编辑器不会动这部分。
 *
 * 自动保存用的是「输入停止后 800ms 写一次」+「切走页面时补写一次」，
 * 既不会每敲一个字就落一次盘，也不会因为忘了按保存而丢东西。
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
      <section class="sb-notes__editor" data-role="editor">
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
          <textarea class="sb-textarea sb-notes__body" data-role="body" spellcheck="false"
                    placeholder="在这里写……支持 Markdown 语法"></textarea>
          <div class="sb-notes__foot">
            <span class="sb-hint" data-role="status"></span>
            <span class="sb-hint">Markdown 编辑器与富文本模式将在下一步接入。</span>
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
  const bodyArea = element.querySelector<HTMLTextAreaElement>('[data-role="body"]')
  const metaBadge = element.querySelector<HTMLElement>('[data-role="meta"]')
  const statusEl = element.querySelector<HTMLElement>('[data-role="status"]')

  let notes: readonly NoteMeta[] = []
  let activeId: string | null = null
  let dirty = false
  let timer = 0

  function setStatus(text: string): void {
    if (statusEl) statusEl.textContent = text
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

  /** 切走 / 关页面前把没落盘的改动补上，否则最后几个字会丢 */
  async function flush(): Promise<void> {
    if (!dirty || !activeId || !bodyArea) return
    window.clearTimeout(timer)
    dirty = false
    try {
      await unwrap(bridge().notes.write({ id: activeId, content: bodyArea.value }))
      setStatus('已保存')
      await refreshList()
    } catch (error) {
      dirty = true
      setStatus('保存失败')
      toast(`保存失败：${formatError(error)}`, 'error')
    }
  }

  async function open(noteId: string): Promise<void> {
    await flush()
    try {
      const doc = await unwrap(bridge().notes.read(noteId))
      activeId = doc.id
      if (titleInput) titleInput.value = doc.title
      if (bodyArea) bodyArea.value = doc.content
      if (metaBadge) metaBadge.textContent = doc.mode === 'richtext' ? '富文本' : 'Markdown'
      if (placeholder) placeholder.hidden = true
      if (pane) pane.hidden = false
      setStatus('')
      dirty = false
      renderList()
    } catch (error) {
      toast(`打不开这篇笔记：${formatError(error)}`, 'error')
    }
  }

  function scheduleSave(): void {
    dirty = true
    setStatus('编辑中…')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void flush()
    }, AUTOSAVE_DELAY)
  }

  bodyArea?.addEventListener('input', scheduleSave)
  titleInput?.addEventListener('input', scheduleSave)

  listEl?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const id = target?.closest<HTMLElement>('[data-note]')?.dataset['note']
    if (id) void open(id)
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
      const before = notes.length
      const doc = await unwrap(bridge().notes.create('未命名笔记'))
      await refreshList()
      if (notes.length === before) await refreshList()
      await open(doc.id)
      if (titleInput) titleInput.select()
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
      dirty = false
      window.clearTimeout(timer)
      await unwrap(bridge().notes.remove(activeId))
      activeId = null
      if (pane) pane.hidden = true
      if (placeholder) placeholder.hidden = false
      await refreshList()
      toast('已移入回收站', 'success')
    } catch (error) {
      toast(`删除失败：${formatError(error)}`, 'error')
    }
  })

  // 内容太长时提前拦住，别等到主进程才报错、用户白写一场
  bodyArea?.addEventListener('blur', () => {
    if (bodyArea.value.length * 4 > MAX_NOTE_BYTES) {
      toast('这篇笔记已经很大了，建议拆分成多篇', 'error')
    }
  })

  renderPath()

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
      // 路由切走：把没保存的内容补写一次，不然最后敲的几个字就没了
      void flush()
    }
  }
}
