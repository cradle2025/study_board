import type { CourseCard, CourseCardInput, TimetableData } from '@shared/types'

import { distinctCourses, type CourseRef } from '../lib/courses'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'
import { createCardGrid, type CardGridHandle } from './card-grid'

/**
 * 课程卡片的读写控制器。
 *
 * 与课表 / 门户同一套结构：控制器管业务与错误处理，视图只管长什么样。
 * 「从课表带过课程名和老师」的那份候选列表也在这里准备——它是数据问题，
 * 不是渲染问题。
 */

export interface CardControllerOptions {
  editable: boolean
  onData?(cards: readonly CourseCard[]): void
  onEdit?(card: CourseCard): void
  /** 点「记笔记」 */
  onOpenNote?(card: CourseCard): void
}

export interface CardController {
  grid: CardGridHandle
  current(): readonly CourseCard[]
  /** 课表里出现过的课程，供「从课表带过来」用 */
  courses(): readonly CourseRef[]
  load(): Promise<readonly CourseCard[]>
  upsert(input: CourseCardInput): Promise<void>
  dispose(): void
}

export function createCardController(options: CardControllerOptions): CardController {
  let cards: readonly CourseCard[] = []
  let timetable: TimetableData | null = null

  const apply = (next: readonly CourseCard[]): void => {
    cards = next
    grid.render(next)
    options.onData?.(next)
  }

  const grid: CardGridHandle = createCardGrid({
    editable: options.editable,

    onEdit(card) {
      options.onEdit?.(card)
    },

    onOpenNote(card) {
      options.onOpenNote?.(card)
    },

    async onRemove(card) {
      const confirmed = await confirmAction({
        title: `删除「${card.courseName}」这张卡片？`,
        // 明确说清「笔记不会被删」——不然用户会以为自己的笔记也没了
        message: '只删卡片，对应的笔记文件会保留在笔记库里，不会一起删掉。',
        confirmText: '删除卡片',
        danger: true
      })
      if (!confirmed) return

      try {
        apply(await unwrap(bridge().cards.remove(card.id)))
        toast('已删除卡片', 'success')
      } catch (error) {
        toast(`删除失败：${formatError(error)}`, 'error')
      }
    }
  })

  /** 课表只用来提供候选课程，拿不到也不影响卡片功能本身 */
  async function loadTimetable(): Promise<void> {
    try {
      timetable = await unwrap(bridge().timetable.get())
    } catch {
      timetable = null
    }
  }

  return {
    grid,
    current: () => cards,
    courses: () => distinctCourses(timetable),

    async load() {
      try {
        apply(await unwrap(bridge().cards.list()))
      } catch (error) {
        toast(`卡片加载失败：${formatError(error)}`, 'error')
      }
      await loadTimetable()
      return cards
    },

    async upsert(input) {
      try {
        apply(await unwrap(bridge().cards.upsert(input)))
        toast(input.id ? '已保存' : `已创建「${input.courseName}」并建好笔记`, 'success')
      } catch (error) {
        // 抛回去让表单继续开着：输入有误时不该让用户白填一遍
        throw new Error(formatError(error))
      }
    },

    dispose() {
      grid.dispose()
    }
  }
}
