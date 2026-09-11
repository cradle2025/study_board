import TurndownService from 'turndown'

import { markdownToHtml } from '@shared/markdown'

/**
 * Markdown ↔ HTML 的互转。
 *
 * 这是双模式编辑器的枢纽：磁盘上**永远只有一份 .md 源文件**，
 * 富文本模式显示的是它转出来的 HTML，存盘时再转回去。
 * 两份数据各存一份看着省事，但一旦不一致，用户根本无从判断哪份是对的。
 *
 * Markdown → HTML 那半边的解析器**不在这里**：它被导出功能复用了，
 * 所以搬到了 `@shared/markdown`，两处共用同一份配置。
 * 这一侧只负责反向的 HTML → Markdown（只有编辑器需要）。
 *
 * `html: true` 的安全性说明见 `@shared/markdown` —— 靠 CSP 与分层防御，
 * 而不是过滤 HTML。
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  // `<br>` 统一成单个换行。turndown 默认会写成「行尾两个空格」的硬换行，
  // 那会把源文件弄得全是看不见的尾随空格，而且往返一次就漂一次
  br: '\n'
})

/* ------------------------------------------------------------ 表格的往返 */

/**
 * 表头单元格判定。
 *
 * 刻意**不用 turndown-plugin-gfm**：它判定表头时要求 `<tbody>` 前面
 * 不能有别的兄弟节点，而 TipTap 生成的表格恰好带着一个 `<colgroup>`
 * ——于是整张表格被当作「复杂表格」原样保留成 HTML，存进 .md 里就是一堆标签。
 *
 * 我们的判定简单得多，也更贴近实际：**第一行的格子全是 `<th>` 就算表头**。
 */
function isHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells)
  return cells.length > 0 && cells.every((cell) => cell.tagName === 'TH')
}

/** 单元格内容不能带换行，也不能带裸的竖线——那会把表格切碎 */
function cellText(content: string): string {
  return content
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content, node) => {
    const parent = node.parentNode
    const index =
      parent && parent.childNodes
        ? Array.prototype.indexOf.call(parent.childNodes, node)
        : 0
    const leading = index === 0 ? '| ' : ' '
    return `${leading}${cellText(content)} |`
  }
})

turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content, node) => {
    const row = node as unknown as HTMLTableRowElement
    // 表头行后面要跟一条分隔行，Markdown 才知道这是表头
    const rule = isHeadingRow(row)
      ? `\n| ${Array.from(row.cells)
          .map(() => '---')
          .join(' | ')} |`
      : ''
    return `\n${content}${rule}`
  }
})

turndown.addRule('table', {
  filter: 'table',
  replacement: (content) => `\n\n${content}\n\n`
})

// 删除线：turndown 默认不认 <s>/<del>，不加这条会被当成普通文字，
// 富文本里划掉的线存回 Markdown 就消失了
turndown.addRule('strikethrough', {
  filter: ['del', 's'],
  replacement: (content) => (content.trim().length > 0 ? `~~${content}~~` : '')
})

/**
 * 列表项：turndown 默认写成 `-   文字`（标记后跟三个空格，为了和 `1.  ` 对齐）。
 * 语法上没问题，但用户在 .md 里本来写的是 `- 文字`，
 * 来回切一次模式就变成三个空格——查看 git diff 时全是这种无意义的改动。
 */
turndown.addRule('listItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null
    const index = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0
    const isOrdered = parent?.nodeName === 'OL'
    const start = isOrdered ? Number((parent as HTMLOListElement).start) || 1 : 1
    const prefix = isOrdered ? `${start + index}. ` : `${options.bulletListMarker} `

    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '\n')
      .replace(/\n/gm, '\n    ')

    return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '')
  }
})

// TipTap 给代码块加的是 <pre><code class="language-xxx">，turndown 认不出语言
turndown.addRule('fencedCodeWithLanguage', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    node.firstChild !== null &&
    (node.firstChild as HTMLElement).nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = (node as HTMLElement).firstChild as HTMLElement | null
    if (!code) return ''
    const className = code.getAttribute('class') ?? ''
    const language = /language-([\w-]+)/.exec(className)?.[1] ?? ''
    const text = code.textContent ?? ''
    return `\n\n\`\`\`${language}\n${text.replace(/\n$/, '')}\n\`\`\`\n\n`
  }
})

// 高亮在 GitHub 风味里是 ==文字==，turndown 默认不认
turndown.addRule('highlight', {
  filter: ['mark'],
  replacement: (content) => (content.trim().length > 0 ? `==${content}==` : '')
})

// 下划线在 Markdown 里没有对应语法，退化成加粗——
// 至少让「这里是重点」这个意图留下来，而不是直接丢掉字
turndown.addRule('underline', {
  filter: ['u'],
  replacement: (content) => (content.trim().length > 0 ? `**${content}**` : '')
})

// 转发给「Markdown → HTML」搬到 shared 之后的新位置，让编辑器这边的
// 调用点（richtext-editor）不用关心它到底住在哪一层
export { markdownToHtml }

export function htmlToMarkdown(html: string): string {
  const out = turndown.turndown(html)
  // 转出来常带一串空行，收一下：超过两个连续换行压成一个空行
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim()
}

/**
 * 把一段 Markdown 转成「适合塞进另一个文档」的片段。
 * 比如往笔记里插入 AI 生成的内容时，需要 HTML 而不是完整页面。
 */
export function markdownFragmentToHtml(source: string): string {
  return markdownToHtml(source)
}
