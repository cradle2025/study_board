import { CHANNELS } from '@shared/channels'
import type { NoteDoc, NoteMeta, NoteWriteInput } from '@shared/types'

import { context } from '../context'
import { handle } from './index'

/**
 * 笔记 IPC。
 *
 * 一个容易被忽略的点：**删除笔记要把指向它的卡片解开关联**。
 * 否则卡片会留着一个已经不存在的 noteId，用户点「记笔记」时跳到一个空页面，
 * 而且没有任何提示说明为什么。这类「两个存储之间的引用完整性」必须在
 * 能同时看到两边的地方处理，也就是这里。
 */

export function registerNotesHandlers(): void {
  handle<unknown, NoteMeta[]>(CHANNELS.NOTES_LIST, () => context().notes.list())

  handle<unknown, NoteDoc>(CHANNELS.NOTES_READ, (id) => context().notes.read(id))

  handle<unknown, NoteDoc>(CHANNELS.NOTES_CREATE, (title) => context().notes.create(String(title ?? '')))

  handle<unknown, NoteDoc>(CHANNELS.NOTES_WRITE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    return context().notes.write(raw as NoteWriteInput)
  })

  handle<unknown, NoteDoc>(CHANNELS.NOTES_RENAME, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; title?: unknown }
    return context().notes.rename(input.id, String(input.title ?? ''))
  })

  handle<unknown, null>(CHANNELS.NOTES_DELETE, (id) => {
    const noteId = String(id ?? '')
    const ctx = context()
    const unlinked = ctx.cards.unlinkNote(noteId)
    if (unlinked > 0) console.info(`[notes] ${unlinked} 张卡片已解除与已删笔记的关联`)
    ctx.notes.remove(noteId)
    return null
  })
}
