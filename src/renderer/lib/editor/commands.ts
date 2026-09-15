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
  | 'image'
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
  /**
   * 插入一张图片。`src` 是**笔记库内的相对路径**（`attachments/x.png`）。
   *
   * 为什么要单开一个方法而不是让调用方 `insertText('![alt](src)')`：
   * 富文本模式下那串语法会被当成**普通文字**插进去，用户看到的是一行
   * `![...](...)` 而不是图。两个编辑器对「插入一张图」的内部表示本来就不同
   * （Markdown 是一段语法，富文本是一个 image 节点），
   * 把差异收在各自的实现里，调用方只需要说「插这张图」。
   */
  insertImage(src: string, alt: string): boolean
  /**
   * 跳到第 `index` 个标题（按文档顺序，跨级别统一计数，从 0 开始）。
   *
   * 用**序号**而不是文字来定位，是因为同名标题完全合法
   * （一篇笔记里两个「小结」很正常），按文字找永远只会跳到第一个。
   * 返回 false 表示这个序号超出了当前文档的标题数。
   */
  revealHeading(index: number): boolean
  focus(): void
  destroy(): void
  /** 执行命令；返回 false 表示这个编辑器不支持它 */
  run(command: EditorCommand): boolean
  /** 命令当前是否处于激活态，用于工具栏高亮 */
  isActive(command: EditorCommand): boolean
}

export interface ToolbarItem {
  command: EditorCommand
  /**
   * 按钮上的字，尽量短——工具栏一行放得下十几个按钮。
   *
   * 大多数是**图标字形**（↶ / B / H1 / ¶），两种语言下都一样，所以不翻。
   * 少数几个是**文字**（+行 / +列 / −表），那类走 `labelKey`。
   */
  label: string
  /** 文字型按钮的文案 key；有它时优先用它，`label` 留空 */
  labelKey?: string
  titleKey: string
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
  { command: 'undo', label: '↶', titleKey: 'editor.undo', group: 0 },
  { command: 'redo', label: '↷', titleKey: 'editor.redo', group: 0 },

  { command: 'bold', label: 'B', titleKey: 'editor.bold', group: 1 },
  { command: 'italic', label: 'I', titleKey: 'editor.italic', group: 1 },
  { command: 'strike', label: 'S', titleKey: 'editor.strike', group: 1 },
  { command: 'code', label: '‹›', titleKey: 'editor.code', group: 1 },
  { command: 'underline', label: 'U', titleKey: 'editor.underline', group: 1, richOnly: true },
  { command: 'highlight', label: '▨', titleKey: 'editor.highlight', group: 1, richOnly: true },
  { command: 'link', label: '🔗', titleKey: 'editor.link', group: 1 },
  {
    command: 'image',
    label: '🖼',
    titleKey: 'editor.image',
    group: 1
  },

  { command: 'h1', label: 'H1', titleKey: 'editor.h1', group: 2 },
  { command: 'h2', label: 'H2', titleKey: 'editor.h2', group: 2 },
  { command: 'h3', label: 'H3', titleKey: 'editor.h3', group: 2 },
  { command: 'paragraph', label: '¶', titleKey: 'editor.paragraph', group: 2 },

  { command: 'bulletList', label: '•', titleKey: 'editor.bulletList', group: 3 },
  { command: 'orderedList', label: '1.', titleKey: 'editor.orderedList', group: 3 },
  { command: 'blockquote', label: '❝', titleKey: 'editor.blockquote', group: 3 },
  { command: 'codeBlock', label: '{ }', titleKey: 'editor.codeBlock', group: 3 },
  { command: 'hr', label: '—', titleKey: 'editor.hr', group: 3 },

  { command: 'table', label: '▦', titleKey: 'editor.table', group: 4 },
  { command: 'tableRow', label: '', labelKey: 'editor.tableRow.short', titleKey: 'editor.tableRow', group: 4, richOnly: true },
  { command: 'tableCol', label: '', labelKey: 'editor.tableCol.short', titleKey: 'editor.tableCol', group: 4, richOnly: true },
  { command: 'tableDelete', label: '', labelKey: 'editor.tableDelete.short', titleKey: 'editor.tableDelete', group: 4, richOnly: true },

  { command: 'alignLeft', label: '⇤', titleKey: 'editor.alignLeft', group: 5, richOnly: true },
  { command: 'alignCenter', label: '⇹', titleKey: 'editor.alignCenter', group: 5, richOnly: true },
  { command: 'alignRight', label: '⇥', titleKey: 'editor.alignRight', group: 5, richOnly: true }
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
  richtext: 'editor.mode.richtext'
}

export const MODE_HINT: Record<EditorMode, string> = {
  markdown: 'editor.mode.markdownHint',
  richtext: 'editor.mode.richtextHint'
}
