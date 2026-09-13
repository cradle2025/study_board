/**
 * 文档大纲：从 Markdown 里抽出标题层级。
 *
 * 单独一个模块，是因为**两个地方要用同一份解析**：
 * 侧边的大纲面板拿它画树，编辑器拿它做「点标题跳过去」。
 * 各写一份的话，面板里能点到的标题和实际跳到的位置迟早对不上，
 * 而这种错位极难察觉——用户只会觉得「点了一下，跳到别的地方去了」。
 */

export interface OutlineItem {
  /** 标题级别：1 = `#`，2 = `##`，依此类推 */
  level: number
  /** 标题文字（已去掉结尾的 `#`） */
  text: string
  /** 在正文里的**行号**（从 0 开始）。Markdown 模式靠它定位 */
  line: number
  /** 在整份文档里的序号（从 0 开始，跨级别统一计数）。富文本模式靠它定位 */
  index: number
}

/**
 * 解析标题。
 *
 * 两件必须做对的事：
 *
 * 1. **跳过代码块**。用户完全可能写一篇讲 Markdown 语法的笔记，
 *    正文里就有一行 `# 这是一级标题`。它是被 ``` 包起来的示例，
 *    不该出现在大纲里——点过去会跳到一段代码中间，非常莫名其妙。
 *
 * 2. **上限到 6 级**。标准 Markdown 就只有 6 级，`#######` 不是标题。
 */
export function parseHeadings(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = markdown.split('\n')
  let fence: string | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''

    // 围栏代码块：``` 或 ~~~ 开头，且结尾那串长度不能少于开头
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!heading) continue
    const level = (heading[1] ?? '').length
    // 去掉结尾那串可选的 `#`（`## 标题 ##` 是合法写法）
    const text = (heading[2] ?? '').replace(/\s*#+\s*$/, '').trim()
    // 空标题（光写了一个 `#`）不进大纲：它没有可点的文字
    if (text.length === 0) continue

    items.push({ level, text, line: i, index: items.length })
  }

  return items
}

/**
 * 每一项的父项下标（-1 表示没有父项，即顶层）。
 *
 * 用栈做：遇到更深的级别就压栈，遇到同级或更浅的就弹到合适的位置。
 * 这样 `#` → `##` → `###` → `##` 能得到正确的父子关系，
 * 而不会因为「跳级」（`#` 直接到 `###`）就断掉。
 */
export function outlineParents(items: readonly OutlineItem[]): number[] {
  const parents: number[] = []
  const stack: number[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (!item) continue
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const topItem = top === undefined ? undefined : items[top]
      if (topItem && topItem.level < item.level) break
      stack.pop()
    }
    parents.push(stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1)
    stack.push(i)
  }
  return parents
}
