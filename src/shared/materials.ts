/**
 * 课程资料的共用规则：类型白名单、魔数校验、目录约定。
 *
 * 单开一个文件而不是塞进 types/limits：这里除了类型还有**规则**——
 * 哪些扩展名算资料、每种扩展名要求文件头长什么样、收件箱与回收站叫什么名字。
 * 这些规则主进程（导入校验、收件箱监控）和渲染层（对话框里的类型提示、
 * 拒收原因的人话文案）都要用，各写一份迟早漂。
 */

/** 支持的资料类型。学校场景：课件（pdf/ppt）、文档（doc）、表格（xls） */
export const MATERIAL_EXTENSIONS = ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'] as const

export type MaterialExtension = (typeof MATERIAL_EXTENSIONS)[number]

export function isMaterialExtension(value: unknown): value is MaterialExtension {
  return (
    typeof value === 'string' &&
    (MATERIAL_EXTENSIONS as readonly string[]).includes(value.toLowerCase())
  )
}

/** 类型的人话标签，界面上显示「PDF 文档」而不是干巴巴的扩展名 */
export const MATERIAL_KIND_LABEL: Record<MaterialExtension, string> = {
  pdf: 'PDF 文档',
  ppt: 'PPT 演示（旧版）',
  pptx: 'PPT 演示',
  doc: 'Word 文档（旧版）',
  docx: 'Word 文档',
  xls: 'Excel 表格（旧版）',
  xlsx: 'Excel 表格'
}

/**
 * 每种扩展名允许的文件头（魔数）。
 *
 * 扩展名是「自称」，谁都能改；文件头才是「出身」。
 * 校验放在导入闸口，挡掉伪装成课件的东西——与门户图标
 * 「字节必须经 Chromium 解码重编码」是同一个思路：不信任自称。
 *
 *  - pdf  → `%PDF-`
 *  - 新版 Office（docx/pptx/xlsx）本质是 zip 容器 → `PK\x03\x04`
 *  - 旧版 Office（doc/ppt/xls）是 OLE2 复合文档 → `D0 CF 11 E0 …`
 */
export const MATERIAL_MAGIC: Record<MaterialExtension, readonly string[]> = {
  pdf: ['%PDF-'],
  docx: ['PK\x03\x04'],
  pptx: ['PK\x03\x04'],
  xlsx: ['PK\x03\x04'],
  doc: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'],
  ppt: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'],
  xls: ['\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1']
}

/** 魔数校验需要读的头部字节数（OLE2 头 8 字节是最长的） */
export const MATERIAL_HEAD_BYTES = 16

/** 扩展名不在白名单时的拒收原因（渲染层与主进程各显示一次，措辞必须一致） */
export function materialRejectReason(rawName: string): string {
  const dot = rawName.lastIndexOf('.')
  const ext = dot >= 0 ? rawName.slice(dot + 1).toLowerCase() : ''
  if (ext.length === 0) return '无法识别的文件类型'
  return `不支持的类型 .${ext}（支持 ${MATERIAL_EXTENSIONS.map((item) => '.' + item).join(' / ')}）`
}

/** 资料在笔记库里的存放目录（跟笔记库走，Obsidian 原生能预览 PDF） */
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
