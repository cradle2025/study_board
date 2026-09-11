import { CHANNELS } from '@shared/channels'
import type { CourseCard, CourseCardInput } from '@shared/types'

import { context } from '../context'
import { handle } from './index'

/**
 * 课程卡片 IPC。
 *
 * 这里承担一件跨存储的编排：**新建卡片时自动建一篇同名笔记**。
 *
 * 需求原文：「卡片连接着一篇可编辑的笔记」「笔记的标题为对应卡片的课程名 + "_" + 授课老师」
 * 「课程卡片创建时自动同步创建笔记」。
 *
 * 为什么放在这里而不是 CardsStore 里：需要同时用到 cards 与 notes 两个存储。
 * 放进任何一个 store 都会让它持有另一个 store 的引用，耦合方向会变得很难看。
 */

/** 需求规定的笔记标题：课程名_老师；老师没填就只用课程名，避免出现 "课程名_" 这种尾巴 */
export function noteTitleFor(courseName: string, teacher: string): string {
  const name = courseName.trim()
  const who = teacher.trim()
  return who.length > 0 ? `${name}_${who}` : name
}

export function registerCardsHandlers(): void {
  handle<unknown, CourseCard[]>(CHANNELS.CARDS_LIST, () => context().cards.list())

  handle<unknown, CourseCard[]>(CHANNELS.CARDS_UPSERT, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as CourseCardInput
    const ctx = context()

    const before = input.id ? ctx.cards.find(input.id) : null
    const card = ctx.cards.upsert(input)

    // 1. 新建的卡片还没有笔记 → 建一篇，标题按需求拼
    if (!card.noteId) {
      try {
        const note = ctx.notes.create(noteTitleFor(card.courseName, card.teacher))
        ctx.cards.linkNote(card.id, note.id)
      } catch (error) {
        // 笔记建不出来不该让卡片也建不出来：卡片本身没有数据损失，
        // 用户之后可以在笔记页手动新建
        console.error('[cards] 自动创建笔记失败：', error)
      }
      return ctx.cards.list()
    }

    // 2. 卡片改了课程名 / 老师 → 笔记标题跟着改，但**只在这个标题还是自动生成的那个**时。
    //    用户如果自己给笔记改过名（比如加了章节后缀），那是他的命名，不该被我们覆盖
    if (before) {
      const note = ctx.notes.find(card.noteId)
      const oldPattern = noteTitleFor(before.courseName, before.teacher)
      const newPattern = noteTitleFor(card.courseName, card.teacher)
      if (note && note.title === oldPattern && oldPattern !== newPattern) {
        try {
          ctx.notes.rename(note.id, newPattern)
        } catch (error) {
          console.error('[cards] 同步重命名笔记失败：', error)
        }
      }
    }

    return ctx.cards.list()
  })

  handle<unknown, CourseCard[]>(CHANNELS.CARDS_DELETE, (id) => {
    // 只删卡片，**不动笔记**：笔记是用户自己写的内容，
    // 删一张卡片顺手把笔记也删了，是那种让人再也不想用第二次的体验
    return context().cards.remove(id)
  })

  handle<unknown, CourseCard[]>(CHANNELS.CARDS_REORDER, (ids) => {
    if (!Array.isArray(ids)) throw new Error('ids 必须是数组')
    return context().cards.reorder(ids.map((id) => String(id)))
  })
}
