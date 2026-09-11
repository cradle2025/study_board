import { CHANNELS } from '@shared/channels'
import { EXPORT_EXTENSIONS } from '@shared/limits'
import type { ExportNoteRequest, ExportNoteResult } from '@shared/types'

import { exportNote } from '../services/exporter'
import { handle } from './index'

/**
 * 导出 IPC。
 *
 * 入参当成不可信数据：格式必须在白名单里，笔记 id 交给存储层去找
 * （找不到会抛「笔记不存在」，不会泄露任何路径信息）。
 */
export function registerExportHandlers(): void {
  handle<unknown, ExportNoteResult>(CHANNELS.EXPORT_NOTE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Partial<ExportNoteRequest>

    const format = String(input.format ?? '')
    if (!(format in EXPORT_EXTENSIONS)) throw new Error('不支持的导出格式')

    const targetPath = typeof input.targetPath === 'string' ? input.targetPath : undefined

    return exportNote({
      noteId: String(input.noteId ?? ''),
      format: format as ExportNoteRequest['format'],
      ...(targetPath ? { targetPath } : {})
    })
  })
}
