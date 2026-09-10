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
