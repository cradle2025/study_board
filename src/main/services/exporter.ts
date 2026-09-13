import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'

import { EXPORT_EXTENSIONS } from '@shared/limits'
import { markdownToHtml } from '@shared/markdown'
import type { ExportFormat, ExportNoteRequest, ExportNoteResult } from '@shared/types'

import { context } from '../context'
import { ensureDir, tempDir } from '../paths'
import { renderDocx } from './exportDocx'
import { renderExportHtml } from './exportHtml'
import { readNoteImageDataUri } from './noteImagePath'
import { safeNoteTitle } from './notes'

/**
 * 笔记导出：Markdown / HTML / DOCX / PDF。
 *
 * 几条贯穿始终的决定：
 *
 * 1. **四种格式导出的都是「正文」，不含 frontmatter**。
 *    `id` / `mode` / 时间戳是应用自己的簿记，导出给别人看时是噪音；
 *    而且四种格式行为一致，用户不用去想「为什么 md 里多了一段奇怪的东西」。
 *    代价是导出的 .md 再放回笔记库会被当成新笔记（重新分配 id），
 *    这符合「导出」而不是「复制」的语义。
 *
 * 2. **标题不塞进正文，只进文件属性**。很多笔记正文第一行本身就是
 *    `# 标题`，再顶一个大标题就重复了。
 *
 * 3. **PDF 不引新依赖**。Electron 自带 Chromium，`printToPDF` 出来的
 *    就是一份版式正确的 A4 文档（HTML 与 PDF 共用同一份 CSS，
 *    「屏幕上什么样、纸上就什么样」不用维护两套）。为此要临时落一个
 *    .html 文件：走 data: URL 的话，两兆的笔记会把 URL 撑爆。
 *    那个隐藏窗口**禁用 JavaScript** —— 正文是按 `html: true` 渲染的，
 *    里面的 `<script>` 会原样进入 HTML，禁掉是最省事的根治办法。
 *
 * 4. **导出过程全程不出网**。HTML 外壳自带 `default-src 'none'` 的 CSP，
 *    DOCX 侧遇到 http(s) 图片直接跳过。这是「应用不联网」这条硬约束
 *    在导出上的延伸。
 */

const DIALOG_FILTERS: Record<ExportFormat, Array<{ name: string; extensions: string[] }>> = {
  md: [{ name: 'Markdown', extensions: ['md'] }],
  html: [{ name: 'HTML 网页', extensions: ['html'] }],
  docx: [{ name: 'Word 文档', extensions: ['docx'] }],
  pdf: [{ name: 'PDF 文档', extensions: ['pdf'] }]
}

/**
 * 校验渲染层给的落盘路径。
 *
 * 渲染层正常不会传这个参数（它走保存对话框），传的只有自动化测试。
 * 即便这样也按不可信数据处理：必须是绝对路径、扩展名必须与格式一致——
 * 否则一个「导出 pdf」的请求就能把任意扩展名的文件写到任意位置。
 */
function resolveTarget(requested: string, format: ExportFormat): string {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 1024) {
    throw new Error('导出路径不合法')
  }
  if (requested.includes('\0')) throw new Error('导出路径包含非法字符')
  if (!isAbsolute(requested)) throw new Error('导出路径必须是绝对路径')

  const expected = EXPORT_EXTENSIONS[format]
  const actual = extname(requested).slice(1).toLowerCase()
  if (actual !== expected) {
    throw new Error(`导出 ${format} 的文件扩展名应为 .${expected}`)
  }

  mkdirSync(dirname(requested), { recursive: true })
  return requested
}

/**
 * 隐藏窗口渲染 HTML 并打印成 PDF。
 *
 * 走文件而不是 data: URL；窗口的 webPreferences 把能关的都关掉：
 * 无 preload、无 Node、无 JS、contextIsolation 打开。
 * 渲染这份 HTML 只需要排版引擎，不需要一个能执行脚本的运行时。
 */
async function renderPdf(html: string, target: string): Promise<void> {
  const portable = context().settings.get().portableMode
  const scratch = join(ensureDir(tempDir(portable)), `export-${randomUUID()}.html`)
  writeFileSync(scratch, html, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  try {
    await win.loadFile(scratch)
    // 页边距同时写在 CSS 的 @page 与这里，且数值一致（18mm / 16mm）。
    // 两边谁生效结果都一样，省得去猜 Chromium 这次听谁的
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.71, bottom: 0.71, left: 0.63, right: 0.63 }
    })
    writeFileSync(target, data)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    rmSync(scratch, { force: true })
  }
}

export async function exportNote(request: ExportNoteRequest): Promise<ExportNoteResult> {
  const format = request?.format
  if (!(format in EXPORT_EXTENSIONS)) throw new Error('不支持的导出格式')

  const store = context().notes
  const doc = store.read(request.noteId)
  const base = safeNoteTitle(doc.title)
  const extension = EXPORT_EXTENSIONS[format]
  const markdown = doc.content

  /**
   * HTML 与 PDF 走同一条渲染路径，图片也要用同一种处理：**内联成 data: URI**。
   *
   * 不内联的话导出的是一份到处破图的文件——正文里写的是相对路径
   * （那是为了 Obsidian 里也能用），而导出文件多半会被拷到别处。
   *
   * 缓存按 src 去重：同一张图在正文里引用多次时只读一次盘、只编一次 base64。
   * 一份笔记里同一张图被引用五六次很常见（比如反复贴同一张表）。
   */
  const imageCache = new Map<string, string | null>()
  const resolveImageSrc = (src: string): string | null => {
    const key = src.trim()
    const cached = imageCache.get(key)
    if (cached !== undefined) return cached
    const resolved = readNoteImageDataUri(key, store.dir)
    imageCache.set(key, resolved)
    return resolved
  }

  let target = ''
  if (typeof request.targetPath === 'string' && request.targetPath.length > 0) {
    target = resolveTarget(request.targetPath, format)
  } else {
    const result = await dialog.showSaveDialog({
      title: `导出「${base}」`,
      defaultPath: join(app.getPath('documents'), `${base}.${extension}`),
      filters: DIALOG_FILTERS[format],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (result.canceled || !result.filePath) return { cancelled: true }
    target = result.filePath
  }

  switch (format) {
    case 'md':
      // 正文原样落盘。刻意**不重写 frontmatter**：导出的东西是给人读的
      writeFileSync(target, markdown, 'utf-8')
      break

    case 'html':
      writeFileSync(
        target,
        renderExportHtml(doc.title, markdownToHtml(markdown, { resolveImageSrc })),
        'utf-8'
      )
      break

    case 'docx':
      // DOCX 直接嵌字节，不经过 data: —— 由 exportDocx 自己按相对路径读盘
      writeFileSync(target, await renderDocx(doc.title, markdown, store.dir))
      break

    case 'pdf':
      await renderPdf(
        renderExportHtml(doc.title, markdownToHtml(markdown, { resolveImageSrc })),
        target
      )
      break
  }

  console.info(`[export] 已导出 ${format}：${target}`)
  return { cancelled: false, filePath: target }
}
