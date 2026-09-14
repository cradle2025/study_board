import { findAiProvider, isLoopbackBaseUrl } from '@shared/aiProviders'
import { isImageExtension } from '@shared/materials'
import {
  EXPORT_EXTENSIONS,
  MAX_AI_CONTEXT,
  MAX_AI_INSTRUCTION,
  MAX_NOTE_BYTES
} from '@shared/limits'
import type { ExportFormat, IpcResult, LibraryChangedEvent, NoteGroup, NoteMeta } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { MODE_HINT, MODE_LABEL, type EditorHandle, type EditorMode } from '../lib/editor/commands'
import { outlineParents, parseHeadings, type OutlineItem } from '../lib/editor/outline'
import { createEditorToolbar } from '../lib/editor/toolbar'
import { t, tm } from '../lib/i18n'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction, openModalCard, promptText, showFloating } from '../lib/overlay'

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
  { format: 'md', label: 'notes.export.md' },
  { format: 'html', label: 'notes.export.html' },
  { format: 'docx', label: 'notes.export.docx' },
  { format: 'pdf', label: 'notes.export.pdf' }
]

/**
 * 常用的整理要求。
 *
 * 给几个「按一下就能用」的起点，比让用户对着空输入框自己想措辞友好得多。
 * 它们只是把文字填进输入框，用户可以随手改——所以这些是**例句**不是枚举值。
 */
const AI_PRESETS: ReadonlyArray<{ labelKey: string; instructionKey: string }> = [
  { labelKey: 'notes.ai.outline.label', instructionKey: 'notes.ai.outline.instruction' },
  { labelKey: 'notes.ai.keypoints.label', instructionKey: 'notes.ai.keypoints.instruction' },
  { labelKey: 'notes.ai.review.label', instructionKey: 'notes.ai.review.instruction' },
  { labelKey: 'notes.ai.explain.label', instructionKey: 'notes.ai.explain.instruction' },
  { labelKey: 'notes.ai.quiz.label', instructionKey: 'notes.ai.quiz.instruction' },
  { labelKey: 'notes.ai.polish.label', instructionKey: 'notes.ai.polish.instruction' }
]

