/** 课程表的尺寸约束：主进程与渲染层共用，避免两边各写一份导致不一致 */

export const MIN_PERIODS = 1
export const MAX_PERIODS = 20
export const DEFAULT_PERIODS = 11

/** 表格列数：第 1 列是节数，后面 7 列是周一至周日 */
export const TIMETABLE_COLUMNS = 8

/** 默认表头 */
export const DEFAULT_WEEKDAYS: readonly string[] = Object.freeze([
  '节数',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日'
])

/** 单张课表最多允许的图片数量 */
export const MAX_TIMETABLE_IMAGES = 3

/**
 * 一学期周数。
 *
 * 16 是国内本科最常见的教学周数；上限 30 覆盖「两学期连排」「短学期」
 * 这类写法，同时挡住 `{kind:'list'}` 里塞进一个天文数字的周次。
 */
export const DEFAULT_WEEK_COUNT = 16
export const MAX_WEEK_COUNT = 30

/* ------------------------------------------------------------------ 日历 / 日程 */

/**
 * 日程条数上限。
 *
 * 一学期几十条（作业截止、考试、社团活动）是常态；给到 500 是为了
 * 「四年都记在一个文件里」也能用。再往上就该考虑分文件了，而这个
 * 存储是整份 JSON 重写的，条数太多会拖慢每次保存。
 */
export const MAX_CALENDAR_EVENTS = 500

/** 日程标题长度上限 */
export const MAX_EVENT_TITLE = 80
/** 地点长度上限 */
export const MAX_EVENT_LOCATION = 60
/** 备注长度上限 */
export const MAX_EVENT_NOTE = 500

/**
 * 提前提醒的分钟数上限：一天。
 *
 * 上限直接决定调度器每次要回看多久（见 `dueReminders`）。放开到
 * 「提前一周」听起来更灵活，实际没人会给一条日程设七天前提醒，
 * 却会让每次检查都多扫一周的数据。
 */
export const MAX_REMIND_MINUTES = 1440

/** 界面上可选的提前量（分钟）。-1 = 不提醒 */
export const REMIND_OPTIONS: readonly number[] = Object.freeze([-1, 0, 5, 10, 15, 30, 60, 1440])

/* ------------------------------------------------------------------ 网站门户 */

/** 门户站点数量上限：够放得下全部常用学习站点，又不至于无限堆 */
export const MAX_PORTAL_SITES = 60

/** 站点名称长度上限 */
export const MAX_SITE_NAME = 40

/** 网址长度上限（浏览器本身一般也就 2KB 左右） */
export const MAX_SITE_URL = 2048

/** 门户图标缓存的边长（像素）：够看清，又不会让图标目录膨胀 */
export const PORTAL_ICON_EDGE = 64

/* ------------------------------------------------------------------ 课程卡片 */

export const MAX_CARDS = 200

/** 卡片上的短文本：课程名 / 老师 / 打分 */
export const MAX_CARD_TEXT = 60
/** 卡片背面的长文本：给分标准 / 课程结构 */
export const MAX_CARD_LONG = 2000
/** 难度与掌握程度都按 1–5 打分，0 表示没填 */
export const MAX_CARD_LEVEL = 5
/** 学期，如 "2025-2026 秋"。留够写 "2025-2026 学年第一学期" 这种长写法的余量 */
export const MAX_CARD_SEMESTER = 32
/** 想修理由。比正文短得多：这是一句话，不是一篇小作文 */
export const MAX_CARD_REASON = 200

/* ------------------------------------------------------------------ 笔记 */

/** 笔记标题上限。同时决定文件名长度，留够余量给 " (2)" 这类去重后缀 */
export const MAX_NOTE_TITLE = 80
/** 单篇笔记正文上限，防止一次写入把内存打爆 */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024
/** 文件名（含 .md）上限：Windows 上单段路径上限是 255 */
export const MAX_NOTE_FILE_BYTES = 200
/** 读笔记文件时用于提取 frontmatter 的头部字节数 */
export const NOTE_HEAD_BYTES = 4096

/* ------------------------------------------------------------------ 笔记分组 */

