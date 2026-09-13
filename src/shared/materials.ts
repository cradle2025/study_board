/**
 * 课程资料的共用规则：类型白名单、魔数校验、目录约定。
 *
 * 单开一个文件而不是塞进 types/limits：这里除了类型还有**规则**——
 * 哪些扩展名算资料、每种扩展名要求文件头长什么样、收件箱与回收站叫什么名字。
 * 这些规则主进程（导入校验、收件箱监控）和渲染层（对话框里的类型提示、
 * 拒收原因的人话文案）都要用，各写一份迟早漂。
 */

/** 文档类资料：课件（pdf/ppt）、文档（doc）、表格（xls） */
export const DOCUMENT_EXTENSIONS = ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'] as const

/**
 * 图片类资料。
 *
 * 挑的都是 **Chromium 认得的**格式——理由很实际：资料网格要显示缩略图，
 * 而缩略图就是一张 `<img>`。收录一个浏览器渲染不了的格式，用户会看到
 * 一排永远加载不出来的破图，比不收还糟。
 *
 * HEIC / HEIF 是这条规则的**唯一例外**，但它在导入时就被转成 JPEG 了，
 * 所以落盘之后库里并不存在 .heic 文件。见 `CONVERT_ON_IMPORT`。
 *
 * 刻意**不收 SVG**：
 *  - 它是文本，没有可靠的魔数——只能靠「开头像不像 XML」来猜，
 *    那等于把「文件头才是出身」这条防线拆掉（本文件下半部分全是讲这个的）；
 *  - 资料是拿 `shell.openPath` 用系统默认程序打开的，.svg 会落到浏览器里，
 *    而 SVG 是少数能内嵌脚本的图片格式。收它就是把一个执行面带进库。
 *  课程资料里也基本见不到 SVG，不差这一个。
 */
export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'heic',
  'heif'
] as const

/** 支持的资料类型：文档 + 图片 */
export const MATERIAL_EXTENSIONS = [
  ...DOCUMENT_EXTENSIONS,
  ...IMAGE_EXTENSIONS
] as const

export type MaterialExtension = (typeof MATERIAL_EXTENSIONS)[number]

export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

export function isMaterialExtension(value: unknown): value is MaterialExtension {
  return (
    typeof value === 'string' &&
    (MATERIAL_EXTENSIONS as readonly string[]).includes(value.toLowerCase())
  )
}

/**
 * 这些图片 Chromium 解不了，**导入时就转码**，库里的文件一律是转好的格式。
 *
 * 不转的话后果是具体的：文件安安静静躺在库里，缩略图永远转圈，
 * 用户以为是自己导入坏了。转成 JPEG 之后它就是一个正常能看的资料，
 * 代价只是文件名后缀变了（这一点在 `MATERIAL_KIND_LABEL` 里如实写明）。
 *
 * 只转这两种。PNG / JPEG / GIF 这些本来就正常，**原样复制**——
 * 转一遍既丢画质又丢透明通道，还会让「库里就是用户那份文件」这件事不成立。
 */
export const CONVERT_ON_IMPORT: ReadonlySet<string> = new Set(['heic', 'heif'])

export function isImageExtension(value: unknown): value is ImageExtension {
  return typeof value === 'string' && (IMAGE_EXTENSIONS as readonly string[]).includes(value.toLowerCase())
}

/** 类型的人话标签，界面上显示「PDF 文档」而不是干巴巴的扩展名 */
export const MATERIAL_KIND_LABEL: Record<MaterialExtension, string> = {
  pdf: 'PDF 文档',
  ppt: 'PPT 演示（旧版）',
  pptx: 'PPT 演示',
  doc: 'Word 文档（旧版）',
  docx: 'Word 文档',
  xls: 'Excel 表格（旧版）',
  xlsx: 'Excel 表格',
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  jpeg: 'JPEG 图片',
  gif: 'GIF 图片',
  webp: 'WebP 图片',
  bmp: 'BMP 图片',
  avif: 'AVIF 图片',
  // 这两种会被转码，标签里说清楚——否则用户会发现「我导的 heic 怎么变 jpg 了」
  heic: 'HEIC 图片（导入时转为 JPEG）',
  heif: 'HEIF 图片（导入时转为 JPEG）'
}

/**
 * 一条魔数判据：从文件第 `offset` 个字节开始，命中 `oneOf` 里任意一个字节串即通过。
 *
 * 为什么要 offset：有些格式的识别特征不在文件开头。
 *  - WebP 是 `RIFF????WEBP`，第 4~7 字节是长度，真正的格式标记在偏移 8；
 *  - HEIF/AVIF 是 ISO-BMFF 容器，开头 4 字节是 box 长度，偏移 4 才是 `ftyp`，
 *    偏移 8 才是品牌名。
 * 只看前几个字节的话，这两种格式根本认不出来。
 */
