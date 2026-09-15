import type { CalendarEvent, CalendarReminder } from './types'

/**
 * 日历的日期换算与重复展开。
 *
 * 放在 `shared` 而不是渲染层，有两个原因：
 *  - 主进程要按同一套规则算「哪些提醒到点了」，渲染层要算「这一天显示什么」，
 *    两边必须一致；
 *  - 这些是纯函数，能被自检直接断言，不必绕界面。
 *
 * **全部按本地时区处理。** 日程是「人所在的那一天」，不是 UTC 那一天：
 * 用户在北京写的 2026-09-15，换个时区跑不该变成 14 号。所以日期一律
 * 用 `YYYY-MM-DD` 字符串表示，解析时补成**本地零点**，绝不走 `Date.parse`
 * （那个对 `2026-09-15` 会按 UTC 解释，在东八区会退到前一天）。
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 全天日程没有开始时间时，提醒落在这个钟点 */
export const ALL_DAY_REMINDER_TIME = '09:00'

/** `YYYY-MM-DD` 且是个真实存在的日期（挡掉 2026-02-30） */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(year, month - 1, day)
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  )
}

/** `YYYY-MM-DD` → 本地零点的 Date。非法日期返回 null */
export function parseIsoDate(value: string): Date | null {
  if (!isIsoDate(value)) return null
  const match = DATE_PATTERN.exec(value) as RegExpExecArray
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** Date → `YYYY-MM-DD`（按本地年月日取，不走 toISOString） */
export function toIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value)
}

/** 往后（或往前）挪若干天。跨月跨年交给 Date 自己算 */
export function addDays(iso: string, days: number): string {
  const base = parseIsoDate(iso)
  if (!base) return iso
  base.setDate(base.getDate() + days)
  return toIsoDate(base)
}

/**
 * 这一天是星期几。**0 = 周一 … 6 = 周日**。
 *
 * 用这个编号而不是 JS 原生的 `getDay()`（0 = 周日），是因为课表的
 * 列号就是这个约定（`cells` 的 key 是 "节次:列号"，0 号列是周一）。
 * 日历要把课表的列直接对上日期，编号一致能省掉一次容易写错的换算。
 */
export function weekdayIndex(iso: string): number {
  const date = parseIsoDate(iso)
  if (!date) return -1
  return (date.getDay() + 6) % 7
}

/** 两个日期相差多少天（`to - from`）。任一非法时返回 NaN */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = parseIsoDate(fromIso)
  const to = parseIsoDate(toIso)
  if (!from || !to) return Number.NaN
  // 用本地零点相减再四舍五入：夏令时那两天会有 ±1 小时的误差，
  // 直接除以 86400000 会得到 0.958… 这种小数
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/**
 * 这一天是学期的第几周（从 1 开始）。
 *
 * 开学日之前、开学日非法、或日期非法时返回 **0**，表示「不在学期内」。
 * 0 不是「第 0 周」——调用方拿到 0 就该什么都不显示，而不是按第 0 周
 * 去问 `weeksInclude`（那边把 <=0 解释成「不过滤」，会把课全显示出来）。
 */
export function weekIndexOf(iso: string, semesterStart: string): number {
  const offset = daysBetween(semesterStart, iso)
  if (!Number.isFinite(offset) || offset < 0) return 0
  return Math.floor(offset / 7) + 1
}

/**
 * 某个月的日历网格：固定 6 行 × 7 列（周一起始），共 42 天。
 *
 * 固定 6 行而不是「按需 4–6 行」：月份切换时格子数量不变，
 * 界面不会跳一下，也省得为了对齐再补空行。
 * 网格里会包含上个月末尾和下个月开头的日期（同一个月里也可能出现
 * 两次），调用方按需自己判断要不要弱化显示。
 */
export function monthGrid(year: number, month0: number): string[] {
  const first = new Date(year, month0, 1)
  const lead = (first.getDay() + 6) % 7
  const start = new Date(year, month0, 1 - lead)
  const cells: string[] = []
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    cells.push(toIsoDate(day))
  }
  return cells
}

