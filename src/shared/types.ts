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
  /** 当前程序认识的数据格式版本 */
  dataSchema: number
  /** 这份数据是被哪个程序版本写的（没有印记时为 null） */
  dataWrittenBy: string | null
  /** 数据格式不匹配时的提示语；正常为 null */
  dataWarning: string | null
}

/**
 * 切换便携模式的结果。
 *
 * 刻意**不返回新的设置对象**：便携模式要重启才生效，本次会话的
 * 设置并没有变。返回一个「看起来变了的设置」会让调用方以为可以
 * 立刻按新路径读数据，而实际读到的还是旧路径。
 */
export interface PortableSwitchResult {
  /** 是否真的动了数据（目标已经就是当前状态时为 false） */
  changed: boolean
  /** 迁移后数据所在目录 */
  target: string
  /** 迁移前数据所在目录（保留着，用户确认后自行删除） */
  previous: string
  /** 是否需要重启才生效 */
  restartRequired: boolean
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

/**
 * Notion 目标对象的类型。
 *
 * 光看 id 分不出它是数据库还是普通页面（两者都是 32 位十六进制），
 * 而「往哪儿写」的 API 完全不同，所以必须让用户明确选一次。
 * 默认 database：课程笔记按数据库组织是最常见的用法。
 */
export type NotionTargetKind = 'database' | 'page'

export interface NotionSettings {
  /** 目标数据库或页面 id */
  targetId: string
  /** 目标是数据库还是页面 */
  targetKind: NotionTargetKind
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

/**
 * 设置补丁。
 *
 * 刻意排除 `portableMode`：它不是「改一个字段」，而是搬整个数据目录，
 * 走 `settings:set-portable` 那条单独通道。留在补丁里的话，
 * 调用方会以为一次 `patch` 就能切过去，而实际只会写下一个
 * 与真实数据位置矛盾的字段值。
 */
export type SettingsPatch = Partial<
  Omit<AppSettings, 'timetable' | 'ai' | 'notion' | 'materials' | 'portableMode'>
> & {
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

/**
 * 一门课在哪些周上。
 *
 * 用判别联合而不是「`weeks: number[]` + 空数组表示每周」：
 * 「每周」和「单周」是**两种不同的语义**，塞进同一个数组会让渲染层
 * 到处写 `if (weeks.length === 0)` 这类判空，而且判不出「指定了 0 周」。
 * 判别联合让每种情况各自带着自己需要的数据，`switch` 一遍就穷尽了。
 */
export type WeekRule =
  /** 每周都上 */
  | { kind: 'all' }
  /** 单周（第 1、3、5… 周） */
  | { kind: 'odd' }
  /** 双周（第 2、4、6… 周） */
  | { kind: 'even' }
  /** 指定周次，如 [1, 3, 5] 或 1–8 展开。已去重、升序 */
  | { kind: 'list'; weeks: number[] }

export interface TimetableCell {
  /**
   * 同一格多门课要能区分、要能单独增删改，所以每门课都带 id。
   * 由主进程在新增时分配，渲染层只负责回传。
   */
  id: string
  courseName: string
  teacher: string
  location: string
  remark: string
  /** 持续时间，例如 "45 分钟" 或 "1-2 节连上" */
  duration: string
  /** 适用周次 */
  weeks: WeekRule
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
  /**
   * key 形如 "1:0"，表示第 1 节、第 0 列（周一）。
   * 值是**这一格上的所有课**——不同周次可以并存（单周一门、双周另一门）。
   */
  cells: Record<string, TimetableCell[]>
  /** 一学期多少周 */
  weekCount: number
  /** 当前查看第几周；0 = 不按周次过滤（看全部） */
  currentWeek: number
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
  /** 一学期多少周 */
  weekCount?: number
  /** 当前查看第几周；0 = 全部 */
  currentWeek?: number
}

export interface TimetableSetCellInput {
  /** 形如 "3:2" */
  key: string
  /**
   * 单门课的增改：带 `id` 时替换同一格里那一门，不带 `id` 时**追加**一门。
   * 传 null 表示清空整格。
   */
  cell: TimetableCell | null
}

/** 按 id 删掉某格里的一门课（其余课不受影响） */
export interface TimetableRemoveCellInput {
  /** 形如 "3:2" */
  key: string
  /** 要删掉的那门课的 id */
  id: string
}

/**
 * 批量写入多个格子。
 *
 * 存在的理由：`setCell` 每次都会 `#persist()` 一次（整份 JSON 重写），
 * 一次多格操作走它 = N 次整文件重写，中途失败还会留下半成品。
 * 批量接口内部一次性应用、只写盘一次。
 */
export interface TimetableSetCellsInput {
  /** key 形如 "3:2"；值是该格的完整课程列表，空数组等价于清空该格 */
  cells: Record<string, TimetableCell[]>
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
  /**
   * 所属分组 id。空串表示**未分组**（顶层直接可见）。
   *
   * 分组只存在索引里，**不写进 frontmatter、也不在磁盘上建目录**。
   * 理由是笔记库要能直接当 Obsidian 库用、要能进 git：
   * 一旦按分组建目录，用户在 Obsidian 里挪一个文件就会让分组错位，
   * 而「外部改动导致结构变化」这件事根本没法跟用户解释清楚。
   */
  groupId: string
}

/**
 * 笔记分组。可以嵌套（`parentId` 指向另一个分组），构成树。
 *
 * 名字是**唯一会被用户改的东西**，id 一旦分配就不再变——
 * 笔记靠 id 记住自己属于哪一组，改名不会让归属断掉。
 */
export interface NoteGroup {
  id: string
  name: string
  /** 父分组 id。空串表示顶层分组 */
  parentId: string
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
  /**
   * 要合并进 frontmatter 的额外键值。
   *
   * 目前只有 Notion 同步用（写 `notionId` / `notionHash`）。
   * 走这个字段而不是让调用方直接改文件，是为了让「写笔记」只有一个入口——
   * 绕过它就会漏掉索引更新与「自己写盘」的指纹登记。
   */
  extra?: Record<string, string>
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

/* ------------------------------------------------------------------ Notion 同步 */

/**
 * 一篇笔记在远端（Notion）上的身份。
 *
 * 写在笔记 frontmatter 的 `notionId` 里，是「本地这篇」与「远端那篇」之间
 * 唯一的对应关系。刻意**不用标题**去对：标题是用户随时会改的东西，
 * 拿它当主键的话，改个标题就会被当成「删一篇 + 加一篇」。
 */
export interface NotionPushResult {
  /** 成功推送的篇数 */
  pushed: number
  /** 跳过的篇数（内容与上次推送时一致，没必要再发一遍） */
  skipped: number
}

/**
 * 拉取时发现的冲突：同一个 notionId 在两边都有，且内容不一致。
 *
 * 这一类**不自动处理**，原样报给用户：
 * 「以哪边为准」会直接改掉用户写的东西，替他决定是不负责任的。
 */
export interface NotionConflict {
  /** 本地笔记 id */
  noteId: string
  noteTitle: string
  /** 远端页面标题（两边标题可能已经被改得不一样了） */
  remoteTitle: string
  /** 远端最后编辑时间（ISO），给用户一个「哪边更新」的参考 */
  remoteEditedAt: string
}

/**
 * 拉取结果。
 *
 * `pulled` 是**已经落盘**的（本地没有的，或用户选择以远端为准的）；
 * `conflicts` 是需要用户逐条决定的，本次没有动它们。
 */
export interface NotionPullResult {
  pulled: number
  conflicts: NotionConflict[]
  /** 因为超出单次上限而没来得及检查的条数，>0 时提示用户再同步一次 */
  deferred: number
}

/** 冲突解决：用户为某一篇选的哪边为准 */
export interface NotionResolveInput {
  noteId: string
  /** local = 保留本地版本；remote = 用远端覆盖本地 */
  choice: 'local' | 'remote'
}

export interface NotionResolveResult {
  /** 真正改了本地的篇数（选 local 的只是记下「已确认」，不动文件） */
  applied: number
}

export interface NotionTestResult {
  ok: boolean
  /** 目标数据库 / 页面的标题，用来让用户确认「连的是不是这个地方」 */
  name: string
}

/* ------------------------------------------------------------------ 日历 / 日程 */

/**
 * 日程的重复规则。
 *
 * 刻意**不做课表那套「单双周」**：单双周是国内教务系统表达「这门课
 * 隔周上」的方式，属于课表；日程要的是「每周三开会」「每月 1 号交作业」
 * 这类日常重复，两者不是一回事。给日程也摆上「单周 / 双周」只会让
 * 用户在写「每周」的时候多犹豫一次。
 */
export type CalendarRepeat =
  /** 只发生一次 */
  | 'once'
  /** 每周同一天 */
  | 'weekly'
  /** 每月同一号（该月没有这一号时跳过，不顺延） */
  | 'monthly'

export interface CalendarEvent {
  id: string
  title: string
  /** 首次发生的日期，`YYYY-MM-DD`（本地时区） */
  date: string
  /** 开始时间 `HH:mm`；空串 = 全天 */
  start: string
  /** 结束时间 `HH:mm`；空串 = 未填 */
  end: string
  location: string
  note: string
  repeat: CalendarRepeat
  /** 提前多少分钟提醒；0 = 到点提醒；-1 = 不提醒 */
  remindBefore: number
  createdAt: string
  updatedAt: string
}

export interface CalendarEventInput {
  /** 带 id 则替换那一条；不带则新增 */
  id?: string
  title: string
  date: string
  start?: string
  end?: string
  location?: string
  note?: string
  repeat?: CalendarRepeat
  remindBefore?: number
}

/**
 * 日历存储。
 *
 * **不塞进 `timetable.json`，也不塞进 `config.json`**：
 *  - 日程是独立模块（用户自己加的作业 / 考试 / 社团活动），
 *    与课表的生命周期无关；
 *  - 单独一个文件 = 纯新增，不动任何既有模块的读写格式。
 */
export interface CalendarData {
  /**
   * 第 1 周的周一（`YYYY-MM-DD`）。
   *
   * 课表只记「第几周有哪些课」，没有「第 1 周是哪一天」这个信息，
   * 所以日历要显示课表事件就必须先知道开学日。空串 = 未设置，
   * 此时**只显示用户自己的日程**，课表事件一条都不显示（而不是
   * 猜一个日期猜错了把课铺到错误的星期上）。
   */
  semesterStart: string
  events: CalendarEvent[]
}

export interface CalendarSaveInput {
  /** `YYYY-MM-DD`；传空串表示清除 */
  semesterStart?: string
}

/** 一条到点的提醒 */
export interface CalendarReminder {
  eventId: string
  title: string
  /** 事件发生的那一天 `YYYY-MM-DD` */
  date: string
  /** 提醒时刻（ISO 8601，含时区） */
  at: string
  location: string
  /** 事件本身的开始时间 `HH:mm`；空串 = 全天 */
  start: string
}

/**
 * 系统通知的能力与回执。
 *
 * `lastOutcome` 里那个 `unverified` 是**实测逼出来的**：Windows 上
 * 没给应用注册 AppUserModelID 时，Electron 的 `show()` 既不报错、
 * 也不发 `failed`，通知就那么没了。所以「没收到回执」必须和
 * 「系统说失败」分开报，否则界面会理直气壮地说「已提醒」而用户
 * 什么都没看到。实测方法与结论见 `DECISIONS.md` D-012。
 */
export interface CalendarNotificationInfo {
  /** 系统是否报告支持通知（注意：这只反映平台能力，不反映用户的勿扰设置） */
  supported: boolean
  /** 本进程内收到 `show` 回执的条数 */
  delivered: number
  /** 本进程内被系统拒掉的条数 */
  failed: number
  /** 最近一次提醒的时刻（含没发成功的），界面用它显示「提醒确实触发过」 */
  lastAt: string | null
  lastTitle: string
  lastOutcome: 'none' | 'delivered' | 'failed' | 'unsupported' | 'unverified'
  /** 失败原因等补充说明，正常时为空串 */
  lastDetail: string
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
  CALENDAR_REMINDER: CalendarReminder
}
