import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
  rectangularSelection
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

import type { EditorCommand, EditorHandle } from './commands'

/**
 * Markdown 编辑器（CodeMirror 6）。
 *
 * 刻意**不用 `basicSetup`**：那个预设把行号、折叠、自动补全、搜索全都塞进来，
 * 对「写课堂笔记」来说一半用不上。这里按需装配，产物小一截，
 * 以后要加什么也清楚该往哪加。
 *
 * 命令分两类，都按「再点一次取消」来做——这是所有 Markdown 编辑器的肌肉记忆：
 *  - **行内包裹**（加粗、斜体、行内代码）：在选区两侧插记号；
 *  - **行前缀**（标题、列表、引用）：切换行首记号，同类记号先清掉再加，
 *    所以 H1 → H2 是替换而不是叠成 `## # 标题`。
 *
 * 多光标只处理主选区。笔记编辑场景下多光标是极少数情况，
 * 为它把每个动作都写成多选区映射，代码会难读得多，收益却很小。
 */

export interface MarkdownEditorOptions {
  value: string
  placeholder?: string
  /** 文档内容变化时回调（只关心内容变化，光标移动不触发） */
  onChange(): void
}

/* ---------------------------------------------------------------- 高亮样式 */

/**
 * 高亮配色走 CSS 变量，好处是**主题切换不需要重建编辑器**——
 * HighlightStyle 生成的样式表里写的是 `var(--md-xxx)`，
 * 变量在哪个主题下解析成什么颜色由 base.css 决定。
 * 用 Compartment 动态换主题也能做到，但那是为了一个纯展示问题付出的复杂度。
 */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--md-dim)' },
  {
    tag: tags.monospace,
    color: 'var(--md-code)',
    background: 'var(--md-code-bg)',
    padding: '1px 3px',
    borderRadius: '3px'
  },
  { tag: tags.heading1, fontWeight: '700', color: 'var(--md-heading)' },
  { tag: tags.heading2, fontWeight: '700', color: 'var(--md-heading)' },
  { tag: tags.heading3, fontWeight: '600', color: 'var(--md-heading)' },
  { tag: tags.heading4, fontWeight: '600', color: 'var(--md-heading)' },
  { tag: tags.heading5, fontWeight: '600', color: 'var(--md-heading)' },
  { tag: tags.heading6, fontWeight: '600', color: 'var(--md-heading)' },
  { tag: tags.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-link)' },
  { tag: tags.list, color: 'var(--md-marker)' },
  { tag: tags.contentSeparator, color: 'var(--md-dim)' },
  { tag: tags.processingInstruction, color: 'var(--md-marker)' }
])

/* ---------------------------------------------------------------- 编辑动作 */

/** 在选区两侧插入记号；已经包着就去掉 */
function toggleWrap(view: EditorView, before: string, after: string): boolean {
  const { state } = view
  const range = state.selection.main
  const outerBefore = state.sliceDoc(Math.max(0, range.from - before.length), range.from)
  const outerAfter = state.sliceDoc(
    range.to,
    Math.min(state.doc.length, range.to + after.length)
  )

  if (outerBefore === before && outerAfter === after) {
    view.dispatch({
      changes: [
        { from: range.from - before.length, to: range.from },
        { from: range.to, to: range.to + after.length }
      ],
      // 这两个位置都是**新文档**里的坐标
      selection: EditorSelection.range(range.from - before.length, range.to - before.length)
    })
  } else {
    view.dispatch({
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after }
      ],
      selection: EditorSelection.range(range.from + before.length, range.to + before.length)
    })
  }
  view.focus()
  return true
}

/**
 * 切换行首记号。
 *
 * 三个参数各管一件事，缺一不可：
 *  - `strip`  把「任何同类前缀」去掉，用于替换（H1 → H2 时得先把 `# ` 摘掉）；
 *  - `render` 把去掉前缀的正文变成目标形态；
 *  - `isTarget` 判断这一行**是不是已经是目标形态**，只有它是，才轮到"取消"。
 *
 * 第三个别省。一开始我只判断"有没有任意标题前缀"，结果在一级标题上点 H2，
 * 它把 `# ` 摘掉变成了普通段落——用户想要的显然是「换成二级标题」。
 * 判断得精确到目标本身，取消和替换才分得清。
 */
function toggleLinePrefix(
  view: EditorView,
  render: (stripped: string) => string,
  strip: RegExp,
  isTarget: (text: string) => boolean
): boolean {
  const { state } = view
  const range = state.selection.main
  const startLine = state.doc.lineAt(range.from)
  const endLine = state.doc.lineAt(range.to)

  const lines = []
  for (let n = startLine.number; n <= endLine.number; n += 1) lines.push(state.doc.line(n))

  const allTarget = lines.every((line) => isTarget(line.text))

  const changes = lines.map((line) => {
    const stripped = line.text.replace(strip, '')
    return {
      from: line.from,
      to: line.to,
      insert: allTarget ? stripped : render(stripped)
    }
  })

  // 不手动指定 selection：纯插入/删除时 CodeMirror 会把光标映射到合理位置
  view.dispatch({ changes })
  view.focus()
  return true
}

