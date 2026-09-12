/**
 * 主进程与渲染层共享的数据结构。
 *
 * 约定：
 *  - 所有跨进程调用的返回值都用 IpcResult 包一层，不把异常直接抛过边界；
 *  - 时间统一用 ISO 8601 字符串（本地时区由渲染层格式化）；
 *  - id 统一用不依赖 crypto 随机源的 uuidv4 字符串。
 */

import type { CourseStatus } from './course'
import type { MaterialExtension } from './materials'

/** 跨 IPC 边界的统一返回结构 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/** 主题模式 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 界面语言 */
export type UiLanguage = 'zh-CN' | 'en-US'

/** 笔记编辑器形态 */
export type NoteEditorMode = 'markdown' | 'richtext'

/** 课表展示形态 */
export type TimetableMode = 'image' | 'table'

/** 导出格式 */
export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf'

/** AI 落库方式 */
export type AiApplyMode = 'preview' | 'append' | 'replace-selection'

/* ------------------------------------------------------------------ 应用信息 */

export interface AppPaths {
  userData: string
  notesLibrary: string
  timetableImages: string
  iconsCache: string
  /** 课程资料目录（在笔记库内：attachments/）。设置页展示与「打开目录」用 */
  materials: string
  /** 运行日志目录。用户遇到卡死 / 崩溃时，出问题的现场在这里 */
  logs: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  locale: string
  paths: AppPaths
}

/* ------------------------------------------------------------------ 设置 */

export interface TimetableSettings {
  mode: TimetableMode
  /** 每天节数，1–20，默认 11 */
  periodCount: number
  /** 表头列名，默认 节数 + 周一至周日（共 8 列） */
  weekdays: string[]
}

export interface AiSettings {
  /** 选中的服务商预设 id。用户手动改过地址或模型之后会变成 'custom' */
  provider: string
  baseUrl: string
  model: string
  temperature: number
  /** 是否已写入密钥（密钥本体永不返回渲染层） */
  hasApiKey: boolean
}

export interface NotionSettings {
  /** 目标数据库或页面 id */
  targetId: string
  hasToken: boolean
  lastSyncAt: string | null
}

export interface MaterialsSettings {
  /**
   * 资料收件箱的完整路径。
   * 空串 = 未配置，运行时用「系统下载目录 / StudyBoard收件箱」。
   * 浏览器扩展按同样的约定把下载改存到这里。
   */
  inboxDir: string
}

export interface AppSettings {
  theme: ThemeMode
  language: UiLanguage
  /** 笔记库目录（绝对路径） */
  notesLibraryDir: string
  /** 便携模式：数据放在程序目录而非系统标准目录 */
  portableMode: boolean
  editorMode: NoteEditorMode
  timetable: TimetableSettings
  ai: AiSettings
  notion: NotionSettings
  materials: MaterialsSettings
}

/** 可局部更新的设置（AI / Notion 的密钥单独走专用通道，不进这里） */
export type TimetablePatch = Partial<TimetableSettings>
export type AiPatch = Partial<Omit<AiSettings, 'hasApiKey'>>
export type NotionPatch = Partial<Omit<NotionSettings, 'hasToken'>>

export type SettingsPatch = Partial<Omit<AppSettings, 'timetable' | 'ai' | 'notion' | 'materials'>> & {
  timetable?: TimetablePatch
  ai?: AiPatch
  notion?: NotionPatch
  materials?: Partial<MaterialsSettings>
}

/* ------------------------------------------------------------------ 课程表 */

export interface PeriodRow {
  /** 第几节，从 1 开始 */
  index: number
  /** 开始时间 HH:mm，可空 */
  start: string
  /** 结束时间 HH:mm，可空 */
  end: string
}

export interface TimetableCell {
  courseName: string
  teacher: string
  location: string
  remark: string
  /** 持续时间，例如 "45 分钟" 或 "1-2 节连上" */
  duration: string
}

export interface CourseImage {
  id: string
  /** 相对 timetableImages 目录的文件名（HEIF 已转码为 png，超大图已等比缩放） */
  fileName: string
  /** 用户上传时的原始文件名，用于展示 */
  sourceName: string
  addedAt: string
  /** 落盘后的实际像素尺寸 */
  width: number
  height: number
  /** 落盘体积（字节），用于界面提示 */
  bytes: number
}

