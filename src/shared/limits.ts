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

/* ------------------------------------------------------------------ 笔记 */

/** 笔记标题上限。同时决定文件名长度，留够余量给 " (2)" 这类去重后缀 */
export const MAX_NOTE_TITLE = 80
/** 单篇笔记正文上限，防止一次写入把内存打爆 */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024
/** 文件名（含 .md）上限：Windows 上单段路径上限是 255 */
export const MAX_NOTE_FILE_BYTES = 200
/** 读笔记文件时用于提取 frontmatter 的头部字节数 */
export const NOTE_HEAD_BYTES = 4096

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

