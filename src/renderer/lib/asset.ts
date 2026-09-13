/**
 * 本地资源地址的唯一拼装处。
 *
 * 渲染层的 CSP 是 `default-src 'none'`，图片能显示全靠 `sb-asset:` 这一个
 * 被显式放行的协议。既然是唯一入口，拼法就该只有一份——
 * 以前它藏在 `timetable-panel.ts` 里，等笔记里也要显示图片时，
 * 第二份实现几乎一定会漏掉某段路径的编码。
 *
 * 编码规则：**逐段 encodeURIComponent，而不是整串编**。
 * 整串编码会把 `/` 也变成 `%2F`，而主进程那边 `decodeURIComponent` 之后
 * 拿到的是一整个没有分隔符的字符串，`safeJoin` 就没法按层级解析了。
 */

/** `sb-asset://<桶>/<相对路径>`。路径按 `/` 分段，每段单独编码 */
export function assetUrl(bucket: string, relativePath: string): string {
  return `sb-asset://${bucket}/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

/** 资料库在笔记库里的目录名，与主进程 `MATERIALS_DIRNAME` 必须一致 */
const MATERIALS_DIR = 'attachments'

/**
 * 一篇笔记里引用某份资料时的地址。
 *
 * 桶选 `notes` 而不是新开一个 `materials`：`notes` 桶的根就是笔记库根目录，
 * `attachments/` 是它的子目录，天然可达。多开一个桶只为了让路径短一点，
 * 却要在主进程那边多维护一份「桶 → 目录」的映射，不值。
 */
export function materialAssetUrl(fileName: string): string {
  return assetUrl('notes', `${MATERIALS_DIR}/${fileName}`)
}

/**
 * 把 .md 里写的图片地址换成渲染层能加载的地址。
 *
 * 笔记里存的是**相对路径**（`attachments/高数笔记.png`），这是刻意的：
 * 同一份 .md 拿到 Obsidian 里打开时，相对路径才是通的。
 * 但本应用的渲染层是 `file://…/out/renderer/index.html`，
 * 相对路径会以渲染层所在目录为基准去解析，必然找不到。
 * 所以显示时把它接到 `notes` 桶上——那个桶的根就是笔记库根目录。
 *
 * 已经是绝对地址的一律不动：
 *  - `http(s):` 交给 CSP 去挡（`img-src` 不含它们，本来就加载不出来，
 *    这是「不联网」这条硬约束在图片上的体现，不该在这里偷偷放行）；
 *  - `data:` / `blob:` / `sb-asset:` 都是调用方自己拼好的，原样放行。
 */
export function noteImageSrc(src: string): string | null {
  const raw = src.trim()
  if (raw.length === 0) return null
  // 带协议头（含 `//host` 这种协议相对写法）的一律不动
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null
  // 绝对路径同样不动：笔记库里的引用不该长这样，放行只会掩盖上游的错
  if (raw.startsWith('/') || raw.startsWith('\\')) return null

  // 去掉 `./` 前缀，剩下的按笔记库根目录解析（与 Obsidian 的库内相对路径一致）
  const clean = raw.replace(/^\.\//, '')
  if (clean.length === 0) return null
  return assetUrl('notes', clean)
}

/**
 * `noteImageSrc` 的**逆运算**：把 `sb-asset://notes/...` 还原成库内相对路径。
 *
 * 必须有这个逆运算，否则富文本模式会把笔记写坏：
 * 打开时相对路径被换成了 `sb-asset://notes/attachments/x.png`（为了能显示），
 * 存盘时 turndown 原样写回去，于是磁盘上的 .md 里躺着一个自定义协议地址——
 * 笔记库拿到 Obsidian 里打开就全是破图，而且应用换个数据目录也会失效。
 *
 * 返回 null 表示这个地址不是我们换出来的（网图、data:、外部协议），
 * 调用方应保持原样。
 */
export function noteImageSrcToPath(src: string): string | null {
  const match = /^sb-asset:\/\/notes\/(.+)$/i.exec(src.trim())
  const rest = match?.[1]
  if (!rest) return null
  try {
    // 逐段解码，与拼装时逐段编码对称
    return rest.split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return null
  }
}
