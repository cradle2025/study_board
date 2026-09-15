import { CHANNELS } from '@shared/channels'
import type { CalendarData, CalendarNotificationInfo } from '@shared/types'

import { context } from '../context'
import { handle } from './index'

/**
 * 日历 / 日程 IPC。
 *
 * 与课表同一套约定：每个写操作都返回**整份** `CalendarData`，
 * 渲染层拿到就直接重绘，不用自己维护一份增量状态。
 */

function compose(): CalendarData {
  const content = context().calendar.get()
  return { semesterStart: content.semesterStart, events: content.events }
}

export function registerCalendarHandlers(): void {
  handle<unknown, CalendarData>(CHANNELS.CALENDAR_GET, () => compose())

  handle<unknown, CalendarData>(CHANNELS.CALENDAR_SAVE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Record<string, unknown>
    if (!('semesterStart' in input)) throw new Error('没有需要保存的内容')
    context().calendar.setSemesterStart(input['semesterStart'])
    return compose()
  })

  handle<unknown, CalendarData>(CHANNELS.CALENDAR_UPSERT_EVENT, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    context().calendar.upsertEvent(raw)
    return compose()
  })

  handle<unknown, CalendarData>(CHANNELS.CALENDAR_REMOVE_EVENT, (id) => {
    context().calendar.removeEvent(id)
    return compose()
  })

  handle<unknown, CalendarNotificationInfo>(CHANNELS.CALENDAR_NOTIFY_INFO, () =>
    context().reminders.info()
  )

  handle<unknown, CalendarNotificationInfo>(CHANNELS.CALENDAR_TEST_NOTIFICATION, () =>
    context().reminders.test()
  )
}
