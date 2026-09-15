import { dialog } from 'electron'

import { CHANNELS } from '@shared/channels'
import type { TimetableData, TimetableImageImportResult, TimetableMode, TimetablePatch } from '@shared/types'

import { context } from '../context'
import { MAX_PERIODS, MIN_PERIODS } from '../services/settings'
import { buildRows } from '../services/timetable'
import { broadcast, handle } from './index'

/**
 * 课程表 IPC。
 *
 * 组装规则：设置提供「形状」（模式 / 节数 / 表头），timetable.json 提供「内容」
 * （每节时间 / 单元格 / 图片）。每次响应都返回组装好的完整 TimetableData，
 * 渲染层拿到就能直接重绘，不需要自己拼状态。
 */

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} 取值不合法`)
  }
  return value as T
}

function compose(): TimetableData {
  const { settings, timetable } = context()
  const snapshot = settings.get()
  const content = timetable.get()
  return {
    mode: snapshot.timetable.mode,
    periodCount: snapshot.timetable.periodCount,
    weekdays: [...snapshot.timetable.weekdays],
    rows: buildRows(content.rows, snapshot.timetable.periodCount),
    cells: content.cells,
    weekCount: content.weekCount,
    currentWeek: content.currentWeek,
    images: content.images
  }
}

export function registerTimetableHandlers(): void {
  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_GET, () => compose())

  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_SAVE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Record<string, unknown>

    // 1. 形状部分交给设置存储（它自己有一整套范围与枚举校验）
    const patch: TimetablePatch = {}
    if ('mode' in input) {
      patch.mode = assertEnum<TimetableMode>(input['mode'], ['image', 'table'], 'mode')
    }
    if ('periodCount' in input) {
      const n = Math.trunc(Number(input['periodCount']))
      if (!Number.isFinite(n)) throw new Error('节数必须是数字')
      patch.periodCount = Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, n))
    }
    if ('weekdays' in input) {
      const days = input['weekdays']
      if (!Array.isArray(days) || days.length !== 8) throw new Error('表头必须是 8 列')
      patch.weekdays = days.map((day) => String(day ?? '').trim().slice(0, 12) || '—')
    }

    let settingsChanged = false
    if (Object.keys(patch).length > 0) {
      const next = context().settings.patch({ timetable: patch })
      settingsChanged = true
      broadcast(CHANNELS.EVENT_SETTINGS_CHANGED, next)
    }

    // 2. 内容部分交给课表存储
    let contentChanged = false
    if ('rows' in input) {
      context().timetable.setRows(input['rows'])
      contentChanged = true
    }
    if ('weekCount' in input || 'currentWeek' in input) {
      context().timetable.setWeekSettings({
        weekCount: input['weekCount'],
        currentWeek: input['currentWeek']
      })
      contentChanged = true
    }

    if (!settingsChanged && !contentChanged) {
      throw new Error('没有需要保存的内容')
    }
    return compose()
  })

  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_SET_CELL, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Record<string, unknown>
    const hasCell = Object.prototype.hasOwnProperty.call(input, 'cell')
    context().timetable.setCell(input['key'], hasCell ? input['cell'] : null)
    return compose()
  })

  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_REMOVE_CELL, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Record<string, unknown>
    context().timetable.removeCell(input['key'], input['id'])
    return compose()
  })

  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_SET_CELLS, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Record<string, unknown>
    context().timetable.setCells(input['cells'])
    return compose()
  })

  handle<unknown, TimetableData>(CHANNELS.TIMETABLE_REMOVE_IMAGE, (id) => {
    context().timetable.removeImage(id)
    return compose()
  })

  handle<unknown, { canceled: boolean; paths: string[] }>(CHANNELS.DIALOG_PICK_IMAGES, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择课表照片',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'heic', 'heif'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { canceled: true, paths: [] }
    return { canceled: false, paths: result.filePaths }
  })

  handle<unknown, TimetableImageImportResult>(CHANNELS.TIMETABLE_ADD_IMAGES, async (paths) => {
    if (!Array.isArray(paths)) throw new Error('paths 必须是数组')
    if (paths.length === 0) return { timetable: compose(), added: 0, errors: [] }

    // 一次最多处理 12 张，避免渲染层传一个超大数组把主进程拖住
    const { added, errors } = await context().timetable.addImages(paths.slice(0, 12).map((p) => String(p)))
    return { timetable: compose(), added, errors }
  })
}
