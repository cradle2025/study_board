import { monthGrid, occurrenceDates, toIsoDate, weekIndexOf, weekdayIndex } from '@shared/calendar'
import { MAX_EVENT_LOCATION, MAX_EVENT_NOTE, MAX_EVENT_TITLE, REMIND_OPTIONS } from '@shared/limits'
import type {
  CalendarData,
  CalendarEvent,
  CalendarNotificationInfo,
  CalendarRepeat,
  TimetableData
} from '@shared/types'
import { visibleCourses } from '@shared/weekRule'

import { t, tm } from '../lib/i18n'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import type { ViewContext, ViewInstance } from '../app-shell'

/**
 * 日历 / 日程页。
 *
 * 三条设计前提（已与用户确认，不要再改）：
 *  1. **独立一页**，不塞进课表页；
 *  2. **显示课表事件** —— 把课表里的课按周次规则铺到具体日期上；
 *  3. **用户也能自己加日程** —— 作业截止、考试、社团活动。
 *
 * 与课表的连接点是「开学第一天」：课表只记「第几周有哪些课」，
 * 没有「第 1 周是哪一天」。没填开学日就只显示用户自己的日程 ——
 * 猜一个日期猜错了会把课铺到错误的星期上，比不显示更糟。
 *
 * 周次判定直接用 `@shared/weekRule` 里那份（课表页用的是同一个函数）。
 * 自己再写一遍的话，两边迟早会对「什么算单周」产生分歧，而且不会报错。
 */

interface DayItem {
  /** course = 来自课表（只读）；event = 用户自己加的（可编辑） */
  kind: 'course' | 'event'
  /** 列表里的稳定 key（课程用 日期+课 id，日程用日程 id） */
  key: string
  title: string
  meta: string
  start: string
  end: string
  /** 课程事件才有：这一天的第几周 */
  week: number
  event?: CalendarEvent
}

function repeatLabel(repeat: CalendarRepeat): string {
  if (repeat === 'weekly') return t('calendar.repeat.weekly')
  if (repeat === 'monthly') return t('calendar.repeat.monthly')
  return t('calendar.repeat.once')
}

function remindLabel(minutes: number): string {
  if (minutes < 0) return t('calendar.remind.off')
  if (minutes === 0) return t('calendar.remind.atTime')
  if (minutes === 60) return t('calendar.remind.hour')
  if (minutes === 1440) return t('calendar.remind.day')
  return t('calendar.remind.minutes', { n: minutes })
}

function byStartThenTitle(a: DayItem, b: DayItem): number {
  // 全天的（没有开始时间）排在最前：它们通常是「今天截止」这类最重要的事
  const aKey = a.start === '' ? '00:00' : a.start
  const bKey = b.start === '' ? '00:00' : b.start
  return aKey.localeCompare(bKey) || a.title.localeCompare(b.title)
}

