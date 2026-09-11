import { nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

import { markdownToTokens, type MarkdownToken } from '@shared/markdown'

import { BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'

/**
 * Markdown → DOCX。
 *
 * 为什么是「遍历 token」而不是「先转 HTML 再找库把 HTML 塞进 docx」：
 * 后者的中间产物是一串标签，docx 那边只能整段当富文本贴进去，
 * 标题不会再是「标题样式」——在 Word 里打不开导航窗格，也无法自动生成目录。
 * 直接把 markdown-it 的 token 映射成 docx 的段落/表格，导出的才是一份
 * 真正意义上的 Word 文档，而不是「看起来像 Word 的一张图片」。
 *
 * 几个刻意的取舍：
 *
 *  - **不设文档级字体**。指定 "微软雅黑" 在 Windows 上好看，到了 macOS
 *    就是方块或回退得很难看；让 Word 用它自己的模板默认字体（西文 Calibri +
 *    中文跟随系统），两边都自然。只有代码块显式要等宽。
 *  - **正文原样，标题只进文档属性**。有的笔记正文第一行本身就是 `# 标题`，
 *    再额外顶一个大标题就重复了。标题写进 core properties，
 *    Word 的「属性 → 标题」和文件管理器里都能看到。
 *  - **HTML 块直接跳过**。DOCX 表达不了任意 HTML，硬塞只会得到一堆尖括号。
 */

/** Word 里 1 英寸 = 1440 twips；缩进用 0.25 英寸一档，正好是列表的视觉层级 */
const INDENT_STEP = 360
const MONO_FONT = 'Consolas'

/** 图片在文档里的最大宽度（px）。Word 的页面正文宽约 620px，留出余量 */
const MAX_IMAGE_WIDTH = 480

interface LoadedImage {
  data: Buffer
  width: number
  height: number
}

interface DocxContext {
  /** 笔记库根目录：正文里的相对图片路径按它解析 */
  notesDir: string
  /** 图片按 src 缓存，同一张图在多处引用时只读一次盘 */
  images: Map<string, LoadedImage | null>
}

/* ------------------------------------------------------------------ 行内 */

interface InlineStyle {
  bold: boolean
  italics: boolean
  strike: boolean
}

const BASE_STYLE: InlineStyle = { bold: false, italics: false, strike: false }

function styleOf(style: InlineStyle): {
  bold: boolean
  italics: boolean
  strike: boolean
} {
  return { bold: style.bold, italics: style.italics, strike: style.strike }
}

/**
 * 把一段 Markdown 的 src 解析成可读的本地路径。
 *
 * 只认三种来源：data: URI、file: URL、以及**笔记库目录下的相对路径**。
 * http(s) 一律返回 null —— 导出过程不出网，这是全项目一致的约束，
 * 不能因为「导出一张网图」就破例。
 */
function resolveImagePath(src: string, notesDir: string): string | null {
  const raw = src.trim()
  if (!raw) return null
  if (/^https?:/i.test(raw)) return null

  if (raw.startsWith('data:')) return null // data: 走另一条路，这里只处理文件

  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw)
    } catch {
      return null
    }
  }
  // 去掉可能带的查询串与锚点（`img.png?raw=1`），再解 URL 编码
  const cleaned = raw.split(/[?#]/)[0] ?? ''
  let decoded = cleaned
  try {
    decoded = decodeURIComponent(cleaned)
  } catch {
    /* 编码坏了就按原样用 */
  }
  if (!decoded) return null

  if (isAbsolute(decoded)) return null // 绝对路径一律拒绝：它几乎总是渲染层拼错的东西

  const base = resolve(normalize(notesDir))
  const target = resolve(base, decoded)
  // 越界（`../../etc/passwd` 这种）直接拒掉，与 safeJoin 同一套判据
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 读一张图并统一转成 PNG，顺带拿到尺寸 */
function loadImage(src: string, ctx: DocxContext): LoadedImage | null {
  const cached = ctx.images.get(src)
  if (cached !== undefined) return cached

  let result: LoadedImage | null = null
  try {
    if (src.trim().startsWith('data:')) {
      const match = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/i.exec(src.trim())
      const base64 = match?.[1]
      if (base64) {
        // 统一经 nativeImage 走一遍：既拿到尺寸，也把来源不明的字节
        // 重新编码成 PNG（与门户图标同一套思路：解码重编码能挡掉伪装文件）
        const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
        if (!image.isEmpty()) {
          const size = image.getSize()
          result = { data: image.toPNG(), width: size.width, height: size.height }
        }
      }
    } else {
      const path = resolveImagePath(src, ctx.notesDir)
      if (path) {
        const image = nativeImage.createFromPath(path)
        if (!image.isEmpty()) {
          const size = image.getSize()
          result = { data: image.toPNG(), width: size.width, height: size.height }
        }
      }
    }
  } catch {
    result = null
  }

  ctx.images.set(src, result)
  return result
}

/** 等比缩到最大宽度以内 */
function fitImage(image: LoadedImage): { width: number; height: number } {
  if (image.width <= 0 || image.height <= 0) return { width: MAX_IMAGE_WIDTH, height: 240 }
  if (image.width <= MAX_IMAGE_WIDTH) return { width: image.width, height: image.height }
  const ratio = MAX_IMAGE_WIDTH / image.width
  return { width: MAX_IMAGE_WIDTH, height: Math.max(1, Math.round(image.height * ratio)) }
}

/**
 * 行内 token → 一组 docx 的 run。
 *
 * 链接要单独处理：docx 里超链接是一个**包住若干 run 的容器**，
 * 不能像加粗那样只标个属性，所以要先把 `link_open` 到 `link_close`
 * 之间的 run 收进缓冲区，再整体包一层。
 */
function inlineToRuns(children: MarkdownToken[] | null, ctx: DocxContext): Array<TextRun | ExternalHyperlink | ImageRun> {
  const out: Array<TextRun | ExternalHyperlink | ImageRun> = []
  if (!children) return out

  const linkStack: Array<{ href: string; items: TextRun[] }> = []
  let style: InlineStyle = { ...BASE_STYLE }

  const push = (run: TextRun | ImageRun): void => {
    const top = linkStack[linkStack.length - 1]
    if (top && run instanceof TextRun) top.items.push(run)
    else out.push(run)
  }

  for (const token of children) {
    switch (token.type) {
      case 'text':
        push(new TextRun({ text: token.content, ...styleOf(style) }))
        break

      case 'strong_open':
        style = { ...style, bold: true }
        break
      case 'strong_close':
        style = { ...style, bold: false }
        break
      case 'em_open':
        style = { ...style, italics: true }
        break
      case 'em_close':
        style = { ...style, italics: false }
        break
      case 's_open':
        style = { ...style, strike: true }
        break
      case 's_close':
        style = { ...style, strike: false }
        break

      case 'code_inline':
        push(
          new TextRun({
            text: token.content,
            font: MONO_FONT,
            size: 19,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F3F5' },
            ...styleOf(style)
          })
        )
        break

      // `breaks: true` 下单个换行也是一次真的换行，跟 Obsidian 对齐
      case 'softbreak':
      case 'hardbreak':
        push(new TextRun({ text: '', break: 1 }))
        break

      case 'link_open':
        linkStack.push({ href: token.attrGet('href') ?? '', items: [] })
        break

      case 'link_close': {
        const link = linkStack.pop()
        if (!link) break
        const label = link.items.length > 0 ? link.items : [new TextRun({ text: link.href })]
        if (!/^(https?:|mailto:)/i.test(link.href)) {
          // 不认识的协议就只留文字，别做成一个点了没反应的超链接
          out.push(...label)
          break
        }
        out.push(
          new ExternalHyperlink({
            children: label,
            link: link.href
          })
        )
        break
      }

      case 'image': {
        const src = token.attrGet('src') ?? ''
        const image = loadImage(src, ctx)
        if (image) {
          const size = fitImage(image)
          out.push(
            new ImageRun({
              type: 'png',
              data: image.data,
              transformation: { width: size.width, height: size.height }
            })
          )
        } else if (token.content.trim()) {
          // 读不到就把 alt 文本留下，至少让人知道这里原本有张图
          out.push(new TextRun({ text: `［图片：${token.content.trim()}］`, italics: true, color: '6B7280' }))
        }
        break
      }

      default:
        // html_inline 之类：DOCX 表达不了，安静跳过
        break
    }
  }

  // 理论上不该发生（Markdown 不允许嵌套链接），真发生了也要把内容吐出来
  for (const dangling of linkStack) out.push(...dangling.items)

  return out
}

/* ------------------------------------------------------------------ 块级 */

function headingLevel(tag: string): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (tag) {
    case 'h1':
      return HeadingLevel.HEADING_1
    case 'h2':
      return HeadingLevel.HEADING_2
    case 'h3':
      return HeadingLevel.HEADING_3
    case 'h4':
      return HeadingLevel.HEADING_4
    case 'h5':
      return HeadingLevel.HEADING_5
    default:
      return HeadingLevel.HEADING_6
  }
}

/** 代码块：整块放进一个段落，行与行之间用软换行，保持等宽与原文缩进 */
function codeParagraph(code: string): Paragraph {
  const lines = code.replace(/\n+$/, '').split('\n')
  const runs = lines.map((line, index) =>
    index === 0
      ? new TextRun({ text: line, font: MONO_FONT, size: 19 })
      : new TextRun({ text: line, font: MONO_FONT, size: 19, break: 1 })
  )
  return new Paragraph({
    children: runs,
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F6F7F9' },
    spacing: { before: 120, after: 120 },
    indent: { left: INDENT_STEP / 3, right: INDENT_STEP / 3 }
  })
}

interface ListFrame {
  ordered: boolean
  /** 有序列表的起始序号（Markdown 允许 `3.` 这样从中间开始） */
  start: number
  /** 已经产出过几个条目，用来算序号 */
  count: number
}

/**
 * 列表用「缩进 + 手写标记」实现，而不是 Word 的多级编号定义。
 *
 * 真编号当然更"原生"，但要为每层嵌套建一个 numbering 实例，
 * 一旦文档里嵌套层数不固定，编号定义就得动态生成；而导出的文档
 * 本来就是一次性的阅读稿，标记写成文字完全够用，还绝不会出现
 * 「Word 里重新编号变了个样」这种意外。
 */
function listPrefix(frame: ListFrame, marker: string): string {
  if (!frame.ordered) return `${marker || '•'} `
  const number = frame.start + frame.count
  return `${number}. `
}

export async function renderDocx(title: string, markdown: string, notesDir: string): Promise<Buffer> {
  const ctx: DocxContext = { notesDir, images: new Map() }
  const tokens = markdownToTokens(markdown)
  const blocks: Array<Paragraph | Table> = []

  const listStack: ListFrame[] = []
  /** 引用块深度：段落要缩进并带一条左侧竖线 */
  let quoteDepth = 0
  /** 列表项里的第一段要带标记，后续段落只缩进 */
  let pendingMarker: string | null = null

  // 表格是唯一需要「攒完再吐」的结构，用一个独立的小状态机收集
  let table: { rows: TableRow[]; row: TableCell[]; cell: Array<TextRun | ExternalHyperlink | ImageRun>; header: boolean } | null =
    null

  const indentFor = (): { left?: number; right?: number } => {
    const left = quoteDepth * INDENT_STEP + Math.max(0, listStack.length - 1) * INDENT_STEP
    return left > 0 ? { left } : {}
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[i + 1]
        const runs = inline && inline.type === 'inline' ? inlineToRuns(inline.children, ctx) : []
        blocks.push(
          new Paragraph({
            children: runs.filter((run) => !(run instanceof ImageRun)) as Array<TextRun | ExternalHyperlink>,
            heading: headingLevel(token.tag),
            spacing: { before: 280, after: 120 }
          })
        )
        break
      }

      case 'paragraph_open': {
        const inline = tokens[i + 1]
        const runs = inline && inline.type === 'inline' ? inlineToRuns(inline.children, ctx) : []
        const frame = listStack[listStack.length - 1]
        const marker = pendingMarker
        pendingMarker = null

        // 空段落（例如 `>` 单独一行）在 Word 里应当留出垂直空白
        const children: Array<TextRun | ExternalHyperlink | ImageRun> =
          marker !== null && frame ? [new TextRun({ text: marker }), ...runs] : [...runs]

        // 引用块用「缩进 + 左侧竖线」表达，和 HTML 那边的 blockquote 视觉一致
        blocks.push(
          new Paragraph({
            children: children as Array<TextRun | ExternalHyperlink>,
            spacing: { after: 120 },
            indent: indentFor(),
            ...(quoteDepth > 0
              ? {
                  border: {
                    left: { style: BorderStyle.SINGLE, size: 12, color: 'C9CFD7', space: 8 }
                  }
                }
              : {})
          })
        )
        if (frame) frame.count += 1
        break
      }

      case 'bullet_list_open':
        listStack.push({ ordered: false, start: 1, count: 0 })
        break
      case 'ordered_list_open':
        listStack.push({ ordered: true, start: Number(token.attrGet('start') ?? '1') || 1, count: 0 })
        break
      case 'bullet_list_close':
      case 'ordered_list_close':
        listStack.pop()
        break

      case 'list_item_open': {
        const frame = listStack[listStack.length - 1]
        if (frame) pendingMarker = listPrefix(frame, token.markup || '-')
        break
      }

      case 'blockquote_open':
        quoteDepth += 1
        break
      case 'blockquote_close':
        quoteDepth = Math.max(0, quoteDepth - 1)
        break

      case 'fence':
      case 'code_block':
        blocks.push(codeParagraph(token.content))
        break

      case 'hr':
        blocks.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D8DDE3', space: 1 } },
            spacing: { before: 160, after: 160 }
          })
        )
        break

      /* ---------------------------------------------------------- 表格 */

      case 'table_open':
        table = { rows: [], row: [], cell: [], header: false }
        break
      case 'thead_open':
        if (table) table.header = true
        break
      case 'thead_close':
        if (table) table.header = false
        break
      case 'tr_open':
        if (table) table.row = []
        break
      case 'tr_close':
        if (table && table.row.length > 0) table.rows.push(new TableRow({ children: table.row }))
        break
      case 'th_open':
      case 'td_open': {
        const inline = tokens[i + 1]
        if (table) {
          table.cell = inline && inline.type === 'inline' ? inlineToRuns(inline.children, ctx) : []
        }
        break
      }
      case 'th_close':
      case 'td_close': {
        if (!table) break
        const header = token.type === 'th_close'
        table.row.push(
          new TableCell({
            children: [
              new Paragraph({
                children: table.cell.filter((run) => !(run instanceof ImageRun)) as Array<TextRun | ExternalHyperlink>,
                spacing: { before: 40, after: 40 }
              })
            ],
            shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F4F7' } : undefined
          })
        )
        table.cell = []
        break
      }
      case 'table_close':
        if (table && table.rows.length > 0) {
          blocks.push(
            new Table({
              rows: table.rows,
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' },
                left: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' },
                right: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' },
                insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D8DDE3' }
              }
            })
          )
        }
        table = null
        break

      default:
        break
    }
  }

  // 正文为空时给一段占位，否则 Word 打开是一张完全空白的纸，看着像导出失败了
  if (blocks.length === 0) blocks.push(new Paragraph({ children: [new TextRun({ text: '' })] }))

  const doc = new Document({
    title,
    description: '由学习看板 StudyBoard 导出',
    sections: [{ properties: {}, children: blocks }]
  })

  return Packer.toBuffer(doc)
}