export interface TimetableData {
  mode: TimetableMode
  periodCount: number
  weekdays: string[]
  rows: PeriodRow[]
  /** key 形如 "1:0"，表示第 1 节、第 0 列（周一） */
  cells: Record<string, TimetableCell>
  images: CourseImage[]
}

/**
 * 课表「形状」与「内容」分开存：
 *  - mode / periodCount / weekdays 属于展示形状，落在 config.json（设置）里；
 *  - rows / cells / images 属于录入内容，落在 timetable.json 里。
 * 这样切换节数不会碰内容，改内容也不会覆盖形状。
 */
export interface TimetableSaveInput {
  mode?: TimetableMode
  periodCount?: number
  weekdays?: string[]
  rows?: PeriodRow[]
}

export interface TimetableSetCellInput {
  /** 形如 "3:2" */
  key: string
  /** null 表示清空该单元格 */
  cell: TimetableCell | null
}

export interface TimetableImageImportResult {
  timetable: TimetableData
  /** 成功导入的张数 */
  added: number
  /** 逐张失败的原因（原文件名 + 原因），全部成功时为空数组 */
  errors: string[]
}

/* ------------------------------------------------------------------ 网站门户 */

export interface PortalSite {
  id: string
  name: string
  url: string
  /** 相对 iconsCache 的图标文件名，抓取失败时为空 */
  iconFile: string
  /** 兜底色块颜色，形如 #4C8DFF */
  color: string
  /** 是否内置（内置站点可隐藏但不可删除） */
  builtin: boolean
  hidden: boolean
  order: number
}

export interface PortalSiteInput {
  /** 传入表示更新已有站点；不传表示新建 */
  id?: string
  name: string
  url: string
  /** 只接受 #rrggbb，不传则由主机名推导 */
  color?: string
  /** 仅对内置站点有意义：内置站点删不掉，只能隐藏 */
  hidden?: boolean
}

/* ------------------------------------------------------------------ 课程卡片 */