export interface MagicSignature {
  offset: number
  oneOf: readonly string[]
}

/**
 * 每种扩展名允许的文件头（魔数）。
 *
 * 扩展名是「自称」，谁都能改；文件头才是「出身」。
 * 校验放在导入闸口，挡掉伪装成课件的东西——与门户图标
 * 「字节必须经 Chromium 解码重编码」是同一个思路：不信任自称。
 *
 * **结构是「外层数组取或，内层数组取且」**：
 *  - 外层：这个扩展名可以有多种合法的头部写法（比如 GIF 有 87a / 89a 两版）；
 *  - 内层：同一种写法里的多个条件必须**同时**成立
 *    （WebP 要 `RIFF` 在 0 且 `WEBP` 在 8，只满足一半的不是 WebP）。
 */
export const MATERIAL_MAGIC: Record<MaterialExtension, readonly (readonly MagicSignature[])[]> = {
  // `%PDF-`
  pdf: [[{ offset: 0, oneOf: ['%PDF-'] }]],
  // 新版 Office（docx/pptx/xlsx）本质是 zip 容器 → `PK\x03\x04`
  docx: [[{ offset: 0, oneOf: ['PK\x03\x04'] }]],
  pptx: [[{ offset: 0, oneOf: ['PK\x03\x04'] }]],
  xlsx: [[{ offset: 0, oneOf: ['PK\x03\x04'] }]],
  // 旧版 Office（doc/ppt/xls）是 OLE2 复合文档 → `D0 CF 11 E0 …`
  doc: [[{ offset: 0, oneOf: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'] }]],
  ppt: [[{ offset: 0, oneOf: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'] }]],
  xls: [[{ offset: 0, oneOf: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'] }]],

  // PNG 的 8 字节签名，最后那 4 个字节是刻意的：防的就是「文本编辑器把 \n 转成 \r\n」
  png: [[{ offset: 0, oneOf: ['\x89PNG\r\n\x1a\n'] }]],
  // JPEG 以 SOI 标记开头，后面紧跟一个标记的 `\xFF`
  jpg: [[{ offset: 0, oneOf: ['\xFF\xD8\xFF'] }]],
  jpeg: [[{ offset: 0, oneOf: ['\xFF\xD8\xFF'] }]],
  gif: [[{ offset: 0, oneOf: ['GIF87a', 'GIF89a'] }]],
  bmp: [[{ offset: 0, oneOf: ['BM'] }]],
  webp: [[{ offset: 0, oneOf: ['RIFF'] }, { offset: 8, oneOf: ['WEBP'] }]],
  avif: [[{ offset: 4, oneOf: ['ftyp'] }, { offset: 8, oneOf: ['avif', 'avis'] }]],
  // HEIF 的品牌有好几个：手机直出多半是 heic，连续拍摄/多图是 msf1，
  // mif1 是「符合 HEIF 规范但不指明具体编码」的通用品牌。都放行。
  heic: [
    [
      { offset: 4, oneOf: ['ftyp'] },
      { offset: 8, oneOf: ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'] }
    ]
  ],
  heif: [
    [
      { offset: 4, oneOf: ['ftyp'] },
      { offset: 8, oneOf: ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'] }
    ]
  ]
}

/** 魔数校验需要读的头部字节数。最长的是 HEIF：偏移 8 + 品牌名 4 字节 = 12 */
export const MATERIAL_HEAD_BYTES = 16

/**
 * 扩展名不在白名单时的拒收原因（渲染层与主进程各显示一次，措辞必须一致）。
 *
 * 类型多到十几个之后，逐个数出来会变成一行读不完的东西，所以按大类说。
 * 用户真正需要的不是完整清单，而是「我拖的这个能不能进、不能进该换成什么」。
 */
export function materialRejectReason(rawName: string): string {
  const dot = rawName.lastIndexOf('.')
  const ext = dot >= 0 ? rawName.slice(dot + 1).toLowerCase() : ''
  if (ext.length === 0) return '无法识别的文件类型'
  return `不支持的类型 .${ext}（支持 PDF / PPT / Word / Excel，以及 PNG / JPG / GIF / WebP / BMP / AVIF / HEIC 图片）`
}

/** 资料在笔记库里的存放目录（跟笔记库走，Obsidian 原生能预览 PDF 和图片） */
export const MATERIALS_DIRNAME = 'attachments'

/**
 * 收件箱的**相对**目录名。
 *
 * 浏览器扩展只能把下载改存到「默认下载目录的子路径」，拿不到应用的数据目录，
 * 所以两边约定的是这个名字：扩展把学校网站的下载建议存到
 * 「下载目录/StudyBoard收件箱/」，应用监控这个子目录。
 * 应用不知道用户的下载目录在哪，因此完整路径在设置里配（空 = 用系统下载目录拼默认值）。
 */
export const MATERIAL_INBOX_DIRNAME = 'StudyBoard收件箱'
