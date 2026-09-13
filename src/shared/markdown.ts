import MarkdownIt from 'markdown-it'

/**
 * Markdown 解析器：**主进程与渲染层共用同一份**。
 *
 * 为什么要共用：这个项目里「Markdown 长什么样」有两个消费者——
 * 富文本编辑器把 .md 转成 HTML 显示，导出又把同一份 .md 转成 HTML / DOCX / PDF。
 * 两处各配一份 markdown-it，任何一个选项漂了，用户就会看到
 * 「编辑器里明明是这样，导出来却是那样」。规则只该有一份，
 * 所以它放在 shared 而不是 renderer。
 *
 * 两个刻意的配置：
 *
 * 1. `html: true` —— 安全**不靠**过滤 HTML 来实现，靠的是分层防御：
 *    渲染层的 CSP 里 `script-src 'self'`（生产不含 unsafe-inline），
 *    内联脚本与事件处理器根本不会执行；导出页则直接**禁用 JavaScript**
 *    并把 CSP 设成 `default-src 'none'`。用黑名单洗 HTML 是洗不干净的。
 *
 * 2. `breaks: true` —— 单个换行也算换行。标准 Markdown 里单换行会被合并，
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
 * linkify 会把 `www.xxx.com` 变成链接，但也会把一些本不是链接的东西
 * （比如 `1.2.3` 这样的版本号）识别成链接。校验一下协议：
 * 只允许 http/https/mailto/锚点，其余的一律还原成纯文本。
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

/** Markdown → HTML 片段（不含 `<html>` 外壳） */
export function markdownToHtml(source: string, options?: MarkdownRenderOptions): string {
  const resolver = options?.resolveImageSrc
  // 通过 markdown-it 的 env 把解析器递进去，而不是改 `md` 这个共享单例：
  // 同一进程里渲染层要把它换成 sb-asset://，导出要把它换成 data:，
  // 改单例会让「上一次调用留下的规则」影响下一次，而且看不出来。
  // env 本来就是 markdown-it 为这类逐次调用数据准备的通道。
  return md.render(source, resolver ? { resolveImageSrc: resolver } : {})
}

/**
 * 图片地址改写器。返回改写后的地址；返回 null 表示保持原样。
 *
 * 存在的原因是**同一份 .md 在不同场景要用不同的地址**：
 *  - 应用里显示：相对路径要变成 `sb-asset://notes/...`，否则渲染层是 file://
 *    加载不到笔记库里的图；
 *  - 导出 HTML / PDF：要内联成 `data:`，否则导出文件换个地方打开就全是破图。
 *
 * 注意这是**渲染期**的改写，磁盘上的 .md 始终写相对路径——
 * 这样笔记库拿到 Obsidian 里打开，图片同样是通的。
 */
export type ImageSrcResolver = (src: string, alt: string) => string | null

export interface MarkdownRenderOptions {
  resolveImageSrc?: ImageSrcResolver
}

/**
 * 默认的 image 规则之外，额外把地址交给改写器过一遍。
 *
 * 不用 `attrSet` 之后自己拼 HTML，而是改完属性继续走 markdown-it 原生的
 * 渲染器——标题、alt 转义、`title` 属性这些细节原生的都处理好了，
 * 自己拼字符串迟早会在某个带引号的 alt 上翻车。
 */
const defaultImageRule =
  md.renderer.rules['image'] ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules['image'] = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const resolver = (env as { resolveImageSrc?: ImageSrcResolver } | null)?.resolveImageSrc
  if (token && resolver) {
    // attrGet 的类型在不同版本的 markdown-it 里是 `string | null` 或 `string | number | null`，
    // 统一 String() 一下，别让类型差异影响行为
    const src = String(token.attrGet('src') ?? '')
    const alt = token.children?.map((child) => String(child.content)).join('') ?? ''
    const resolved = resolver(src, alt)
    if (resolved) token.attrSet('src', resolved)
  }
  return defaultImageRule(tokens, idx, options, env, self)
}

/**
 * 解析成 token 流，给导出 DOCX 用。
 *
 * 这里把 markdown-it 的实例本身放出去，是为了让导出侧能拿到 token 级的结构
 * （DOCX 需要按块级/行内元素层层映射，看 HTML 字符串反而要再解析一遍）。
 * 调用方只应读，不要改它的 renderer 规则——那是一份共享状态。
 */
export function markdownToTokens(source: string): MarkdownToken[] {
  return md.parse(source, {}) as unknown as MarkdownToken[]
}

/**
 * markdown-it 的 token 结构（只声明我们真正用到的字段）。
 *
 * 刻意不从 `markdown-it` 里 import 它的类型：那个包的 .d.ts 是按 ESM 路径
 * 组织的，主进程这边是 CJS 打包，引类型容易在构建期炸掉，
 * 而我们用到的形状就这么几个字段，自己声明一遍更稳。
 */
export interface MarkdownToken {
  type: string
  tag: string
  nesting: number
  content: string
  markup: string
  info: string
  hidden: boolean
  children: MarkdownToken[] | null
  attrGet(name: string): string | null
}
