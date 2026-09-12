/**
 * 课程状态与学期的共用规则。
 *
 * 单开一个文件而不是塞进 `types.ts`：这里除了类型还有**规则**——
 * 状态集合、"学期"这个字段在不同状态下的标签、学期的推算与排序。
 * 这些规则主进程（落盘清洗）、渲染层（表单预填、归档分组）都要用，
 * 各写一份迟早会漂。
 */

/**
 * 三种状态，覆盖一门课在人生里的三个阶段：
 *  - `wish`     想学。还没修，先记在一边（愿望单）
 *  - `learning` 在学。这学期正在修
 *  - `learned`  已学。修完了，进归档
 *
 * 「归档」不是第二种存储，只是 `learned` 这个值的一个筛选视图——
 * 同一门课的数据只存一份，笔记关联、改名跟随这些逻辑才不用跟着分裂。
 */
export const COURSE_STATUSES = ['wish', 'learning', 'learned'] as const

export type CourseStatus = (typeof COURSE_STATUSES)[number]

export const STATUS_LABEL: Record<CourseStatus, string> = {
  wish: '想学',
  learning: '在学',
  learned: '已学'
}

/**
 * 「学期」这个字段在不同状态下问的其实是不同的问题，
 * 标签就跟着变——同一个输入框，对想学的课问「打算什么时候修」。
 */
export const SEMESTER_LABEL: Record<CourseStatus, string> = {
  wish: '计划学期',
  learning: '学期',
  learned: '学期'
}

/** 在学的卡片可以有多个；想学和已学是「不在学期里」的两种，界面各占一边 */
export function isCourseStatus(value: unknown): value is CourseStatus {
  return typeof value === 'string' && (COURSE_STATUSES as readonly string[]).includes(value)
}

/**
 * 认不出来的状态一律当「在学」。
 *
 * 这是老数据的升级路径：加这个字段之前建好的卡片都没有 `status`，
 * 那些课显然都是当时正在修的，落到「在学」而不是凭空消失。
 */
export function normalizeCourseStatus(value: unknown): CourseStatus {
  return isCourseStatus(value) ? value : 'learning'
}

/* ------------------------------------------------------------------ 学期 */

const SEASON_ORDER = ['秋', '春', '夏'] as const
type Season = (typeof SEASON_ORDER)[number]

/** 学期写法的解析："2025-2026 秋" → { start: 2025, season: '秋' } */
function parseSemester(value: string): { start: number; season: Season } | null {
  const matched = /^(\d{4})\s*-\s*(\d{4})\s*(秋|春|夏)?/.exec(String(value ?? '').trim())
  if (!matched) return null
  const start = Number(matched[1])
  if (!Number.isFinite(start)) return null
  return { start, season: (matched[3] as Season | undefined) ?? '秋' }
}

/**
 * 按当前日期猜一个学期，填进新建卡片的表单里。
 *
 * 国内高校的通行划法：9 月到次年 1 月是秋季学期，2 到 6 月是春季，
 * 7 到 8 月算夏季（短学期）。这只是个**默认值**，用户随时能改——
 * 各校校历不一样，猜得再准也不如让他自己写。
 */
export function suggestSemester(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = date.getMonth() + 1

  if (month >= 9) return `${year}-${year + 1} 秋`
  // 1 月仍然属于上一年开的那个秋季学期
  if (month === 1) return `${year - 1}-${year} 秋`
  if (month <= 6) return `${year - 1}-${year} 春`
  return `${year - 1}-${year} 夏`
}

/** 下一个学期。想学的课默认落在这里——计划学期填「当前学期」是自相矛盾的 */
export function nextSemester(value: string): string {
  const parsed = parseSemester(value)
  if (!parsed) return value
  const index = SEASON_ORDER.indexOf(parsed.season)
  if (index < SEASON_ORDER.length - 1) {
    return `${parsed.start}-${parsed.start + 1} ${SEASON_ORDER[index + 1]}`
  }
  return `${parsed.start + 1}-${parsed.start + 2} 秋`
}

/**
 * 学期空着时，某个状态该预填什么。
 *
 * 只用来**补空**，永远不覆盖用户已经写过的学期——他改过一次就说明他有自己的想法。
 *  - `wish`     想学的课不可能落在当前学期（真要修就直接填在学了），推到下一个
 *  - `learned`  归档通常发生在学期刚结束那会儿，当前学期就是最合理的猜测
 *  - `learning` 同上
 */
export function defaultSemesterFor(status: CourseStatus, date: Date = new Date()): string {
  const current = suggestSemester(date)
  return status === 'wish' ? nextSemester(current) : current
}

/**
 * 学期排序键，越大越新。
 *
 * 认不出来的写法（有人会写「大三上」「2025 秋」）返回 -1，
 * 排到最后——不能因为一个自由填的格子把整页分组顺序搞乱。
 */
export function semesterRank(value: string): number {
  const parsed = parseSemester(value)
  if (!parsed) return -1
  return parsed.start * 10 + SEASON_ORDER.indexOf(parsed.season)
}

/** 学期没填时归到哪一组 */
export const UNKNOWN_SEMESTER = '未填学期'

export type { Season }
