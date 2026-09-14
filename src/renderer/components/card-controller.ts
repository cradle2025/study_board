import type { CourseStatus } from '@shared/course'
import type { CourseCard, CourseCardInput, TimetableData } from '@shared/types'

import { t, tm } from '../lib/i18n'
import { distinctCourses, type CourseRef } from '../lib/courses'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'
import { createCardGrid, type CardGridHandle, type CardGroup } from './card-grid'

/**
 * 课程卡片的读写控制器。
 *
 * 与课表 / 门户同一套结构：控制器管业务与错误处理，视图只管长什么样。
 * 「从课表带过课程名和老师」的那份候选列表也在这里准备——它是数据问题，
 * 不是渲染问题。
 *
 * 三态（想学 / 在学 / 已学）在这里**不做筛选**：控制器始终持有全部卡片，
 * 「当前看哪一档」由视图通过 `setFilter` 决定。原因和「已学库不是第二种存储」
 * 是同一条——数据只有一份，视图可以有多种切法。
 */

export interface CardControllerOptions {
  editable: boolean
  /** 只看满足条件的卡片。缺省显示全部 */
  filter?(card: CourseCard): boolean
  /** 把筛选出来的卡片切成若干组（已学库按学期分组用）。缺省不分组 */
  group?(cards: readonly CourseCard[]): readonly CardGroup[]
  onData?(all: readonly CourseCard[], visible: readonly CourseCard[]): void
  onEdit?(card: CourseCard): void
  /** 点「记笔记」 */
  onOpenNote?(card: CourseCard): void
  /** 点「资料」角标（跳到资料页看这门课的资料） */
  onMaterials?(card: CourseCard): void
  /** 这门课有几份资料（角标上的数字）。不提供则角标不带数字 */
  materialCount?(card: CourseCard): number
}

export interface CardController {
  grid: CardGridHandle
  /** 全部卡片，不受筛选影响 */
  current(): readonly CourseCard[]
  /** 课表里出现过的课程，供「从课表带过来」用 */
  courses(): readonly CourseRef[]
  setFilter(filter: ((card: CourseCard) => boolean) | null): void
  load(): Promise<readonly CourseCard[]>
  upsert(input: CourseCardInput): Promise<void>
  setStatus(card: CourseCard, status: CourseStatus): Promise<void>
  dispose(): void
}

/** 状态变了之后给用户一句人话，而不是「操作成功」 */
const STATUS_TOAST: Record<CourseStatus, string> = {
  learned: 'card.moved.learned',
  wish: 'card.moved.wish',
  learning: 'card.moved.learning'
}

export function createCardController(options: CardControllerOptions): CardController {
  let cards: readonly CourseCard[] = []
  let timetable: TimetableData | null = null
  let filter: ((card: CourseCard) => boolean) | null = options.filter ?? null

  const apply = (next: readonly CourseCard[]): void => {
    cards = next
    const visible = filter ? next.filter(filter) : next
    if (options.group) grid.renderGroups(options.group(visible))
    else grid.render(visible)
    options.onData?.(next, visible)
  }

  const grid: CardGridHandle = createCardGrid({
    editable: options.editable,

    onEdit(card) {
      options.onEdit?.(card)
    },

    onOpenNote(card) {
      options.onOpenNote?.(card)
    },

    onMaterials(card) {
      options.onMaterials?.(card)
    },

    materialCount(card) {
      return options.materialCount?.(card) ?? 0
    },

    async onStatus(card, status) {
      await setStatus(card, status)
    },

    async onRemove(card) {
      const confirmed = await confirmAction({
        title: t('card.removeConfirmTitle', { name: card.courseName }),
        // 明确说清「笔记不会被删」——不然用户会以为自己的笔记也没了
        message: t('card.removeConfirmBody'),
        confirmText: t('card.removeConfirm'),
        danger: true
      })
      if (!confirmed) return

      try {
        apply(await unwrap(bridge().cards.remove(card.id)))
        toast(t('card.removed'), 'success')
      } catch (error) {
        toast(t('card.removeFailed', { reason: tm(formatError(error)) }), 'error')
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

  async function setStatus(card: CourseCard, status: CourseStatus): Promise<void> {
    try {
      apply(await unwrap(bridge().cards.setStatus({ id: card.id, status })))
      toast(t(STATUS_TOAST[status]), 'success')
    } catch (error) {
      toast(t('card.changeFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  return {
    grid,
    current: () => cards,
    courses: () => distinctCourses(timetable),

    setFilter(next) {
      filter = next
      // 立刻按新筛选重绘一次：不重绘的话，切换页签后要等下一次数据变动才生效
      apply(cards)
    },

    async load() {
      try {
        apply(await unwrap(bridge().cards.list()))
      } catch (error) {
        toast(t('card.loadFailed', { reason: tm(formatError(error)) }), 'error')
      }
      await loadTimetable()
      return cards
    },

    async upsert(input) {
      try {
        apply(await unwrap(bridge().cards.upsert(input)))
        toast(input.id ? t('card.saved') : t('card.created', { name: input.courseName }), 'success')
      } catch (error) {
        // 抛回去让表单继续开着：输入有误时不该让用户白填一遍
        throw new Error(formatError(error))
      }
    },

    setStatus,

    dispose() {
      grid.dispose()
    }
  }
}
