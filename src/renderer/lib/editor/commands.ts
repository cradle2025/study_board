/**
 * 两个编辑器共用的命令集合。
 *
 * 需求是「笔记编辑器采用 md 或者 word 格式编辑，用户可自行选择两者其一」——
 * 也就是说同一份笔记可能被两种编辑器打开。**「加粗」在两边的实现完全不同**
 * （Markdown 是往选区两侧插 `**`，富文本是 toggleBold mark），
 * 但对用户来说它是同一个动作。
 *
 * 所以这里定义的是**动作的词汇表**，两个编辑器各自去实现。
 * 工具栏只认这份列表，不需要知道背后是 CodeMirror 还是 TipTap。
 *
 * Markdown 天生表达不了的能力（下划线、高亮、对齐）在 md 模式下会被禁用——
 * 与其假装支持然后在存盘时悄悄丢掉，不如直接不给点。
 */

export type EditorCommand =
  /* 历史 */
  | 'undo'
  | 'redo'
  /* 行内格式 */
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'underline'
  | 'highlight'
  /* 块级 */
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'codeBlock'
  | 'hr'
  /* 插入 */
  | 'link'
  | 'table'
  | 'tableRow'
  | 'tableCol'
  | 'tableDelete'
  /* 对齐 */
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'

export type EditorMode = 'markdown' | 'richtext'

/**
 * 两个编辑器对外的统一形状。
 *
 * 关键约定：**`getMarkdown()` 一律返回 Markdown**。
 * 富文本编辑器内部是 HTML，但它对外也只吐 Markdown——
 * 让「磁盘上只有一份 .md」这件事在类型层面就成立，
 * 调用方不需要知道当前用的是哪个编辑器。
 */
export interface EditorHandle {
  element: HTMLElement
  mode: EditorMode
  getMarkdown(): string
  setMarkdown(md: string): void
  /** 在光标处插入纯文本（选区被替换）。两种编辑器都要支持——「插入资料引用」走这里 */
  insertText(text: string): boolean
  focus(): void
  destroy(): void
  /** 执行命令；返回 false 表示这个编辑器不支持它 */
  run(command: EditorCommand): boolean
  /** 命令当前是否处于激活态，用于工具栏高亮 */
  isActive(command: EditorCommand): boolean
}

export interface ToolbarItem {
  command: EditorCommand
  /** 按钮上的字，尽量短——工具栏一行放得下十几个按钮 */
  label: string
  title: string
  /** 同一组内的按钮挨着放，组与组之间加竖线 */
  group: number
  /** 只在 Markdown 模式下有意义 */
  markdownOnly?: boolean
  /** 只在富文本模式下有意义 */
  richOnly?: boolean
}

/**
 * 工具栏布局。顺序是按「写笔记时的实际使用频率」排的：
 * 加粗、标题、列表最常用，表格和对齐放在后面。
 */
export const TOOLBAR: readonly ToolbarItem[] = [
  { command: 'undo', label: '↶', title: '撤销', group: 0 },
  { command: 'redo', label: '↷', title: '重做', group: 0 },

  { command: 'bold', label: 'B', title: '加粗（Ctrl/⌘ + B）', group: 1 },
  { command: 'italic', label: 'I', title: '斜体（Ctrl/⌘ + I）', group: 1 },
  { command: 'strike', label: 'S', title: '删除线', group: 1 },
  { command: 'code', label: '‹›', title: '行内代码', group: 1 },
  { command: 'underline', label: 'U', title: '下划线（Markdown 不支持，仅富文本）', group: 1, richOnly: true },
  { command: 'highlight', label: '▨', title: '高亮（Markdown 不支持，仅富文本）', group: 1, richOnly: true },
  { command: 'link', label: '🔗', title: '插入链接', group: 1 },

  { command: 'h1', label: 'H1', title: '一级标题', group: 2 },
  { command: 'h2', label: 'H2', title: '二级标题', group: 2 },
  { command: 'h3', label: 'H3', title: '三级标题', group: 2 },
  { command: 'paragraph', label: '¶', title: '正文', group: 2 },

  { command: 'bulletList', label: '•', title: '无序列表', group: 3 },
  { command: 'orderedList', label: '1.', title: '有序列表', group: 3 },
  { command: 'blockquote', label: '❝', title: '引用', group: 3 },
  { command: 'codeBlock', label: '{ }', title: '代码块', group: 3 },
  { command: 'hr', label: '—', title: '分隔线', group: 3 },

  { command: 'table', label: '▦', title: '插入表格', group: 4 },
  { command: 'tableRow', label: '+行', title: '在下方插入一行', group: 4, richOnly: true },
  { command: 'tableCol', label: '+列', title: '在右侧插入一列', group: 4, richOnly: true },
  { command: 'tableDelete', label: '−表', title: '删除当前表格', group: 4, richOnly: true },

  { command: 'alignLeft', label: '⇤', title: '左对齐', group: 5, richOnly: true },
  { command: 'alignCenter', label: '⇹', title: '居中', group: 5, richOnly: true },
  { command: 'alignRight', label: '⇥', title: '右对齐', group: 5, richOnly: true }
]

/** 当前模式下这条命令能不能用 */
export function isCommandAvailable(item: ToolbarItem, mode: EditorMode): boolean {
  if (item.markdownOnly) return mode === 'markdown'
  if (item.richOnly) return mode === 'richtext'
  return true
}

/**
 * 命令的快捷键说明（挂在 title 上给用户看）。
 * 真正的按键绑定在各自的编辑器里——CodeMirror 用 keymap，TipTap 用默认键位。
 */
export const MODE_LABEL: Record<EditorMode, string> = {
  markdown: 'Markdown',
  richtext: '富文本'
}

export const MODE_HINT: Record<EditorMode, string> = {
  markdown: '直接写 Markdown 源码，所见即所得的高亮，格式能力最全',
  richtext: '像 Word 那样编辑，适合不熟悉 Markdown 语法的时候用'
}
