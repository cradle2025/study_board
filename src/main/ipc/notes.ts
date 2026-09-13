import { CHANNELS } from '@shared/channels'
import type { LibraryChangedEvent, NoteDoc, NoteGroup, NoteMeta, NoteWriteInput } from '@shared/types'

import { context } from '../context'
import { NotesSync, type NotesSyncEvent } from '../services/notesSync'
import { broadcast, handle } from './index'

/**
 * 笔记 IPC。
 *
 * 一个容易被忽略的点：**删除笔记要把指向它的卡片解开关联**。
 * 否则卡片会留着一个已经不存在的 noteId，用户点「记笔记」时跳到一个空页面，
 * 而且没有任何提示说明为什么。这类「两个存储之间的引用完整性」必须在
 * 能同时看到两边的地方处理，也就是这里。
 *
 * 文件监听的装配也放在这里，理由是同一个：外部把笔记删掉同样要解开卡片关联。
 */

export function registerNotesHandlers(): void {
  handle<unknown, NoteMeta[]>(CHANNELS.NOTES_LIST, () => context().notes.list())

  handle<unknown, NoteDoc>(CHANNELS.NOTES_READ, (id) => context().notes.read(id))

  handle<unknown, NoteDoc>(CHANNELS.NOTES_CREATE, (raw) => {
    // 兼容两种调用：老的样子只给标题，新的可以带一个「建到哪个分组里」
    if (raw && typeof raw === 'object') {
      const input = raw as { title?: unknown; groupId?: unknown }
      return context().notes.create(String(input.title ?? ''), '', String(input.groupId ?? ''))
    }
    return context().notes.create(String(raw ?? ''))
  })

  handle<unknown, NoteDoc>(CHANNELS.NOTES_WRITE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    return context().notes.write(raw as NoteWriteInput)
  })

  handle<unknown, NoteDoc>(CHANNELS.NOTES_RENAME, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; title?: unknown }
    return context().notes.rename(input.id, String(input.title ?? ''))
  })

  handle<unknown, string>(CHANNELS.NOTES_BACKUP, (id) => context().notes.backup(id))

  handle<unknown, null>(CHANNELS.NOTES_DELETE, (id) => {
    const noteId = String(id ?? '')
    const ctx = context()
    const unlinked = ctx.cards.unlinkNote(noteId)
    if (unlinked > 0) console.info(`[notes] ${unlinked} 张卡片已解除与已删笔记的关联`)
    ctx.notes.remove(noteId)
    return null
  })

  /* -------------------------------------------------------------- 分组 */

  handle<unknown, NoteGroup[]>(CHANNELS.NOTES_GROUPS, () => context().notes.listGroups())

  handle<unknown, NoteGroup[]>(CHANNELS.NOTES_GROUP_CREATE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { name?: unknown; parentId?: unknown }
    return context().notes.createGroup(String(input.name ?? ''), String(input.parentId ?? ''))
  })

  handle<unknown, NoteGroup[]>(CHANNELS.NOTES_GROUP_RENAME, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; name?: unknown }
    return context().notes.renameGroup(input.id, String(input.name ?? ''))
  })

  handle<unknown, NoteGroup[]>(CHANNELS.NOTES_GROUP_MOVE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; parentId?: unknown }
    return context().notes.moveGroup(input.id, input.parentId)
  })

  /**
   * 删分组要广播，理由和删笔记一样：**界面别处的缓存要跟着失效**。
   * 组里的笔记并没有被删，只是归属变了，所以广播的是「库变了」而不是「笔记没了」。
   */
  handle<unknown, NoteGroup[]>(CHANNELS.NOTES_GROUP_REMOVE, (id) => {
    const result = context().notes.removeGroup(id)
    broadcast(CHANNELS.EVENT_LIBRARY_CHANGED, {
      kind: 'changed',
      fileName: '',
      id: ''
    })
    return result.groups
  })

  handle<unknown, NoteMeta[]>(CHANNELS.NOTES_SET_GROUP, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; groupId?: unknown }
    return context().notes.setNoteGroup(input.id, input.groupId)
  })
}

/* -------------------------------------------------------------- 文件监听 */

let sync: NotesSync | null = null

function toPayload(event: NotesSyncEvent): LibraryChangedEvent {
  if (event.kind === 'unlink') {
    return { kind: 'unlink', fileName: event.fileName, id: event.id }
  }
  return { kind: event.kind, fileName: event.note.fileName, id: event.note.id }
}

/**
 * 启动（或重启）笔记库文件监听。
 *
 * 必须能重复调用：设置里换过笔记库目录之后，存储对象整个换了一个新的，
 * 旧的监听还挂在老目录上，不重来一遍就会「列表是新的、变化是旧的」。
 */
export function startNotesSync(): void {
  sync?.stop()
  sync = new NotesSync(context().notes, (event) => {
    if (event.kind === 'unlink') {
      const unlinked = context().cards.unlinkNote(event.id)
      if (unlinked > 0) {
        console.info(`[notes]「${event.fileName}」被外部删除，${unlinked} 张卡片已解开关联`)
      }
    }
    broadcast(CHANNELS.EVENT_LIBRARY_CHANGED, toPayload(event))
  })
  sync.start()
}

/** 换了笔记库目录：重新接上监听，并让界面把手里那篇不属于新库的笔记放掉 */
export function restartNotesSync(): void {
  startNotesSync()
  broadcast(CHANNELS.EVENT_LIBRARY_CHANGED, { kind: 'reset', fileName: '', id: '' })
}