/**
 * 事件在 `[fromIso, toIso]` 之间发生的所有日期（含首尾）。
 *
 * 逐日推进而不是按周 / 按月跳：范围本来就只是「当前这一屏」，
 * 逐日的成本可以忽略，换来的是**月末、闰年、跨年这些边界不用特判**——
 * 按月跳的写法必须自己处理「2 月没有 31 号」，而那正是最容易出错的地方。
 *
 * 重复规则：
 *  - `once`    只有 `date` 这一天
 *  - `weekly`  每周同一天
 *  - `monthly` 每月同一号；某个月没有这一号（如 31 号遇到 2 月）就**跳过**
 *              那个月，而不是顺延到 3 月 1 日 —— 顺延会让「每月 31 号」
 *              在 2 月变成 3 月 1 日，与「每月 1 号」的日程撞在一起
 */
export function occurrenceDates(
  event: CalendarEvent,
  fromIso: string,
  toIso: string
): string[] {
  const start = parseIsoDate(event.date)
  const from = parseIsoDate(fromIso)
  const to = parseIsoDate(toIso)
  if (!start || !from || !to) return []
  if (to.getTime() < from.getTime()) return []

  // 事件开始之前不算发生
  const cursor = start.getTime() > from.getTime() ? start : from
  const out: string[] = []
  const limit = 400 // 保险丝：范围再大也不会把内存撑爆（6 行网格远用不到）
  const current = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
  while (current.getTime() <= to.getTime() && out.length < limit) {
    const iso = toIsoDate(current)
    const offset = daysBetween(event.date, iso)
    if (event.repeat === 'once') {
      if (offset === 0) out.push(iso)
    } else if (event.repeat === 'weekly') {
      if (offset % 7 === 0) out.push(iso)
    } else if (offset >= 0 && current.getDate() === start.getDate()) {
      out.push(iso)
    }
    current.setDate(current.getDate() + 1)
  }
  return out
}

/**
 * 某一次发生的提醒时刻（毫秒）。
 *
 * 不提醒（`remindBefore < 0`）或事件没有可用的基准时间时返回 null。
 * 全天日程（没有开始时间）按 `ALL_DAY_REMINDER_TIME` 提醒 —— 否则
 * 「全天」这个选项就没法配提醒，而「作业今天截止」恰恰经常是全天的。
 */
export function reminderAtMs(event: CalendarEvent, dateIso: string): number | null {
  if (!Number.isFinite(event.remindBefore) || event.remindBefore < 0) return null
  const day = parseIsoDate(dateIso)
  if (!day) return null

  const base = isTime(event.start) ? event.start : ALL_DAY_REMINDER_TIME
  const [hour, minute] = base.split(':')
  day.setHours(Number(hour), Number(minute), 0, 0)
  return day.getTime() - event.remindBefore * 60_000
}

/** 往前看几天，足以覆盖「提前一天提醒」加上跨时区的余量 */
const LOOKBACK_DAYS = 2

/**
 * 在 `(fromMs, toMs]` 之间到点的提醒。
 *
 * **左开右闭**是这套调度的关键：调度器每隔一会儿调一次，把上次检查的
 * 时刻当作 `fromMs`。左开保证同一分钟不会被两次检查重复触发；右闭保证
 * 刚好卡在整点的提醒不会漏掉。
 *
 * 应用没运行时到点的提醒**不会补发**：启动时 `fromMs` 就是启动时刻，
 * 之前的一律落在窗口外。这是有意的——补发一堆「三天前的课要上了」
 * 除了打扰没有别的用处。
 */
export function dueReminders(
  events: readonly CalendarEvent[],
  fromMs: number,
  toMs: number
): CalendarReminder[] {
  if (!(toMs > fromMs)) return []
  const fromIso = toIsoDate(new Date(fromMs - LOOKBACK_DAYS * 86_400_000))
  const toIso = toIsoDate(new Date(toMs))

  const out: CalendarReminder[] = []
  for (const event of events) {
    for (const date of occurrenceDates(event, fromIso, toIso)) {
      const at = reminderAtMs(event, date)
      if (at === null || at <= fromMs || at > toMs) continue
      out.push({
        eventId: event.id,
        title: event.title,
        date,
        at: new Date(at).toISOString(),
        location: event.location,
        start: isTime(event.start) ? event.start : ''
      })
    }
  }
  // 同一时刻可能有多条（两门课同时开始），按时间排一下让通知顺序可预期
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title))
}

/** 事件在 `[fromIso, toIso]` 之间是否发生过（渲染层筛「这天有没有事」用） */
export function occursOn(event: CalendarEvent, dateIso: string): boolean {
  return occurrenceDates(event, dateIso, dateIso).length > 0
}