/**
 * 分组数量上限。
 *
 * 比笔记数（500）少一个量级：分组是给人「一眼扫过去」的结构，
 * 几十个已经很难扫了。真到这个数说明该用标签而不是继续加层级。
 */
export const MAX_NOTE_GROUPS = 200

/** 分组名长度上限。侧栏一行放得下，再长就会被省略号吃掉 */
export const MAX_GROUP_NAME = 40

/**
 * 分组最大嵌套深度。
 *
 * 三层足够表达「学期 → 课程 → 章节」这类真实结构。
 * 限制它有两个实在的好处：一是防住 A→B→A 这类环（虽然移动时会单独判环，
 * 但有个硬上限等于多一道保险），二是侧栏的缩进宽度可预期——
 * 每层缩进 14px，不封顶的话深层的名字会被挤到看不见。
 */
export const MAX_GROUP_DEPTH = 4

/* ------------------------------------------------------------------ 导出 */

/**
 * 导出格式 → 文件扩展名。
 *
 * 主进程用它做两件事：拼保存对话框的过滤器、校验渲染层给的目标路径
 * （扩展名必须与格式对得上，否则一个「导出 pdf」的请求就能写出任意文件名）。
 * 渲染层也要靠它显示「导出为 .docx」这类文案，所以放 shared。
 */
export const EXPORT_EXTENSIONS = {
  md: 'md',
  html: 'html',
  docx: 'docx',
  pdf: 'pdf'
} as const

/** 单篇笔记导出的等待上限：PDF 要起一个隐藏窗口，比另外三种慢得多 */
export const EXPORT_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ AI 助手 */

/**
 * 各段输入的上限。
 *
 * 放 shared 而不是只写在主进程里，是因为**两边都要用**：
 * 渲染层要提前拦一次给出人话提示（别等发出去才报错），主进程再兜一次底
 * （渲染层的长度检查只是体验，不能当成防线）。
 */
export const MAX_AI_INSTRUCTION = 4000
export const MAX_AI_CONTEXT = 60_000
export const MAX_AI_FOCUS = 200

/** 单次 AI 请求的等待上限。模型边想边说，给得比导出宽 */
export const AI_TIMEOUT_MS = 60_000

/* ------------------------------------------------------------------ 课程资料 */

/** 资料条数上限：一门课一学期的课件 + 讲义 + 大纲，四年下来几百份足够 */
export const MAX_MATERIALS = 500

/**
 * 单个资料文件的大小上限（100MB）。
 *
 * 课件 PDF 常见在几 MB 到几十 MB，上百 MB 的基本是扫描合集——
 * 复制进库之前拦下来，别让一次误拖把磁盘占满。
 */
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024

/** 资料标题（用户可读名）长度上限，同时是入库文件名的主要成分 */
export const MAX_MATERIAL_TITLE = 80

/** 一次导入的文件数上限：拖一个乱糟糟的下载目录进来也不至于导入几百个 */
export const MAX_MATERIAL_BATCH = 30

/* ------------------------------------------------------------------ Notion 同步 */

/**
 * 目标数据库 / 页面 id 的长度上限。
 *
 * Notion 的 id 是 32 位十六进制（带连字符是 36 位），但用户从地址栏复制时
 * 常常把整个 URL 粘进来，所以留够一个 URL 的余量，由主进程去截取 id。
 */
export const MAX_NOTION_TARGET_ID = 512

/** 单篇笔记推送时的正文上限：Notion 单个富文本块也有长度限制，留出余量 */
export const MAX_NOTION_PUSH_BYTES = 1_000_000

/** 一次推送 / 拉取的篇数上限：一次同步动作不要变成一次全库搬运 */
export const MAX_NOTION_BATCH = 50

/** Notion API 单次请求的等待上限。它比大模型快，比导出慢 */
export const NOTION_TIMEOUT_MS = 30_000

/**
 * 拉取时最多报告多少条冲突。
 *
 * 冲突是要用户逐条决定的，一次弹出几百条没人会看完；
 * 超出部分留在这一次不处理，下次同步还会再报一次。
 */
export const MAX_NOTION_CONFLICTS = 20

