import { semesterRank, UNKNOWN_SEMESTER } from '@shared/course'
import type { CourseCard } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { openCardForm } from '../components/card-form'
import { createCardController, type CardController } from '../components/card-controller'
import type { CardGroup } from '../components/card-grid'
import { toast } from '../lib/ipc'

/**
 * 已学库。
 *
 * 「归档」不是第二种存储——它就是把卡片的状态改成 `learned`。所以这一页做的事
 * 只有两件：按学期把 `learned` 的卡片摆出来，以及把卡片挪回在学。
 * 笔记关联、改名跟随这些逻辑因此一行都不用重写，它们跟着卡片走。
 *
 * 为什么给已学单开一页而不是在「课程与学习」里加第三个页签：
 * 已学是「翻旧账」的场景——查给分标准、翻复习资料、跟人吐槽某门课，
 * 用的时候人已经不在学期里了。混在日常列表里只会把在学那几门挤短。
 *
 * 这里仍然允许编辑与删除（`editable: true`）：
 * 归档之后才想起来「打分忘了填」太常见了，若这里只能看，
 * 那张卡片就再也没有入口能改了。
 */

/**
 * 按学期分组，新的在上。
 *
 * 认不出写法的学期（有人会写「大三上」「2025 秋」）排在最后：
 * 学期是自由填的一个格子，不能因为它不符合某一种格式就把整页顺序搞乱。
 */
function groupBySemester(cards: readonly CourseCard[]): readonly CardGroup[] {
  const buckets = new Map<string, CourseCard[]>()
  for (const card of cards) {
    const key = card.semester.trim() || UNKNOWN_SEMESTER
    const bucket = buckets.get(key)
    if (bucket) bucket.push(card)
    else buckets.set(key, [card])
  }

  return [...buckets.entries()]
    .map(([label, list]) => ({ label, cards: list }))
    .sort((a, b) => semesterRank(b.label) - semesterRank(a.label))
}

export function createArchivedView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">已学库</h1>
        <p class="sb-view__desc">修完的课都收在这里，按学期排好。想翻复习资料就点「记笔记」；还要接着上，就点「移回在学」。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="to-study">课程与学习</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">已学课程</h2>
        <span class="sb-badge" data-role="meta">—</span>
      </div>
      <div data-role="cards"></div>
      <p class="sb-hint">
        归档只是把卡片的状态标成「已学」，笔记一篇都不会少；
        双击卡片还能补打分、给分标准和课程结构——这些通常是修完之后才写得出来。
      </p>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="cards"]')
  const meta = element.querySelector<HTMLElement>('[data-role="meta"]')

  const controller: CardController = createCardController({
    editable: true,
    filter: (card) => card.status === 'learned',
    group: groupBySemester,

    onData(_all, visible) {
      if (!meta) return
      if (visible.length === 0) {
        meta.textContent = '还没有已学的课'
        return
      }
      const semesters = new Set(visible.map((card) => card.semester.trim() || UNKNOWN_SEMESTER))
      meta.textContent = `${visible.length} 门 · ${semesters.size} 个学期`
    },

    onEdit(card) {
      void openCardForm(card, controller.courses(), 'learned').then(async (result) => {
        if (!result) return
        try {
          await controller.upsert({ id: card.id, ...result })
          // 在归档页把状态改成别的，卡片会当场消失——说一句它去哪了，
          // 否则看起来像「改完就没了」
          if (result.status !== 'learned') {
            toast(result.status === 'wish' ? '已挪到愿望单' : '已挪回在学，去「课程与学习」找', 'info')
          }
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    },

    onOpenNote(card) {
      if (card.noteId.length === 0) {
        toast('这门课还没有笔记，去笔记页新建一篇', 'info')
        ctx.navigate('notes')
        return
      }
      ctx.openNote(card.noteId)
    }
  })

  slot?.appendChild(controller.grid.element)

  element.querySelector('[data-action="to-study"]')?.addEventListener('click', () => ctx.navigate('study'))

  return {
    element,
    async onEnter() {
      controller.grid.setEmptyText(
        '已学库还是空的。在「课程与学习」里修完一门课，点卡片上的「归档」，它就会出现在这里。'
      )
      await controller.load()
    },
    dispose() {
      controller.dispose()
    }
  }
}