const HEADING_PATTERN = /^#{1,6}\s+/
const BULLET_PATTERN = /^[-*+]\s+/
const ORDERED_PATTERN = /^\d+\.\s+/
const QUOTE_PATTERN = /^>\s?/
const TASK_PATTERN = /^[-*+]\s+\[[ xX]\]\s+/

function setHeading(view: EditorView, level: number): boolean {
  const marks = '#'.repeat(level)
  return toggleLinePrefix(
    view,
    (stripped) => `${marks} ${stripped.trimStart()}`,
    HEADING_PATTERN,
    // 精确到"就是这个级别"，所以在 H1 上点 H2 是替换，在 H2 上点 H2 才是取消
    (text) => new RegExp(`^#{${level}}\\s`).test(text)
  )
}

/** 在块级位置插入一段固定文本，并把光标放到内容里 */
function insertBlock(view: EditorView, text: string, cursorOffset: number): boolean {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  // 块级内容要独占一行：光标不在空行时先补一个空行
  const needsBreak = line.text.trim().length > 0
  const insert = `${needsBreak ? '\n\n' : ''}${text}`
  const offset = needsBreak ? insert.length - text.length + cursorOffset : cursorOffset

  view.dispatch({
    changes: { from: range.from, insert },
    selection: EditorSelection.cursor(range.from + offset)
  })
  view.focus()
  return true
}

export function createMarkdownEditor(options: MarkdownEditorOptions): EditorHandle {
  const element = document.createElement('div')
  element.className = 'sb-md'

  const view = new EditorView({
    parent: element,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        closeBrackets(),
        highlightSelectionMatches(),
        highlightActiveLine(),
        syntaxHighlighting(markdownHighlight, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        EditorView.lineWrapping,
        cmPlaceholder(options.placeholder ?? ''),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange()
        })
      ]
    })
  })

  function run(command: EditorCommand): boolean {
    switch (command) {
      case 'undo':
        return undo(view)
      case 'redo':
        return redo(view)
      case 'bold':
        return toggleWrap(view, '**', '**')
      case 'italic':
        return toggleWrap(view, '*', '*')
      case 'strike':
        return toggleWrap(view, '~~', '~~')
      case 'code':
        return toggleWrap(view, '`', '`')
      case 'h1':
        return setHeading(view, 1)
      case 'h2':
        return setHeading(view, 2)
      case 'h3':
        return setHeading(view, 3)
      case 'paragraph':
        // 「正文」= 去掉标题前缀；本来就不是标题时不算命中，避免点了还把内容动了
        return toggleLinePrefix(
          view,
          (stripped) => stripped.trimStart(),
          HEADING_PATTERN,
          (text) => !HEADING_PATTERN.test(text)
        )
      case 'bulletList':
        return toggleLinePrefix(
          view,
          (stripped) => `- ${stripped}`,
          BULLET_PATTERN,
          // 统一用 `-`：`*` 和 `+` 也算无序列表，点一下会被规范成 `-`
          (text) => /^-\s+/.test(text)
        )
      case 'orderedList':
        return toggleLinePrefix(
          view,
          (stripped) => `1. ${stripped}`,
          ORDERED_PATTERN,
          (text) => ORDERED_PATTERN.test(text)
        )
      case 'blockquote':
        return toggleLinePrefix(
          view,
          (stripped) => `> ${stripped}`,
          QUOTE_PATTERN,
          (text) => QUOTE_PATTERN.test(text)
        )
      case 'codeBlock':
        return insertBlock(view, '```\n\n```', 4)
      case 'hr':
        return insertBlock(view, '---\n', 4)
      case 'link':
        return toggleWrap(view, '[', '](https://)')
      case 'table':
        // 光标落在第一个表头单元格里，用户直接打字就能填
        return insertBlock(view, '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', 2)
      default:
        // 下划线 / 高亮 / 对齐这些 Markdown 表达不了的，工具栏已经禁用了；
        // 万一被调到也直接拒绝，而不是假装成功
        return false
    }
  }

  function isActive(command: EditorCommand): boolean {
    const { state } = view
    const range = state.selection.main
    const line = state.doc.lineAt(range.from)
    const around = (marker: string): boolean =>
      state.sliceDoc(Math.max(0, range.from - marker.length), range.from) === marker &&
      state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length)) === marker

    switch (command) {
      case 'bold':
        return around('**')
      case 'italic':
        return around('*') && !around('**')
      case 'strike':
        return around('~~')
      case 'code':
        return around('`')
      case 'h1':
        return /^#\s/.test(line.text)
      case 'h2':
        return /^##\s/.test(line.text)
      case 'h3':
        return /^###\s/.test(line.text)
      case 'bulletList':
        return BULLET_PATTERN.test(line.text) && !TASK_PATTERN.test(line.text)
      case 'orderedList':
        return ORDERED_PATTERN.test(line.text)
      case 'blockquote':
        return QUOTE_PATTERN.test(line.text)
      default:
        return false
    }
  }

  return {
    element,
    mode: 'markdown',
    getMarkdown: () => view.state.doc.toString(),
    setMarkdown(md) {
      // 内容真的一样就别 dispatch：否则每次切模式都会白白清掉撤销历史
      if (view.state.doc.toString() === md) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: md } })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    run,
    isActive
  }
}
