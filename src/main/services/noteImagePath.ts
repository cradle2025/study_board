import { readFileSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIME } from './assetProtocol'

/**
 * 笔记正文里的图片引用，怎么解析成磁盘路径 / 可内联的数据。
 *
 * 单独一个模块，是因为**导出这一条链路上有三个消费者**：HTML、PDF、DOCX。
 * 它们要回答的是同一个问题（`attachments/x.png` 到底是哪个文件），
 * 而这个问题有两个容易写错的点：
 *
 *  1. **路径穿越**。正文是用户自己写的，也可能是从别处粘来的，
 *     `../../../../etc/passwd` 这种必须拒掉。判据与 `safeJoin` 一致。
 *  2. **不出网**。`http(s)` 一律返回 null。这是全项目一致的约束，
 *     不能因为「导出一张网图」就破例——那样导出的 PDF 就成了一次网络请求。
 *
 * 以前这段逻辑只活在 `exportDocx.ts` 里。HTML/PDF 也要处理图片时，
 * 如果各自再写一份，两份的越界判据迟早会漂，而漂的那一份就是漏洞。
 */

/** 内联单张图片的体积上限（8MB）。超过就不内联，宁可显示不出来也不让导出爆掉 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024

/**
 * 把一段 Markdown 里的图片 src 解析成可读的本地路径。
 *
 * 只认三种来源：`file:` URL、以及**笔记库目录下的相对路径**。
 * `data:` 与 `http(s):` 都返回 null —— 前者由调用方走内联那条路，
 * 后者直接放弃。
 */
export function resolveNoteImagePath(src: string, notesDir: string): string | null {
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

/**
 * 把图片读成 `data:` URI，供导出 HTML / PDF 内联。
 *
 * 为什么导出必须内联，而不是像 DOCX 那样直接嵌字节：
 * HTML 导出的是一个**单个文件**，用户会把它拷到别处、发给别人。
 * 若里面写的是相对路径，那份 HTML 一旦离开笔记库就全是破图；
 * 若写 `file://` 绝对路径，换台机器同样失效。
 * 内联成 data: 之后，「导出的 HTML 是一个自包含文件」这句话才成立。
 *
 * 返回 null 表示这张图不内联（网图、越界路径、读不到、非图片、太大）——
 * 调用方应保持原地址不动，让 CSP 去挡，而不是编一个假地址出来。
 */
export function readNoteImageDataUri(src: string, notesDir: string): string | null {
  const raw = src.trim()
  // 已经是内联的就别解出来再编回去
  if (/^data:image\//i.test(raw)) return raw

  const path = resolveNoteImagePath(raw, notesDir)
  if (!path) return null

  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  const mime = MIME[ext]
  // 非图片扩展名不内联：正文里写别的文件类型时，data: URI 也显示不出来，
  // 内联只是白白把文件体积搬进 HTML
  if (!mime || !mime.startsWith('image/')) return null

  try {
    const data = readFileSync(path)
    if (data.length === 0 || data.length > MAX_INLINE_BYTES) return null
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}