export function createCalendarView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'

  let data: CalendarData | null = null
  let timetable: TimetableData | null = null
  let notify: CalendarNotificationInfo | null = null
  /** 当前显示的月份 */
  let cursor = new Date()
  /** 下方「这一天的日程」跟着它走 */
  let selected = toIsoDate(new Date())
  /** 正在编辑的日程 id；空串 = 新建 */
  let editingId = ''

  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.calendar'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('calendar.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="back-home">${escapeHtml(t('common.back'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-card sb-card--pad">
        <div class="sb-field sb-tt-inline-field">
          <label for="semester-start">${escapeHtml(t('calendar.semesterStart'))}</label>
          <input id="semester-start" class="sb-input" type="date" data-role="semester-start" />
          <p class="sb-hint">${escapeHtml(t('calendar.semesterStartHint'))}</p>
        </div>
        <div class="sb-toolbar">
          <button class="sb-btn sb-btn--primary" type="button" data-action="save-semester">${escapeHtml(t('calendar.saveSemester'))}</button>
        </div>
        <p class="sb-hint" data-role="semester-note"></p>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title" data-role="month-label"></h2>
        <span class="sb-badge" data-role="month-meta"></span>
      </div>

      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="prev-month">${escapeHtml(t('calendar.prevMonth'))}</button>
        <button class="sb-btn" type="button" data-action="today">${escapeHtml(t('calendar.today'))}</button>
        <button class="sb-btn" type="button" data-action="next-month">${escapeHtml(t('calendar.nextMonth'))}</button>
        <label class="sb-quickfill__field">
          <span>${escapeHtml(t('calendar.jump'))}</span>
          <input class="sb-input" type="date" data-role="jump-date" />
        </label>
        <button class="sb-btn" type="button" data-action="jump">${escapeHtml(t('calendar.jumpGo'))}</button>
      </div>

      <div class="sb-cal" data-role="grid"></div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title" data-role="day-title"></h2>
        <span class="sb-badge" data-role="day-meta"></span>
      </div>

      <div class="sb-cal__items" data-role="day-items"></div>

      <div class="sb-card sb-card--pad" data-role="event-form">
        <div class="sb-toolbar">
          <button class="sb-btn sb-btn--primary" type="button" data-action="new-event">${escapeHtml(t('calendar.newEvent'))}</button>
          <button class="sb-btn" type="button" data-action="delete-event" hidden>${escapeHtml(t('common.delete'))}</button>
        </div>

        <p class="sb-hint" data-role="form-mode"></p>

        <div class="sb-field">
          <label for="ev-title">${escapeHtml(t('calendar.field.title'))}</label>
          <input id="ev-title" class="sb-input" data-role="ev-title" maxlength="${MAX_EVENT_TITLE}" />
        </div>
        <div class="sb-field">
          <label for="ev-date">${escapeHtml(t('calendar.field.date'))}</label>
          <input id="ev-date" class="sb-input" type="date" data-role="ev-date" />
        </div>
        <div class="sb-field">
          <label for="ev-start">${escapeHtml(t('calendar.field.start'))}</label>
          <input id="ev-start" class="sb-input" type="time" data-role="ev-start" />
        </div>
        <div class="sb-field">
          <label for="ev-end">${escapeHtml(t('calendar.field.end'))}</label>
          <input id="ev-end" class="sb-input" type="time" data-role="ev-end" />
        </div>
        <div class="sb-field">
          <label for="ev-location">${escapeHtml(t('calendar.field.location'))}</label>
          <input id="ev-location" class="sb-input" data-role="ev-location" maxlength="${MAX_EVENT_LOCATION}" />
        </div>
        <div class="sb-field">
          <label for="ev-note">${escapeHtml(t('calendar.field.note'))}</label>
          <textarea id="ev-note" class="sb-input" data-role="ev-note" rows="2" maxlength="${MAX_EVENT_NOTE}"></textarea>
        </div>
        <div class="sb-field">
          <label for="ev-repeat">${escapeHtml(t('calendar.field.repeat'))}</label>
          <select id="ev-repeat" class="sb-select" data-role="ev-repeat">
            <option value="once">${escapeHtml(t('calendar.repeat.once'))}</option>
            <option value="weekly">${escapeHtml(t('calendar.repeat.weekly'))}</option>
            <option value="monthly">${escapeHtml(t('calendar.repeat.monthly'))}</option>
          </select>
        </div>
        <div class="sb-field">
          <label for="ev-remind">${escapeHtml(t('calendar.field.remind'))}</label>
          <select id="ev-remind" class="sb-select" data-role="ev-remind">
            ${REMIND_OPTIONS.map(
              (minutes) =>
                `<option value="${minutes}">${escapeHtml(remindLabel(minutes))}</option>`
            ).join('')}
          </select>
        </div>

        <div class="sb-toolbar">
          <button class="sb-btn sb-btn--primary" type="button" data-action="save-event">${escapeHtml(t('common.save'))}</button>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('calendar.reminder'))}</h2>
        <span class="sb-badge" data-role="notify-badge"></span>
      </div>
      <div class="sb-card sb-card--pad">
        <p class="sb-hint">${escapeHtml(t('calendar.notifyHint'))}</p>
        <p class="sb-hint" data-role="notify-status"></p>
        <div class="sb-toolbar">
          <button class="sb-btn" type="button" data-action="test-notification">${escapeHtml(t('calendar.testNotification'))}</button>
        </div>
      </div>
    </section>
  `

  const q = <T extends HTMLElement>(role: string): T | null =>
    element.querySelector<T>(`[data-role="${role}"]`)

  const grid = q('grid')
  const monthLabel = q('month-label')
  const monthMeta = q('month-meta')
  const dayTitle = q('day-title')
  const dayMeta = q('day-meta')
  const dayItems = q('day-items')
  const semesterInput = element.querySelector<HTMLInputElement>('#semester-start')
  const semesterNote = q('semester-note')
  const formMode = q('form-mode')
  const jumpInput = q<HTMLInputElement>('jump-date')
  const titleInput = q<HTMLInputElement>('ev-title')
  const dateInput = q<HTMLInputElement>('ev-date')
  const startInput = q<HTMLInputElement>('ev-start')
  const endInput = q<HTMLInputElement>('ev-end')
  const locationInput = q<HTMLInputElement>('ev-location')
  const noteInput = q<HTMLTextAreaElement>('ev-note')
  const repeatInput = q<HTMLSelectElement>('ev-repeat')
  const remindInput = q<HTMLSelectElement>('ev-remind')
  const deleteButton = element.querySelector<HTMLButtonElement>('[data-action="delete-event"]')
  const notifyStatus = q('notify-status')
  const notifyBadge = q('notify-badge')

  /* ------------------------------------------------------------ 计算 */

  /** 这一天从课表来的课 */
  function coursesOn(date: string): DayItem[] {
    const start = data?.semesterStart ?? ''
    if (!timetable || start === '') return []
    const week = weekIndexOf(date, start)
    if (week <= 0 || week > timetable.weekCount) return []

    const column = weekdayIndex(date)
    const rowByIndex = new Map(timetable.rows.map((row) => [row.index, row]))
    const out: DayItem[] = []

    for (const [key, list] of Object.entries(timetable.cells)) {
      const [periodRaw, columnRaw] = key.split(':')
      if (Number(columnRaw) !== column) continue
      const period = Number(periodRaw)
      // 复用课表那份周次判定：单周 / 双周 / 指定周在两边是同一套规则
      for (const cell of visibleCourses(list, week)) {
        const row = rowByIndex.get(period)
        out.push({
          kind: 'course',
          key: `course:${date}:${cell.id}`,
          title: cell.courseName || t('timetable.unnamedCourse'),
          meta: [cell.teacher, cell.location].filter((part) => part !== '').join(' · '),
          start: row?.start ?? '',
          end: row?.end ?? '',
          week
        })
      }
    }
    return out
  }

  /** 这一天用户自己的日程 */
  function eventsOn(date: string): DayItem[] {
    if (!data) return []
    const out: DayItem[] = []
    for (const event of data.events) {
      if (occurrenceDates(event, date, date).length === 0) continue
      out.push({
        kind: 'event',
        key: event.id,
        title: event.title,
        meta: [event.location, repeatLabel(event.repeat), remindLabel(event.remindBefore)]
          .filter((part) => part !== '')
          .join(' · '),
        start: event.start,
        end: event.end,
        week: 0,
        event
      })
    }
    return out
  }

  function itemsOn(date: string): DayItem[] {
    return [...coursesOn(date), ...eventsOn(date)].sort(byStartThenTitle)
  }

  /* ------------------------------------------------------------ 渲染 */

  function paint(): void {
    const year = cursor.getFullYear()
    const month0 = cursor.getMonth()
    if (monthLabel) monthLabel.textContent = t('calendar.monthLabel', { year, month: month0 + 1 })

    const cells = monthGrid(year, month0)
    const today = toIsoDate(new Date())
    const semesterStart = data?.semesterStart ?? ''

    if (grid) {
      const heads = [1, 2, 3, 4, 5, 6, 7]
        .map((n) => `<div class="sb-cal__head">${escapeHtml(t(`calendar.weekday.${n}`))}</div>`)
        .join('')

      const body = cells
        .map((date) => {
          const inMonth = Number(date.slice(5, 7)) === month0 + 1
          const items = itemsOn(date)
          const classes = ['sb-cal__day']
          if (!inMonth) classes.push('sb-cal__day--out')
          if (date === today) classes.push('sb-cal__day--today')
          if (date === selected) classes.push('sb-cal__day--selected')

          const week = semesterStart === '' ? 0 : weekIndexOf(date, semesterStart)
          const weekTag =
            week > 0 ? `<span class="sb-cal__week">${escapeHtml(t('timetable.weekN', { n: week }))}</span>` : ''

          const list = items
            .slice(0, 4)
            .map(
              (item) =>
                `<span class="sb-cal__item sb-cal__item--${item.kind}">${escapeHtml(item.title)}</span>`
            )
            .join('')
          const more =
            items.length > 4
              ? `<span class="sb-cal__more">${escapeHtml(t('calendar.moreItems', { count: items.length - 4 }))}</span>`
              : ''

          return `<button class="${classes.join(' ')}" type="button" data-date="${date}">
            <span class="sb-cal__num">${escapeHtml(String(Number(date.slice(8, 10))))}</span>
            ${weekTag}
            <span class="sb-cal__list">${list}${more}</span>
          </button>`
        })
        .join('')

      grid.innerHTML = `<div class="sb-cal__grid">${heads}${body}</div>`
      grid.querySelectorAll<HTMLButtonElement>('[data-date]').forEach((button) => {
        button.addEventListener('click', () => {
          const date = button.dataset['date']
          if (!date) return
          selected = date
          beginNew(date)
          paint()
        })
      })
    }

    const monthItems = cells
      .filter((date) => Number(date.slice(5, 7)) === month0 + 1)
      .reduce((sum, date) => sum + itemsOn(date).length, 0)
    if (monthMeta) monthMeta.textContent = t('calendar.monthMeta', { count: monthItems })

    paintDay()
    paintNotify()
    paintSemester()
  }

  function paintDay(): void {
    if (dayTitle) dayTitle.textContent = t('calendar.day', { date: selected })
    const items = itemsOn(selected)
    if (dayMeta) dayMeta.textContent = t('calendar.itemCount', { count: items.length })

    if (dayItems) {
      if (items.length === 0) {
        dayItems.innerHTML = `<p class="sb-hint">${escapeHtml(t('calendar.dayEmpty'))}</p>`
      } else {
        dayItems.innerHTML = items
          .map((item) => {
            const time =
              item.start === ''
                ? escapeHtml(t('calendar.allDay'))
                : `${escapeHtml(item.start)}${item.end ? '–' + escapeHtml(item.end) : ''}`
            const action =
              item.kind === 'event'
                ? `<button class="sb-btn" type="button" data-edit="${escapeHtml(item.key)}">${escapeHtml(t('common.edit'))}</button>`
                : `<span class="sb-badge">${escapeHtml(t('calendar.fromTimetable'))}</span>`
            return `<div class="sb-cal__row" data-item-kind="${item.kind}">
              <span class="sb-cal__row-time">${time}</span>
              <span class="sb-cal__row-main">
                <span class="sb-cal__row-title">${escapeHtml(item.title)}</span>
                ${item.meta ? `<span class="sb-cal__row-meta">${escapeHtml(item.meta)}</span>` : ''}
              </span>
              ${action}
            </div>`
          })
          .join('')

        dayItems.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => {
          button.addEventListener('click', () => {
            const id = button.dataset['edit']
            if (id) beginEdit(id)
          })
        })
      }
    }
  }

  function paintSemester(): void {
    if (semesterInput) semesterInput.value = data?.semesterStart ?? ''
    if (!semesterNote) return
    semesterNote.textContent =
      (data?.semesterStart ?? '') === ''
        ? t('calendar.semesterUnset')
        : t('calendar.semesterSet', { date: data?.semesterStart ?? '' })
  }

  function paintNotify(): void {
    if (!notifyStatus) return
    if (!notify) {
      notifyStatus.textContent = t('common.loading')
      if (notifyBadge) notifyBadge.textContent = ''
      return
    }
    if (notifyBadge) {
      notifyBadge.textContent = notify.supported
        ? t('calendar.notify.badgeOn')
        : t('calendar.notify.badgeOff')
    }

    const parts: string[] = [
      notify.supported ? t('calendar.notify.supported') : t('calendar.notify.unsupported')
    ]
    if (notify.lastOutcome === 'delivered') parts.push(t('calendar.notify.delivered'))
    else if (notify.lastOutcome === 'failed') {
      parts.push(t('calendar.notify.failed', { reason: notify.lastDetail }))
    } else if (notify.lastOutcome === 'unverified') parts.push(t('calendar.notify.unverified'))
    else if (notify.lastOutcome === 'unsupported') parts.push(t('calendar.notify.notSupported'))
    if (notify.lastAt) {
      parts.push(t('calendar.notify.lastAt', { title: notify.lastTitle, count: notify.delivered }))
    }
    notifyStatus.textContent = parts.join(' ')
  }

  /* ------------------------------------------------------------ 表单 */

  function beginNew(date: string): void {
    editingId = ''
    if (formMode) formMode.textContent = t('calendar.newEvent')
    if (deleteButton) deleteButton.hidden = true
    if (titleInput) titleInput.value = ''
    if (dateInput) dateInput.value = date
    if (startInput) startInput.value = ''
    if (endInput) endInput.value = ''
    if (locationInput) locationInput.value = ''
    if (noteInput) noteInput.value = ''
    if (repeatInput) repeatInput.value = 'once'
    if (remindInput) remindInput.value = '0'
  }

  function beginEdit(id: string): void {
    const event = data?.events.find((item) => item.id === id)
    if (!event) return
    editingId = id
    if (formMode) formMode.textContent = t('calendar.editEvent')
    if (deleteButton) deleteButton.hidden = false
    if (titleInput) titleInput.value = event.title
    if (dateInput) dateInput.value = event.date
    if (startInput) startInput.value = event.start
    if (endInput) endInput.value = event.end
    if (locationInput) locationInput.value = event.location
    if (noteInput) noteInput.value = event.note
    if (repeatInput) repeatInput.value = event.repeat
    if (remindInput) remindInput.value = String(event.remindBefore)
    titleInput?.focus()
  }

  /* ------------------------------------------------------------ 动作 */

  async function load(): Promise<void> {
    try {
      const [calendar, table] = await Promise.all([
        unwrap(bridge().calendar.get()),
        unwrap(bridge().timetable.get())
      ])
      data = calendar
      timetable = table
      try {
        notify = await unwrap(bridge().calendar.notifyInfo())
      } catch {
        notify = null
      }
      beginNew(selected)
      paint()
    } catch (error) {
      toast(t('calendar.loadFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  async function saveSemester(): Promise<void> {
    try {
      data = await unwrap(
        bridge().calendar.save({ semesterStart: semesterInput?.value ?? '' })
      )
      paint()
      toast(t('calendar.semesterSaved'), 'success')
    } catch (error) {
      toast(t('calendar.saveFailed', { reason: tm(formatError(error)) }), 'error')
      paint()
    }
  }

  async function saveEvent(): Promise<void> {
    const title = (titleInput?.value ?? '').trim()
    const date = dateInput?.value ?? ''
    if (title === '') {
      toast(t('calendar.needTitle'), 'error')
      return
    }
    if (date === '') {
      toast(t('calendar.needDate'), 'error')
      return
    }
    try {
      data = await unwrap(
        bridge().calendar.upsertEvent({
          id: editingId || undefined,
          title,
          date,
          start: startInput?.value ?? '',
          end: endInput?.value ?? '',
          location: locationInput?.value ?? '',
          note: noteInput?.value ?? '',
          repeat: (repeatInput?.value ?? 'once') as CalendarRepeat,
          remindBefore: Number(remindInput?.value ?? 0)
        })
      )
      selected = date
      cursor = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1)
      beginNew(date)
      paint()
      toast(t('calendar.saved'), 'success')
    } catch (error) {
      toast(t('calendar.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  async function removeEvent(): Promise<void> {
    if (editingId === '') return
    try {
      data = await unwrap(bridge().calendar.removeEvent(editingId))
      beginNew(selected)
      paint()
      toast(t('calendar.removed'), 'success')
    } catch (error) {
      toast(t('calendar.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  async function testNotification(): Promise<void> {
    try {
      notify = await unwrap(bridge().calendar.testNotification())
      paintNotify()
    } catch (error) {
      toast(t('calendar.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  function shiftMonth(delta: number): void {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1)
    paint()
  }

  /* ------------------------------------------------------------ 事件 */

  element
    .querySelector('[data-action="back-home"]')
    ?.addEventListener('click', () => ctx.navigate('home'))
  element
    .querySelector('[data-action="prev-month"]')
    ?.addEventListener('click', () => shiftMonth(-1))
  element
    .querySelector('[data-action="next-month"]')
    ?.addEventListener('click', () => shiftMonth(1))
  element.querySelector('[data-action="today"]')?.addEventListener('click', () => {
    const now = new Date()
    cursor = new Date(now.getFullYear(), now.getMonth(), 1)
    selected = toIsoDate(now)
    beginNew(selected)
    paint()
  })
  element.querySelector('[data-action="jump"]')?.addEventListener('click', () => {
    const value = jumpInput?.value ?? ''
    if (value === '') {
      toast(t('calendar.needDate'), 'error')
      return
    }
    selected = value
    cursor = new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1)
    beginNew(value)
    paint()
  })
  element
    .querySelector('[data-action="save-semester"]')
    ?.addEventListener('click', () => void saveSemester())
  element
    .querySelector('[data-action="save-event"]')
    ?.addEventListener('click', () => void saveEvent())
  element
    .querySelector('[data-action="delete-event"]')
    ?.addEventListener('click', () => void removeEvent())
  element.querySelector('[data-action="new-event"]')?.addEventListener('click', () => {
    beginNew(selected)
  })
  element
    .querySelector('[data-action="test-notification"]')
    ?.addEventListener('click', () => void testNotification())

  /**
   * 系统通知之外的兜底：窗口开着的时候，提醒也在界面里弹一条。
   *
   * 实测 Windows 上 AUMID 没注册时系统通知会被静默丢掉（DECISIONS.md D-012），
   * 而「提醒丢了」的代价是用户错过作业截止。这一条成本极低，一定到得了。
   */
  const offReminder = bridge().events.onCalendarReminder((reminder) => {
    toast(t('calendar.reminderToast', { title: reminder.title }), 'info')
  })

  return {
    element,
    async onEnter() {
      cursor = new Date()
      selected = toIsoDate(new Date())
      await load()
    },
    dispose() {
      offReminder()
    }
  }
}
