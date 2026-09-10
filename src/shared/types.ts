/**
 * 主进程与渲染层共享的数据结构。
 *
 * 约定：
 *  - 所有跨进程调用的返回值都用 IpcResult 包一层，不把异常直接抛过边界；
 *  - 时间统一用 ISO 8601 字符串（本地时区由渲染层格式化）；
 *  - id 统一用不依赖 crypto 随机源的 uuidv4 字符串。
 */

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
  database: string
  timetableImages: string
  iconsCache: string
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
}

/** 可局部更新的设置（AI / Notion 的密钥单独走专用通道，不进这里） */
export type TimetablePatch = Partial<TimetableSettings>
export type AiPatch = Partial<Omit<AiSettings, 'hasApiKey'>>
export type NotionPatch = Partial<Omit<NotionSettings, 'hasToken'>>

export type SettingsPatch = Partial<Omit<AppSettings, 'timetable' | 'ai' | 'notion'>> & {
  timetable?: TimetablePatch
  ai?: AiPatch
  notion?: NotionPatch
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
  id?: string
  name: string
  url: string
  color?: string
}

/* ------------------------------------------------------------------ 课程卡片 */

export interface CourseCard {
  id: string
  courseName: string
  teacher: string
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
  score?: string
  difficulty?: number
  mastery?: number
  gradingPolicy?: string
  outline?: string
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

/** 主进程主动推给渲染层的事件 */
export interface LibraryChangedEvent {
  /** 变化类型 */
  kind: 'add' | 'change' | 'unlink' | 'reset'
  /** 相对笔记库的路径 */
  fileName: string
}

export interface IpcEvents {
  LIBRARY_CHANGED: LibraryChangedEvent
}
