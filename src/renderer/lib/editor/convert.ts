import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'

/**
 * Markdown ↔ HTML 的互转。
 *
 * 这是双模式编辑器的枢纽：磁盘上**永远只有一份 .md 源文件**，
 * 富文本模式显示的是它转出来的 HTML，存盘时再转回去。
 * 两份数据各存一份看着省事，但一旦不一致，用户根本无从判断哪份是对的。
 *
 * 两个刻意的配置：
 *
 * 1. `html: true` —— 安全**不靠**过滤 HTML 来实现，靠的是 CSP。
 *    渲染层的 CSP 里 `script-src 'self'`（生产环境不含 unsafe-inline），
 *    内联脚本和内联事件处理器根本不会执行；`img-src` 也不放行外域，
 *    所以 `<img src="http://…">` 连请求都发不出去。
 *    用黑名单去洗 HTML 是洗不干净的，分层防御才靠谱。
 *
 * 2. `breaks: true` —— 单个换行也算换行。标准 Markdown 里单换行会被合并成一行，
 *    但笔记场景下用户就是习惯一行一件事，而且 Obsidian 默认也是这个行为。
 *    既然笔记库要能直接当 Obsidian 库用，行为就得跟它对齐。
 */

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: false
})

/**
 * linkify 会自动把 `www.xxx.com` 变成链接，但也会把一些本不是链接的东西
 * （比如 `1.2.3` 这样的版本号）识别成链接。校验一下协议：
 * 只允许 http/https/mailto，其余的一律还原成纯文本。
 */
const defaultLinkOpen =
  md.renderer.rules['link_open'] ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules['link_open'] = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const href = String(token?.attrGet('href') ?? '')
  if (!/^(https?:|mailto:|#)/i.test(href)) {
    // 不认识的协议：原样输出文本，不给它变成可点的链接
    token?.attrSet('href', '#')
  }
  token?.attrSet('target', '_blank')
  token?.attrSet('rel', 'noreferrer noopener')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

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

export function markdownToHtml(source: string): string {
  return md.render(source)
}

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
  return md.render(source)
}
