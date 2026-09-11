/**
 * 导出用的 HTML 外壳（HTML 与 PDF 共用）。
 *
 * 两个约束决定了它长这样：
 *
 * 1. **导出页禁用 JavaScript**（见 `exporter.ts` 里创建隐藏窗口的那段），
 *    并且自己带一条 `default-src 'none'` 的 CSP。笔记正文是用户自己的内容，
 *    而且 Markdown 是按 `html: true` 渲染的——里面的 `<script>` 会原样进入
 *    这份 HTML。既然这份文件还会被用户拿出去用浏览器打开，
 *    就不能指望「反正本地文件没人攻击」。
 *    结果是 `img-src` 只放行 data: 与 file:，**外链图片不会加载**：
 *    这是「应用不联网」这条硬约束在导出上的延伸，宁可少显示一张网图。
 *
 * 2. **一份样式同时服务屏幕和打印**。`printToPDF` 用的就是这份 CSS，
 *    所以字号、行高、分页都要按纸来定，不能只在屏幕上看好看。
 *    `@page` 直接给 A4 与页边距，PDF 出来就是一份能直接交的文档。
 */

/** 正文里出现的用户内容一律经这里转义，避免标题里的 `<` 把文档结构咬断 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 打印与屏幕共用的样式。
 *
 * 字体栈刻意把中文放在最前面并保留多级回退：导出不绑定任何字体文件，
 * 走系统字体（与渲染层一致的做法）——这样安装包不会因为塞字体而变大，
 * 也不会因为「用了某个只有 Windows 才有的字体」而在 mac 上变成方块。
 */
const DOC_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  color: #1c1f23;
  background: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
  font-size: 15px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.sb-doc { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
.sb-doc h1, .sb-doc h2, .sb-doc h3, .sb-doc h4, .sb-doc h5, .sb-doc h6 {
  line-height: 1.35; margin: 1.6em 0 0.6em; font-weight: 600;
}
.sb-doc h1 { font-size: 1.9em; margin-top: 0.4em; }
.sb-doc h2 { font-size: 1.5em; border-bottom: 1px solid #e3e6ea; padding-bottom: 0.25em; }
.sb-doc h3 { font-size: 1.25em; }
.sb-doc h4 { font-size: 1.1em; }
.sb-doc p { margin: 0.75em 0; }
.sb-doc a { color: #2b5fd9; text-decoration: none; border-bottom: 1px solid rgba(43, 95, 217, 0.35); }
.sb-doc ul, .sb-doc ol { padding-left: 1.6em; margin: 0.75em 0; }
.sb-doc li { margin: 0.25em 0; }
.sb-doc blockquote {
  margin: 1em 0; padding: 0.2em 1em; color: #4a5057;
  border-left: 3px solid #c9cfd7; background: #f7f8fa;
}
.sb-doc code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.9em; background: #f2f3f5; border-radius: 4px; padding: 0.12em 0.35em;
}
.sb-doc pre {
  background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 6px;
  padding: 12px 14px; overflow-x: auto; page-break-inside: avoid;
}
.sb-doc pre code { background: none; padding: 0; font-size: 0.88em; line-height: 1.6; }
.sb-doc table {
  border-collapse: collapse; width: 100%; margin: 1em 0;
  font-size: 0.94em; page-break-inside: avoid;
}
.sb-doc th, .sb-doc td { border: 1px solid #d8dde3; padding: 6px 10px; text-align: left; vertical-align: top; }
.sb-doc th { background: #f2f4f7; font-weight: 600; }
.sb-doc hr { border: none; border-top: 1px solid #e3e6ea; margin: 2em 0; }
.sb-doc img { max-width: 100%; height: auto; }
.sb-doc mark { background: #fff2a8; }
@page { size: A4; margin: 18mm 16mm; }
@media print {
  body { font-size: 11.5pt; }
  .sb-doc { max-width: none; padding: 0; }
  .sb-doc a { color: inherit; border-bottom: none; }
  .sb-doc pre, .sb-doc blockquote, .sb-doc table { page-break-inside: avoid; }
  .sb-doc h1, .sb-doc h2, .sb-doc h3 { page-break-after: avoid; }
}
`

/**
 * 拼一份完整的、自带样式的 HTML 文档。
 *
 * `body` 必须是已经渲染好的 HTML 片段（来自 markdown-it），调用方负责它的来源可信。
 */
export function renderExportHtml(title: string, body: string): string {
  const policy = [
    "default-src 'none'",
    "img-src data: file: 'self'",
    "style-src 'unsafe-inline'",
    "font-src file: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'"
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${policy}" />
<title>${escapeHtml(title)}</title>
<style>${DOC_STYLE}</style>
</head>
<body>
<article class="sb-doc">
${body}
</article>
</body>
</html>
`
}
