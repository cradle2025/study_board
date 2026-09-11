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