export function createNotesView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.notes'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('notes.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="open">${escapeHtml(t('notes.openLibrary'))}</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="new">${escapeHtml(t('notes.newNote'))}</button>
      </div>
    </div>

    <div class="sb-notice" data-role="lib-path">${escapeHtml(t('common.loading'))}</div>

    <div class="sb-notes">
      <aside class="sb-notes__list" data-role="list">
        <div class="sb-notes__course" data-role="course-materials" hidden>
          <div class="sb-notes__course-head">${escapeHtml(t('notes.courseMaterials'))}</div>
          <div data-role="course-materials-list"></div>
        </div>
      </aside>
      <section class="sb-notes__editor">
        <p class="sb-empty" data-role="placeholder">${escapeHtml(t('notes.pickOrCreate'))}</p>
        <div class="sb-notes__pane" data-role="pane" hidden>
          <div class="sb-notes__pane-head">
            <input class="sb-input sb-notes__title" data-role="title" type="text" maxlength="80" aria-label="${escapeHtml(t('notes.titleLabel'))}" />
            <div class="sb-toolbar">
              <span class="sb-badge" data-role="meta"></span>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="materials">${escapeHtml(t('notes.insertMaterial'))}</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="ai">${escapeHtml(t('settings.ai'))}</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="export">${escapeHtml(t('notes.exportLabel'))}</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="notion">${escapeHtml(t('notes.pushNotion'))}</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="rename">${escapeHtml(t('common.rename'))}</button>
              <button class="sb-btn sb-btn--ghost" type="button" data-action="delete">${escapeHtml(t('common.delete'))}</button>
            </div>
          </div>

          <div class="sb-notes__modebar">
            <div class="sb-modeswitch" role="radiogroup" aria-label="${escapeHtml(t('notes.editorMode'))}">
              <button class="sb-modeswitch__item" type="button" role="radio" data-mode="markdown">Markdown</button>
              <button class="sb-modeswitch__item" type="button" role="radio" data-mode="richtext">${escapeHtml(t('settings.editor.richtext'))}</button>
            </div>
            <span class="sb-hint" data-role="mode-hint"></span>
          </div>

          <div data-role="toolbar"></div>

          <div class="sb-notes__main">
            <div class="sb-notes__stage" data-role="stage"></div>
            <aside class="sb-notes__outline" data-role="outline" hidden aria-label="${escapeHtml(t('notes.outline'))}">
              <div class="sb-notes__outline-head">
                <span>${escapeHtml(t('notes.outlineTitle'))}</span>
                <button class="sb-iconbtn" type="button" data-outline-act="collapse"
                        title="${escapeHtml(t('notes.collapseAll'))}" aria-label="${escapeHtml(t('notes.collapseAll'))}">⤒</button>
              </div>
              <div class="sb-notes__outline-body" data-role="outline-body"></div>
            </aside>
          </div>

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
  const outlineEl = element.querySelector<HTMLElement>('[data-role="outline"]')
  const outlineBody = element.querySelector<HTMLElement>('[data-role="outline-body"]')
  const toolbarSlot = element.querySelector<HTMLElement>('[data-role="toolbar"]')
  const modeButtons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-mode]'))

  let notes: readonly NoteMeta[] = []
  let groups: readonly NoteGroup[] = []
  /**
   * **收起**的分组 id（注意是「收起」不是「展开」）。
   *
   * 存收起而不是展开，是为了让默认值是「全展开」：集合是空的就等于全开着，
   * 不需要在建组时挨个塞进去。反过来的话，每次新建分组都要记得把它加进
   * 「展开集合」，漏一处那个组建出来就是收着的。
   *
   * 不落盘：这是纯粹的「这一眼怎么看」的状态，跟笔记内容无关。
   * 落盘会出现「昨天收起的组今天还收着」，而用户想不起来自己什么时候收的。
   */
  const collapsedGroups = new Set<string>()
  let activeId: string | null = null
  let mode: EditorMode = 'markdown'
  let editor: EditorHandle | null = null
  let toolbar: ReturnType<typeof createEditorToolbar> | null = null
  let dirty = false
  let timer = 0
  let countTimer = 0
  /** 大纲重画的节流定时器，与自动保存分开：两者的节奏要求不一样 */
  let outlineTimer = 0
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
    if (modeHint) modeHint.textContent = t(MODE_HINT[mode])
    if (metaBadge) metaBadge.textContent = t(MODE_LABEL[mode])
  }

  function renderList(): void {
    if (!listEl) return
    if (notes.length === 0 && groups.length === 0) {
      listEl.innerHTML = `<p class="sb-empty">${escapeHtml(t('notes.libraryEmpty'))}</p>`
      return
    }
    listEl.innerHTML = `${toolbarHtml()}<div class="sb-notes__tree">${treeHtml()}</div>`
  }

  /** 列表顶部那条：新建笔记 / 新建分组。分组是这一轮新加的，得有个入口 */
  function toolbarHtml(): string {
    return `
      <div class="sb-notes__listbar">
        <button class="sb-btn sb-btn--sm sb-btn--primary" type="button" data-list-act="new-note">${escapeHtml(t('notes.newNote'))}</button>
        <button class="sb-btn sb-btn--sm" type="button" data-list-act="new-group">${escapeHtml(t('notes.newGroup'))}</button>
      </div>
    `
  }

  /**
   * 侧栏的树。
   *
   * 分成「有分组」和「没分组」两种情况渲染，而不是一律套一层「未分组」：
   * 用户还没建过任何分组时，那层壳纯属噪音——他看到的应该就是原来那个平铺列表。
   * 一旦有了分组，未归类的笔记才需要一个落脚的标题。
   */
  function treeHtml(): string {
    const childGroups = new Map<string, NoteGroup[]>()
    for (const group of groups) {
      const bucket = childGroups.get(group.parentId)
      if (bucket) bucket.push(group)
      else childGroups.set(group.parentId, [group])
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const childNotes = new Map<string, NoteMeta[]>()
    for (const note of notes) {
      // 归属一个已经不存在的分组时按「未分组」显示。
      // 不这样兜的话，那条笔记会从侧栏里彻底消失——用户只会觉得笔记丢了
      const key = note.groupId && groupIds.has(note.groupId) ? note.groupId : ''
      const bucket = childNotes.get(key)
      if (bucket) bucket.push(note)
      else childNotes.set(key, [note])
    }

    /** 含子孙在内的笔记总数：折叠着也能看出「这一组里有多少东西」 */
    const totalOf = (groupId: string): number => {
      let total = (childNotes.get(groupId) ?? []).length
      for (const child of childGroups.get(groupId) ?? []) total += totalOf(child.id)
      return total
    }

    const notesHtml = (groupId: string): string =>
      (childNotes.get(groupId) ?? []).map((note) => noteRowHtml(note)).join('')

    const groupHtml = (group: NoteGroup): string => {
      const expanded = !collapsedGroups.has(group.id)
      const kids = childGroups.get(group.id) ?? []
      return `
        <div class="sb-notes__group" data-group="${escapeHtml(group.id)}">
          <div class="sb-notes__group-row${expanded ? ' sb-notes__group-row--open' : ''}">
            <button class="sb-notes__twisty" type="button" data-group-act="toggle"
                    aria-expanded="${expanded ? 'true' : 'false'}"
                    title="${escapeHtml(t(expanded ? 'notes.collapse' : 'notes.expand'))}" aria-label="${escapeHtml(t(expanded ? 'notes.collapse' : 'notes.expand'))} ${escapeHtml(group.name)}"
                    >${expanded ? '▾' : '▸'}</button>
            <span class="sb-notes__group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
            <span class="sb-notes__group-count">${totalOf(group.id)}</span>
            <span class="sb-notes__row-actions">
              <button class="sb-iconbtn" type="button" data-group-act="add-note" title="${escapeHtml(t('notes.group.addNoteTitle'))}" aria-label="${escapeHtml(t('notes.group.addNote', { name: group.name }))}">＋</button>
              <button class="sb-iconbtn" type="button" data-group-act="add-sub" title="${escapeHtml(t('notes.group.addSubTitle'))}" aria-label="${escapeHtml(t('notes.group.addSub', { name: group.name }))}">⊞</button>
              <button class="sb-iconbtn" type="button" data-group-act="rename" title="${escapeHtml(t('notes.group.renameTitle'))}" aria-label="${escapeHtml(t('notes.group.rename', { name: group.name }))}">✎</button>
              <button class="sb-iconbtn" type="button" data-group-act="move" title="${escapeHtml(t('notes.group.moveTitle'))}" aria-label="${escapeHtml(t('notes.group.move', { name: group.name }))}">⇄</button>
              <button class="sb-iconbtn sb-iconbtn--danger" type="button" data-group-act="remove" title="${escapeHtml(t('notes.group.removeTitle'))}" aria-label="${escapeHtml(t('notes.group.remove', { name: group.name }))}">✕</button>
            </span>
          </div>
          ${
            expanded
              ? `<div class="sb-notes__group-body">${kids.map(groupHtml).join('')}${notesHtml(group.id)}</div>`
              : ''
          }
        </div>
      `
    }

    const top = childGroups.get('') ?? []
    if (groups.length === 0) return notesHtml('')

    const loose = childNotes.get('') ?? []
    return `
      ${top.map(groupHtml).join('')}
      ${
        loose.length > 0
          ? `<div class="sb-notes__group sb-notes__group--loose">
               <div class="sb-notes__group-row">
                 <span class="sb-notes__twisty sb-notes__twisty--static">·</span>
                 <span class="sb-notes__group-name">${escapeHtml(t('notes.ungrouped'))}</span>
                 <span class="sb-notes__group-count">${loose.length}</span>
               </div>
               <div class="sb-notes__group-body">${notesHtml('')}</div>
             </div>`
          : ''
      }
    `
  }

  /**
   * 一条笔记。
   *
   * 用 `<div role="button">` 而不是 `<button>`：行里要放「移动到分组」这个小按钮，
   * 而按钮里嵌按钮是非法 HTML（浏览器会把内层那个甩到外面，点击区域全乱）。
   * 代价是键盘支持要自己补——见列表上的 keydown 处理。
   */
  function noteRowHtml(note: NoteMeta): string {
    const active = note.id === activeId
    return `
      <div class="sb-notes__item${active ? ' sb-notes__item--active' : ''}"
           data-note="${escapeHtml(note.id)}" role="button" tabindex="0"
           aria-current="${active ? 'true' : 'false'}"
           title="${escapeHtml(note.title)}">
        <span class="sb-notes__item-title">${escapeHtml(note.title)}</span>
        <span class="sb-notes__item-date">${escapeHtml(note.updatedAt.slice(0, 10))}</span>
        <span class="sb-notes__row-actions">
          <button class="sb-iconbtn" type="button" data-note-act="move"
                  title="${escapeHtml(t('notes.moveToGroup'))}" aria-label="${escapeHtml(t('notes.moveToGroupLabel', { name: note.title }))}">⇄</button>
        </span>
      </div>
    `
  }

  async function refreshList(): Promise<void> {
    try {
      const [nextNotes, nextGroups] = await Promise.all([
        unwrap(bridge().notes.list()),
        unwrap(bridge().notes.groups())
      ])
      notes = nextNotes
      groups = nextGroups
    } catch (error) {
      toast(t('notes.listFailed', { reason: tm(formatError(error)) }), 'error')
      notes = []
      groups = []
    }
    renderList()
  }

  /* ------------------------------------------------------------ 分组操作 */

  /** 新建笔记。`groupId` 非空时直接建在那个分组里（在组里点「＋」的场景） */
  async function createNote(groupId = ''): Promise<void> {
    try {
      const doc = await unwrap(
        bridge().notes.create(groupId ? { title: t('notes.untitled'), groupId } : t('notes.untitled'))
      )
      await refreshList()
      await open(doc.id)
      titleInput?.focus()
      titleInput?.select()
    } catch (error) {
      toast(t('notes.createFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  /** 分组增删改的统一收尾：换一份分组列表、重画、报一句状态 */
  async function applyGroups(
    result: Promise<IpcResult<NoteGroup[]>>,
    okMessage: string
  ): Promise<void> {
    try {
      groups = await unwrap(result)
      renderList()
      setStatus(okMessage)
    } catch (error) {
      toast(formatError(error), 'error')
    }
  }

  /** 某个分组连同其子孙的 id 集合。移动分组时用来排除「自己这棵子树」 */
  function subtreeIds(rootId: string): Set<string> {
    const found = new Set<string>([rootId])
    let grew = true
    while (grew) {
      grew = false
      for (const group of groups) {
        if (!found.has(group.id) && found.has(group.parentId)) {
          found.add(group.id)
          grew = true
        }
      }
    }
    return found
  }

  /**
   * 选一个目标分组。返回 null = 用户取消，空串 = 顶层 / 未分组。
   *
   * 缩进用全角空格而不是 CSS padding：`<option>` 在原生下拉里
   * 几乎不受样式控制，靠 CSS 缩进在不同平台上表现不一致，
   * 而用户看不出层级就会随便选一个。
   */
  function pickGroup(title: string, exclude: ReadonlySet<string>): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = openModalCard({ className: 'sb-modal__card--form' })
      const depthOf = (group: NoteGroup): number => {
        let depth = 1
        let cursor = group.parentId
        for (let guard = 0; cursor && guard < groups.length; guard += 1) {
          const parent = groups.find((item) => item.id === cursor)
          if (!parent) break
          depth += 1
          cursor = parent.parentId
        }
        return depth
      }
      const options = groups.filter((group) => !exclude.has(group.id))

      modal.card.innerHTML = `
        <div class="sb-modal__title">${escapeHtml(title)}</div>
        <div class="sb-field">
          <label for="sb-group-pick">${escapeHtml(t('notes.targetGroup'))}</label>
          <select class="sb-select" id="sb-group-pick" data-field="pick">
            <option value="">${escapeHtml(t('notes.topLevel'))}</option>
            ${options
              .map(
                (group) =>
                  `<option value="${escapeHtml(group.id)}">${'　'.repeat(Math.max(0, depthOf(group) - 1))}${escapeHtml(group.name)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="sb-modal__actions">
          <button class="sb-btn" type="button" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
          <button class="sb-btn sb-btn--primary" type="button" data-role="confirm">${escapeHtml(t('common.confirm'))}</button>
        </div>
      `

      const pick = modal.card.querySelector<HTMLSelectElement>('[data-field="pick"]')
      let settled = false
      const done = (value: string | null): void => {
        if (settled) return
        settled = true
        modal.close()
        resolve(value)
      }
      modal.card
        .querySelector('[data-role="cancel"]')
        ?.addEventListener('click', () => done(null))
      modal.card
        .querySelector('[data-role="confirm"]')
        ?.addEventListener('click', () => done(pick?.value ?? ''))
    })
  }

  /** 把一篇笔记挪进某个分组。不提供拖拽——侧栏宽度有限，拖拽的目标很难瞄准 */
  async function moveNote(noteId: string): Promise<void> {
    const note = notes.find((item) => item.id === noteId)
    if (!note) return
    const groupId = await pickGroup(t('notes.moveNamed', { name: note.title }), new Set())
    if (groupId === null) return
    try {
      notes = await unwrap(bridge().notes.setGroup({ id: noteId, groupId }))
      renderList()
      const target = groups.find((item) => item.id === groupId)
      setStatus(target ? t('notes.movedTo', { name: target.name }) : t('notes.movedOut'))
    } catch (error) {
      toast(formatError(error), 'error')
    }
  }

  async function onListAction(act: string): Promise<void> {
    if (act === 'new-note') {
      await createNote('')
      return
    }
    if (act === 'new-group') {
      const name = await promptText({
        title: t('notes.groupDialog.create'),
        label: t('notes.groupDialog.label'),
        placeholder: t('notes.groupDialog.example'),
        maxLength: 40,
        hint: t('notes.groupDialog.hint'),
      })
      if (!name) return
      await applyGroups(bridge().notes.createGroup({ name }), t('notes.groupDialog.created', { name }))
    }
  }

  async function onGroupAction(act: string, groupId: string): Promise<void> {
    const group = groups.find((item) => item.id === groupId)
    if (!group) return

    switch (act) {
      case 'toggle': {
        if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId)
        else collapsedGroups.add(groupId)
        renderList()
        return
      }
      case 'add-note':
        await createNote(groupId)
        return
      case 'add-sub': {
        const name = await promptText({
          title: t('notes.groupDialog.createSub', { name: group.name }),
          label: t('notes.groupDialog.label'),
          placeholder: t('notes.groupDialog.exampleSub'),
          maxLength: 40
        })
        if (!name) return
        await applyGroups(
          bridge().notes.createGroup({ name, parentId: groupId }),
          t('notes.groupDialog.subCreated', { name })
        )
        return
      }
      case 'rename': {
        const name = await promptText({
          title: t('notes.groupDialog.rename'),
          label: t('notes.groupDialog.label'),
          value: group.name,
          maxLength: 40
        })
        if (!name || name === group.name) return
        await applyGroups(bridge().notes.renameGroup({ id: groupId, name }), t('notes.groupDialog.renamed'))
        return
      }
      case 'move': {
        // 排除自己这棵子树：挪进去会让整段从侧栏消失（笔记还在，但找不到了）
        const parentId = await pickGroup(t('notes.moveNamed', { name: group.name }), subtreeIds(groupId))
        if (parentId === null || parentId === group.parentId) return
        await applyGroups(bridge().notes.moveGroup({ id: groupId, parentId }), t('notes.groupDialog.moved'))
        return
      }
      case 'remove': {
        const kids = groups.filter((item) => item.parentId === groupId).length
        const inside = notes.filter((note) => note.groupId === groupId).length
        const consequence =
          kids + inside > 0
            ? t('notes.groupDialog.removeBody', { notes: inside, groups: kids })
            : t('notes.groupDialog.removeEmpty')
        const ok = await confirmAction({
          title: t('notes.groupDialog.removeTitle', { name: group.name }),
          message: consequence,
          confirmText: t('notes.groupDialog.removeConfirm'),
          danger: true
        })
        if (!ok) return
        // 删完要让列表和分组都重新取：组里的笔记归属变了，不只是分组少了
        try {
          groups = await unwrap(bridge().notes.removeGroup(groupId))
          notes = await unwrap(bridge().notes.list())
          collapsedGroups.delete(groupId)
          renderList()
          setStatus(t('notes.groupDialog.removed'))
        } catch (error) {
          toast(formatError(error), 'error')
        }
        return
      }
    }
  }

  /* -------------------------------------------------------------- 大纲 */

  /**
   * 收起的大纲项（存下标）。和侧栏分组一样，存「收起」让默认值是「全展开」。
   *
   * 注意这里存的是**下标**而不是标题文字：同名标题是合法的，
   * 用文字当键会让两个「小结」一起被收起。
   */
  const collapsedOutline = new Set<number>()
  let outlineItems: readonly OutlineItem[] = []

  /**
   * 重画大纲。
   *
   * 空大纲时整块面板藏起来，而不是显示「本文没有标题」——
   * 短笔记（没写标题的随手记）占大多数，常驻一块空面板会一直挤着编辑区。
   */
  function renderOutline(markdown: string): void {
    if (!outlineEl || !outlineBody) return
    outlineItems = parseHeadings(markdown)

    if (outlineItems.length === 0) {
      outlineEl.hidden = true
      outlineBody.innerHTML = ''
      return
    }
    outlineEl.hidden = false

    const parents = outlineParents(outlineItems)

    // 祖先里有任何一个被收起，这一项就不显示
    const hidden = new Set<number>()
    for (let i = 0; i < outlineItems.length; i += 1) {
      let cursor = parents[i] ?? -1
      // 上限就是标题总数：真出现坏数据也不会把渲染卡死
      for (let guard = 0; cursor >= 0 && guard <= outlineItems.length; guard += 1) {
        if (collapsedOutline.has(cursor)) {
          hidden.add(i)
          break
        }
        cursor = parents[cursor] ?? -1
      }
    }

    const depthOf = (i: number): number => {
      let depth = 0
      let cursor = parents[i] ?? -1
      for (let guard = 0; cursor >= 0 && guard <= outlineItems.length; guard += 1) {
        depth += 1
        cursor = parents[cursor] ?? -1
      }
      return depth
    }

    const hasChildren = new Set<number>()
    for (const parent of parents) {
      if (parent >= 0) hasChildren.add(parent)
    }

    outlineBody.innerHTML = outlineItems
      .map((item, i) => {
        if (hidden.has(i)) return ''
        const collapsed = collapsedOutline.has(i)
        const kids = hasChildren.has(i)
        // 缩进用 padding，层级一眼可见；上限 4 层免得把标题文字挤没
        const indent = Math.min(depthOf(i), 4) * 11
        return `
          <div class="sb-notes__outline-item" data-outline="${i}"
               style="padding-left: ${indent + 4}px" title="${escapeHtml(item.text)}">
            ${
              kids
                ? `<button class="sb-notes__outline-twisty" type="button" data-outline-act="toggle" data-outline-index="${i}"
                           aria-expanded="${collapsed ? 'false' : 'true'}"
                           aria-label="${escapeHtml(t(collapsed ? 'notes.expand' : 'notes.collapse'))} ${escapeHtml(item.text)}">${collapsed ? '▸' : '▾'}</button>`
                : '<span class="sb-notes__outline-twisty sb-notes__outline-twisty--leaf"></span>'
            }
            <button class="sb-notes__outline-label" type="button" data-outline-act="jump" data-outline-index="${i}"
                    >${escapeHtml(item.text)}</button>
          </div>
        `
      })
      .join('')
  }

  /** 正文变了就重画大纲。跟自动保存同一个节流，别每敲一个字都重排一次 */
  function scheduleOutline(markdown: string): void {
    window.clearTimeout(outlineTimer)
    outlineTimer = window.setTimeout(() => renderOutline(markdown), 250)
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
    // 大纲是「这一篇的目录」，编辑器没了它就没有意义。
    // 不清定时器的话，切换笔记的瞬间那个待执行的重画会把上一份大纲贴回来
    window.clearTimeout(outlineTimer)
    if (outlineEl) outlineEl.hidden = true
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
      onNotice: (message) => toast(message, 'info'),
      // 「插入图片」要弹选择器、走 IPC，是异步的，交给视图层做
      onCommand: (command) => {
        if (command !== 'image') return false
        void insertMaterialReference(true)
        return true
      }
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
      placeholder: t('notes.editorPlaceholder'),
      onChange: () => {
        scheduleSave()
        toolbar?.refresh()
        // 大纲跟着正文走。这里必须重新取一次 markdown 而不是复用 `md`——
        // 那个是打开笔记那一刻的内容，用户之后敲的东西它不知道
        scheduleOutline(editor?.getMarkdown() ?? '')
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
    // 打开笔记 / 切模式时立刻画一次，不要等节流
    window.clearTimeout(outlineTimer)
    renderOutline(md)
  }

  function updateCount(): void {
    if (!countEl || !editor) return
    const text = editor.getMarkdown()
    countEl.textContent = t('notes.count', { chars: text.length, lines: text.split('\n').length })
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
      setStatus(t('notes.saved'))
      await refreshList()
    } catch (error) {
      dirty = true
      setStatus(t('notes.saveFailedShort'))
      toast(t('notes.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  function scheduleSave(): void {
    dirty = true
    setStatus(t('notes.editing'))
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
      toast(t('notes.openFailed', { reason: tm(formatError(error)) }), 'error')
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
                    title="${escapeHtml(t('notes.openFile', { name: item.fileName }))}">
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

  /**
   * 往正文里插一份资料。
   *
   * **图片和文档走不同的插入形式**，这不是小事：
   *  - 文档用 Obsidian 的嵌入语法 `![[文件名]]`，它在 Obsidian 里能直接预览；
   *  - 图片用标准 Markdown `![说明](attachments/文件名)`。因为
   *    `![[...]]` 是 Obsidian 私有语法，**导出 HTML / PDF / DOCX 时它只是一段文字**，
   *    用户会得到一行 `![[IMG_2231.png]]` 而不是照片。
   *    标准语法则三种导出全都能渲染。
   *
   * 所以判断依据是「这份资料是不是图片」，而不是「用户点了哪个按钮」。
   * `imagesOnly` 只是决定选择器里列什么。
   */
  async function insertMaterialReference(imagesOnly = false): Promise<void> {
    if (!editor || !activeId) {
      toast(t('notes.pickFirst'), 'info')
      return
    }
    try {
      const cards = await unwrap(bridge().cards.list())
      const card = cards.find((entry) => entry.noteId === activeId)
      const items = await unwrap(bridge().materials.list())
      if (imagesOnly && !items.some((item) => isImageExtension(item.ext) && !item.missing)) {
        toast(t('notes.noImages'), 'info')
        return
      }
      const { openMaterialPickDialog } = await import('../components/material-form')
      const picked = await openMaterialPickDialog(items, card?.id ?? '', { imagesOnly })
      if (!picked) return

      if (isImageExtension(picked.ext)) {
        // 相对路径（`attachments/文件名`）：这样 .md 拿到 Obsidian 里同样是通的
        const ok = editor.insertImage(`attachments/${picked.fileName}`, picked.title)
        setStatus(t(ok ? 'notes.imageInserted' : 'notes.imageUnsupported'))
        return
      }
      // Obsidian 的嵌入语法：库内文件名即路径，Obsidian 里能直接预览 PDF
      editor.insertText(`![[${picked.fileName}]]`)
      setStatus(t('notes.materialInserted'))
    } catch (error) {
      toast(t('notes.insertFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  /* ------------------------------------------------------------ 模式切换 */

  async function switchMode(next: EditorMode): Promise<void> {
    if (!editor || !activeId || next === mode) return

    // 切到富文本前先备份：md 表达不了的东西（合并单元格、文字颜色）互转时会退化
    if (next === 'richtext') {
      const confirmed = await confirmAction({
        title: t('notes.switchToRichTitle'),
        message:
          t('notes.switchToRichBody'),
        confirmText: t('notes.switchConfirm')
      })
      if (!confirmed) return

      try {
        const saved = await unwrap(bridge().notes.backup(activeId))
        console.info('[notes] 已备份到', saved)
      } catch (error) {
        // 备份失败就别切了——宁可让用户重试一次，也不要在没有退路的情况下转换格式
        toast(t('notes.backupFailed', { reason: tm(formatError(error)) }), 'error')
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
      setStatus(t('notes.modeSwitched'))
      toast(t(next === 'richtext' ? 'notes.switchedToRich' : 'notes.switchedToMarkdown'), 'success')
    } catch (error) {
      toast(t('notes.switchFailed', { reason: tm(formatError(error)) }), 'error')
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
      toast(t('notes.deletedOutside'), 'error')
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
        title: t('notes.changedOutsideTitle'),
        message:
          t('notes.changedOutsideBody'),
        confirmText: t('notes.loadFromDisk'),
        cancelText: t('notes.keepMine'),
        danger: true
      })
      if (!useDisk) {
        setStatus(t('notes.keptMine'))
        return
      }
      // 一定要先把「待保存」清掉：open() 开头会 flush() 一次，
      // 不清的话它会把我们刚刚决定丢掉的那份内容又写回磁盘，
      // 磁盘上的新版就这么被自己的旧版盖掉了——恰好是最该避免的事
      window.clearTimeout(timer)
      dirty = false
    }

    await open(id)
    setStatus(t('notes.reloadedFromDisk'))
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
          <span>${escapeHtml(t(item.label))}</span>
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
    setStatus(t('notes.exporting'))
    try {
      const result = await unwrap(bridge().exporter.note({ noteId, format }))
      if (result.cancelled || !result.filePath) {
        setStatus('')
        return
      }
      const path = result.filePath
      setStatus(t('notes.exported'))
      // 导出十有八九是为了把文件发给别人，顺手把目录打开能省一步找文件
      const reveal = await confirmAction({
        title: t('notes.exportDoneTitle'),
        message: t('notes.exportDoneBody', { path }),
        confirmText: t('notes.openContainingFolder'),
        cancelText: t('common.gotIt')
      })
      if (reveal) await unwrap(bridge().app.revealPath(path))
    } catch (error) {
      setStatus('')
      toast(t('notes.exportFailed', { reason: tm(formatError(error)) }), 'error')
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
      toast(t('notes.ai.empty'), 'error')
      return
    }

    const settings = ctx.getSettings()
    const preset = findAiProvider(settings.ai.provider)
    // 「有没有密钥」不等于「能不能用」：指向本机的地址不校验密钥。
    // 这条判据要和主进程一致（看地址，不看预设 id），否则界面放行、主进程拦下
    if (!settings.ai.hasApiKey && !isLoopbackBaseUrl(settings.ai.baseUrl)) {
      const go = await confirmAction({
        title: t('notes.ai.notConfiguredTitle'),
        message:
          t('notes.ai.notConfiguredBody'),
        confirmText: t('notes.ai.goSettings')
      })
      if (go) ctx.navigate('settings')
      return
    }

    let armTimer = 0
    const modal = openModalCard({
      className: 'sb-modal__card--ai',
      onClose: () => window.clearTimeout(armTimer)
    })

    const scope = `${escapeHtml(preset?.label ?? t('settings.customProvider'))} · ${escapeHtml(settings.ai.model || t('notes.ai.noModel'))}`
    modal.card.innerHTML = `
      <div class="sb-modal__title">${escapeHtml(t('settings.ai'))}</div>
      <p class="sb-modal__message">${escapeHtml(t('notes.ai.scope', { chars: source.length }))} · ${scope}</p>

      <div class="sb-ai__presets" data-role="presets">
        ${AI_PRESETS.map(
          (item, index) =>
            `<button class="sb-chip" type="button" data-preset="${index}">${escapeHtml(t(item.labelKey))}</button>`
        ).join('')}
      </div>

      <div class="sb-field">
        <label for="sb-ai-instruction">${escapeHtml(t('notes.ai.instructionLabel'))}</label>
        <textarea id="sb-ai-instruction" class="sb-textarea" rows="3"
                  placeholder="${escapeHtml(t('notes.ai.instructionPlaceholder'))}"></textarea>
      </div>
      <div class="sb-field">
        <label for="sb-ai-focus">${escapeHtml(t('notes.ai.focusLabel'))}</label>
        <input id="sb-ai-focus" class="sb-input" type="text" placeholder="${escapeHtml(t('notes.ai.focusPlaceholder'))}" />
      </div>

      <div class="sb-ai__result" data-role="result" hidden>
        <div class="sb-ai__preview" data-role="preview"></div>
        <p class="sb-hint" data-role="usage"></p>
        <div class="sb-inline sb-ai__apply">
          <button class="sb-btn" type="button" data-role="replace">${escapeHtml(t('notes.ai.replace'))}</button>
          <button class="sb-btn sb-btn--primary" type="button" data-role="append">${escapeHtml(t('notes.ai.append'))}</button>
        </div>
      </div>

      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">${escapeHtml(t('common.close'))}</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="run">${escapeHtml(t('notes.ai.run'))}</button>
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
      replaceButton.textContent = t('notes.ai.replace')
      replaceButton.classList.remove('sb-btn--danger')
    }

    modal.card.querySelector('[data-role="presets"]')?.addEventListener('click', (event) => {
      const raw = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-preset]')
        ?.dataset['preset']
      const item = raw === undefined ? undefined : AI_PRESETS[Number(raw)]
      if (!item || !instruction) return
      instruction.value = t(item.instructionKey)
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
        toast(t('notes.ai.needInstruction'), 'error')
        instruction.focus()
        return
      }
      // 渲染层先拦一次是为了给出人话提示（别等发出去才报错）；主进程那边还会再收敛一次
      if (source.length > MAX_AI_CONTEXT) {
        toast(t('notes.ai.tooLong', { chars: source.length }), 'error')
        return
      }

      if (runButton) {
        runButton.disabled = true
        runButton.textContent = t('notes.ai.running')
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
          usageEl.textContent = t('notes.ai.usage', { model: result.model, input: result.usage.promptTokens, output: result.usage.completionTokens })
        }
        if (preview) {
          // 预览用的是和富文本编辑器**同一份** Markdown 解析器，
          // 所以是「所见即所插」——不会出现预览好看、插进去变形
          const { markdownFragmentToHtml } = await import('../lib/editor/convert')
          preview.innerHTML = markdownFragmentToHtml(result.text)
        }
        if (runButton) runButton.textContent = t('notes.ai.regenerate')
      } catch (error) {
        toast(t('notes.ai.failed', { reason: tm(formatError(error)) }), 'error')
        if (runButton) runButton.textContent = t('notes.ai.run')
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
      toast(t('notes.ai.appended'), 'success')
    })

    replaceButton?.addEventListener('click', () => {
      if (!generated) return
      if (!armed) {
        // 就地二次确认，不再叠一层确认框：那个新框和这个框都监听 Esc，
        // 按一下会把两个一起关掉，连预览都没了
        armed = true
        replaceButton.textContent = t('notes.ai.confirmReplace')
        replaceButton.classList.add('sb-btn--danger')
        armTimer = window.setTimeout(disarm, 4000)
        return
      }
      window.clearTimeout(armTimer)
      applyResult(generated, true)
      modal.close()
      toast(t('notes.ai.replaced'), 'success')
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

  /**
   * 大纲的点击。
   *
   * 跳转走 `editor.revealHeading(index)`，让每个编辑器自己决定怎么定位
   * （Markdown 按行号，富文本按 DOM 顺序）。视图层只需要说「第几个标题」。
   */
  outlineBody?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    const act = target.closest<HTMLElement>('[data-outline-act]')?.dataset['outlineAct']
    const raw = target.closest<HTMLElement>('[data-outline-index]')?.dataset['outlineIndex']
    const index = raw === undefined ? Number.NaN : Number(raw)

    if (act === 'toggle' && Number.isInteger(index)) {
      if (collapsedOutline.has(index)) collapsedOutline.delete(index)
      else collapsedOutline.add(index)
      renderOutline(editor?.getMarkdown() ?? '')
      return
    }
    if (act === 'jump' && Number.isInteger(index)) {
      if (!editor?.revealHeading(index)) {
        toast(t('notes.outlineNotFound'), 'info')
      }
    }
  })

  element.querySelector('[data-outline-act="collapse"]')?.addEventListener('click', () => {
    // 「全部收起」= 把所有**有子项**的标题收起来。只收父项：
    // 叶子节点没有可折叠的东西，把它们也塞进集合只是噪音
    const parents = outlineParents(outlineItems)
    const hasChildren = new Set<number>()
    for (const parent of parents) if (parent >= 0) hasChildren.add(parent)
    collapsedOutline.clear()
    for (const index of hasChildren) collapsedOutline.add(index)
    renderOutline(editor?.getMarkdown() ?? '')
  })

  listEl?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return

    // 分组行上的动作按钮（＋ ⊞ ✎ ⇄ ✕）：先于「点开笔记」处理，
    // 否则点这些按钮会连带触发下面的 data-note 分支
    const groupAct = target.closest<HTMLElement>('[data-group-act]')?.dataset['groupAct']
    if (groupAct) {
      const groupId = target.closest<HTMLElement>('[data-group]')?.dataset['group']
      if (groupId) void onGroupAction(groupAct, groupId)
      return
    }

    // 顶部工具条
    const listAct = target.closest<HTMLElement>('[data-list-act]')?.dataset['listAct']
    if (listAct) {
      void onListAction(listAct)
      return
    }

    // 笔记行上的「移动到分组」
    const noteAct = target.closest<HTMLElement>('[data-note-act]')?.dataset['noteAct']
    if (noteAct === 'move') {
      const noteId = target.closest<HTMLElement>('[data-note]')?.dataset['note']
      if (noteId) void moveNote(noteId)
      return
    }

    const id = target.closest<HTMLElement>('[data-note]')?.dataset['note']
    if (id && id !== activeId) void open(id)
  })

  /**
   * 键盘等价物。
   *
   * 笔记行改成 `<div role="button">` 之后，Enter / 空格不再自动触发点击，
   * 得自己补——不然侧栏就成了一个只能用鼠标操作的地方。
   */
  listEl?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target as HTMLElement | null
    // 行里真正的 <button>（折叠、动作）自己会处理，别抢它们的键
    if (!target || target.tagName === 'BUTTON') return
    const id = target.closest<HTMLElement>('[data-note]')?.dataset['note']
    if (!id) return
    event.preventDefault()
    if (id !== activeId) void open(id)
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
        toast(t('notes.openPathFailed', { reason: tm(formatError(error)) }), 'error')
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
    setStatus(t('notes.titlePending'))
  })

  function renderPath(): void {
    if (pathEl) pathEl.textContent = t('notes.libraryPath', { path: ctx.getSettings().notesLibraryDir })
  }

  element.querySelector('[data-action="open"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().app.openPath(ctx.getSettings().notesLibraryDir))
    } catch (error) {
      toast(t('notes.openDirFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="new"]')?.addEventListener('click', () => {
    void createNote('')
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
    setStatus(t('notes.notionPushing'))
    try {
      await flush()
      const result = await unwrap(bridge().notion.push([activeId]))
      setStatus(t('notes.notionPushed'))
      toast(
        result.skipped > 0 && result.pushed === 0
          ? t('notes.notionUnchanged')
          : t('notes.notionPushedCount', { count: result.pushed }),
        'success'
      )
    } catch (error) {
      setStatus('')
      toast(t('notes.notionFailed', { reason: tm(formatError(error)) }), 'error')
    } finally {
      button.disabled = false
    }
  })

  element.querySelector('[data-action="rename"]')?.addEventListener('click', async () => {
    if (!activeId || !titleInput) return
    const next = titleInput.value.trim()
    if (next.length === 0) {
      toast(t('notes.titleEmpty'), 'error')
      return
    }
    try {
      const doc = await unwrap(bridge().notes.rename({ id: activeId, title: next }))
      activeId = doc.id
      titleInput.value = doc.title
      await refreshList()
      setStatus(t('notes.renamed'))
    } catch (error) {
      toast(t('notes.renameFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!activeId) return
    const current = notes.find((note) => note.id === activeId)
    const confirmed = await confirmAction({
      title: t('notes.removeTitle', { name: current?.title ?? t('notes.thisNote') }),
      message: t('notes.removeBody'),
      confirmText: t('common.delete'),
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
      toast(t('notes.movedToTrash'), 'success')
    } catch (error) {
      toast(t('notes.removeFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  // 内容太长时提前拦住，别等到主进程才报错、用户白写一场
  stage?.addEventListener('blur', () => {
    if (editor && editor.getMarkdown().length * 4 > MAX_NOTE_BYTES) {
      toast(t('notes.tooBigToSplit'), 'error')
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