export interface CourseCard {
  id: string
  courseName: string
  teacher: string
  /**
   * 课程状态：想学 / 在学 / 已学。
   *
   * 「已学库」不是第二种存储，就是这个字段等于 `learned` 的一个筛选视图。
   */
  status: CourseStatus
  /** 学期，如 "2025-2026 秋"。自由文本，空串表示没填 */
  semester: string
  /** 想修的理由。只在想学阶段最有用，其它状态下允许留空 */
  reason: string
  /** 打分，自由文本（可能是 "95" / "A" / "优秀"） */
  score: string
  /** 难度 1–5，0 表示未填 */
  difficulty: number
  /** 掌握程度 1–5，0 表示未填 */
  mastery: number
  /** 背面：给分标准 */
  gradingPolicy: string
  /** 背面：课程大致结构 */
  outline: string
  /** 关联笔记 id */
  noteId: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface CourseCardInput {
  id?: string
  courseName: string
  teacher: string
  status?: CourseStatus
  semester?: string
  reason?: string
  score?: string
  difficulty?: number
  mastery?: number
  gradingPolicy?: string
  outline?: string
}

/**
 * 只改状态（归档 / 移回在学 / 加入愿望单）。
 *
 * 单独开一个入参类型而不是复用 `CourseCardInput`：那个接口要求 `courseName`
 * 必填，而卡片的脚部按钮手里只有 id——让它为了改个状态先把整张卡片读一遍、
 * 再原样写回去，等于给「并发编辑时互相覆盖」开了个口子。
 */
export interface CourseStatusInput {
  id: string
  status: CourseStatus
  /** 可选。给出时直接采用，缺省时学期为空才按状态补默认值 */
  semester?: string
}

/* ------------------------------------------------------------------ 笔记 */

export interface NoteMeta {
  id: string
  /** 笔记标题，默认 "课程名_授课老师" */
  title: string
  /** 相对 notesLibraryDir 的路径，形如 "高等数学_张三.md" */
  fileName: string
  mode: NoteEditorMode
  createdAt: string
  updatedAt: string
}

export interface NoteDoc extends NoteMeta {
  /** Markdown 正文，不含 frontmatter */
  content: string
  /** frontmatter 中的自定义字段 */
  frontmatter: Record<string, string | number | boolean | string[]>
}

export interface NoteWriteInput {
  id: string
  content: string
  /** 不传则沿用当前模式 */
  mode?: NoteEditorMode
  title?: string
}

/* ------------------------------------------------------------------ 导出 */

export interface ExportNoteRequest {
  noteId: string
  format: ExportFormat
  /** 不传则弹出保存对话框 */
  targetPath?: string
}

export interface ExportNoteResult {
  /** 用户取消时 cancelled 为 true */
  cancelled: boolean
  filePath?: string
}

/* ------------------------------------------------------------------ 课程资料 */

/**
 * 一份课程资料（PDF / PPT / Word / Excel）。
 *
 * **磁盘上的文件是本体**，这份索引只是簿记——丢了可以重建，
 * 但「挂在哪门课」重建不回来，所以文件的增删走应用，不鼓励手动挪。
 */
export interface MaterialItem {
  id: string
  /** 库内文件名（含扩展名）。库目录 + 它 = 完整路径 */
  fileName: string
  /** 用户可读名（不含扩展名），改名改的是它 */
  title: string
  /** 类型扩展名（小写，无点） */
  ext: MaterialExtension
  bytes: number
  /** 归属的课程卡片 id。空串 = 未归类 */
  courseCardId: string
  /** 导入前的原始文件名，仅用于展示与检索 */
  sourceName: string
  importedAt: string
  /**
   * 对账状态：ok = 磁盘上在；missing = 索引里有、磁盘上没了。
   * 丢失**不自动摘除**——很可能只是被挪走了，摘了关联就找不回来
   */
  missing: boolean
}

/** 一次导入的逐条结果。与课表图片导入的 {added, errors} 同一个模式 */
export interface MaterialImportResult {
  /** 导入后的完整资料列表（写操作统一返回整份，渲染层直接重绘） */
  materials: MaterialItem[]
  added: number
  /** 逐条失败原因（原文件名 + 原因） */
  errors: string[]
}

export interface MaterialImportInput {
  /** 要导入的文件绝对路径（拖拽 / 对话框两个入口都收敛到这里） */
  paths: string[]
  /** 归属的课程卡片 id，空串 = 暂不归类 */
  courseCardId?: string
  /**
   * 资料名。缺省时用原始文件名去扩展名——它同时是入库文件名的主要成分，
   * 比如课程「高等数学 A」+ 名称「第3章极限」→ 高等数学 A_第3章极限.pdf
   */
  title?: string
  /**
   * 导入成功后对源文件的处理。
   * 收件箱用 'recycle'（中转站使命完成，原文件进系统回收站），
   * 拖拽/对话框用 'keep'（原件在用户的下载目录里，一个字节都不动）
   */
  sourcePolicy?: 'keep' | 'recycle'
}

/** 收件箱里待处理的候选（渲染层弹归属对话框用，只报名字不报路径） */
export interface MaterialInboxCandidate {
  fileName: string
  bytes: number
}

/* ------------------------------------------------------------------ AI */

export interface AiCompleteRequest {
  /** 用户给的要求 */
  instruction: string
  /** 课程主题 / 笔记上下文 */
  context: string
  /** 期望的整理方向，可空 */
  focus?: string
}

export interface AiCompleteResult {
  text: string
  model: string
  usage: {
    promptTokens: number
    completionTokens: number
  }
}

/* ------------------------------------------------------------------ 事件 */

/**
 * 主进程主动推给渲染层的事件。
 *
 * 只由**外部改动**触发：我们自己写盘产生的那一批事件在主进程就被过滤掉了，
 * 渲染层不会收到自己刚保存的那一篇——否则每打一个字编辑器都会被重载一次。
 */
export interface LibraryChangedEvent {
  /** 变化类型；reset 表示整个笔记库换了目录（设置里改了路径） */
  kind: 'add' | 'change' | 'unlink' | 'reset'
  /** 相对笔记库根目录的文件名；reset 时为空串 */
  fileName: string
  /**
   * 相关笔记的 id。
   *
   * 渲染层靠它判断「变的是不是我正在编辑的那一篇」，所以哪怕文件被删了
   * 也要带着 id（不然只能靠文件名猜，而改名场景下文件名恰好是不靠谱的那个）。
   */
  id: string
}

export interface IpcEvents {
  LIBRARY_CHANGED: LibraryChangedEvent
}
