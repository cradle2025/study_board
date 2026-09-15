import type { TimetableCell, WeekRule } from './types'

/**
 * 周次判定。**课表与日历共用同一份**，不要各写一套。
 *
 * 为什么把它从 `timetable-panel.ts` 里搬出来：
 *
 * 日历要按「这一周有哪些课」把课表事件铺到日期上，判据和课表页
 * 完全一样（每周 / 单周 / 双周 / 指定周）。如果日历自己再写一遍，
 * 两边就有两个独立演化的「什么算单周」——今天一样，改了一边之后
 * 用户就会看到「课表第 4 周有这门课、日历第 4 周没有」这种自相矛盾的
 * 界面，而且**两边都不会报错**。
 *
 * 放在 `shared` 而不是渲染层的某个组件里，是因为判定是纯函数、
 * 与 DOM 无关，放这儿两边都能引，也不会让日历为了一个判断去依赖
 * 课表面板那一大坨渲染代码。
 */

/**
 * 这一周该不该上这门课。
 *
 * `week <= 0` 表示「不按周次过滤」（看全部），此时一律算上——
 * 「全部」是一个视图状态，不是一种周次规则，所以在这里短路，
 * 而不是往 WeekRule 里再加一个 kind。
 */
export function weeksInclude(rule: WeekRule, week: number): boolean {
  if (week <= 0) return true
  switch (rule.kind) {
    case 'all':
      return true
    case 'odd':
      return week % 2 === 1
    case 'even':
      return week % 2 === 0
    case 'list':
      return rule.weeks.includes(week)
  }
}

/** 这一格里在当前查看周次下应该显示的课 */
export function visibleCourses(
  list: readonly TimetableCell[] | undefined,
  week: number
): TimetableCell[] {
  if (!list) return []
  return list.filter((cell) => weeksInclude(cell.weeks, week))
}
