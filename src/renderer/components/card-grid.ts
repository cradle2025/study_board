import { MAX_CARD_LEVEL } from '@shared/limits'
import type { CourseCard } from '@shared/types'

import { escapeHtml } from '../lib/html'

/**
 * 课程卡片网格：概览页与「课程与学习」页共用同一个渲染器。
 *
 * 交互约定来自需求：
 *  - **单击**  → 卡片翻转（正面课程信息 / 背面给分标准与课程结构）
 *  - **双击**  → 就地修改（与课表单元格一致的操作习惯）
 *  - **下方**  → 「记笔记」按钮，跳到对应笔记
 *
 * 单击 / 双击共存的处理：点击后等 200ms 再翻转，如果这期间来了第二下就不翻、
 * 直接进编辑。反过来先翻再翻回去虽然也能实现，但会有一次明显的「翻两下」抖动。
 */

/** 等第二击的窗口。太短会漏判双击，太长会让翻转显得迟钝 */
const DOUBLE_CLICK_MS = 200

export interface CardGridOptions {
  editable: boolean
  onFlip?(card: CourseCard, flipped: boolean): void
  onEdit?(card: CourseCard): void
  onRemove?(card: CourseCard): void
  /** 点「记笔记」 */
  onOpenNote?(card: CourseCard): void
}

export interface CardGridHandle {
  element: HTMLElement
  render(cards: readonly CourseCard[]): void
  count(): number
  dispose(): void
}

/** 难度 / 掌握程度：0 表示没填，用圆点直观显示等级 */
function levelHtml(label: string, value: number): string {
  const dots: string[] = []
  for (let i = 1; i <= MAX_CARD_LEVEL; i += 1) {
    dots.push(`<span class="sb-card__dot${i <= value ? ' sb-card__dot--on' : ''}"></span>`)
  }
  const text = value > 0 ? `${value} / ${MAX_CARD_LEVEL}` : '未填'
  return `
    <div class="sb-card__level">
      <span class="sb-card__level-label">${escapeHtml(label)}</span>
      <span class="sb-card__dots" title="${escapeHtml(text)}">${dots.join('')}</span>
    </div>
  `
}

function metaLine(label: string, value: string): string {
  const shown = value.trim().length > 0 ? value : '—'
  const dim = value.trim().length > 0 ? '' : ' sb-card__value--empty'
  return `
    <div class="sb-card__meta-row">
      <span class="sb-card__meta-label">${escapeHtml(label)}</span>
      <span class="sb-card__value${dim}">${escapeHtml(shown)}</span>
    </div>
  `
}

function frontHtml(card: CourseCard): string {
  return `
    <div class="sb-card__face sb-card__face--front">
      <div class="sb-card__name">${escapeHtml(card.courseName)}</div>
      <div class="sb-card__teacher">${escapeHtml(card.teacher || '未填老师')}</div>
      <div class="sb-card__meta">
        ${metaLine('打分', card.score)}
        ${levelHtml('难度', card.difficulty)}
        ${levelHtml('掌握', card.mastery)}
      </div>
    </div>
  `
}

function backHtml(card: CourseCard): string {
  const hasContent = card.gradingPolicy.length > 0 || card.outline.length > 0
  if (!hasContent) {
    return `
      <div class="sb-card__face sb-card__face--back">
        <div class="sb-card__back-title">背面还空着</div>
        <p class="sb-card__back-empty">双击卡片，补上「给分标准」和「课程大致结构」。</p>
      </div>
    `
  }
  const parts: string[] = []
  if (card.gradingPolicy.length > 0) {
    parts.push(`
      <div class="sb-card__block">
        <div class="sb-card__block-title">给分标准</div>
        <p class="sb-card__block-body">${escapeHtml(card.gradingPolicy)}</p>
      </div>
    `)
  }
  if (card.outline.length > 0) {
    parts.push(`
      <div class="sb-card__block">
        <div class="sb-card__block-title">课程结构</div>
        <p class="sb-card__block-body">${escapeHtml(card.outline)}</p>
      </div>
    `)
  }
  return `<div class="sb-card__face sb-card__face--back">${parts.join('')}</div>`
}

function cardHtml(card: CourseCard, editable: boolean): string {
  const linked = card.noteId.length > 0
  return `
    <div class="sb-itemcard" data-id="${escapeHtml(card.id)}">
      <div class="sb-itemcard__flip" data-act="flip" role="button" tabindex="0"
           aria-label="${escapeHtml(card.courseName)}，点击翻转，双击修改">
        <div class="sb-itemcard__inner">
          ${frontHtml(card)}
          ${backHtml(card)}
        </div>
      </div>
      <div class="sb-itemcard__foot">
        <button class="sb-btn sb-btn--ghost sb-itemcard__note" type="button" data-act="note"
                title="${linked ? '打开这门课的笔记' : '这门课还没有笔记，去笔记页新建一篇'}">
          记笔记
        </button>
        ${
          editable
            ? `<span class="sb-itemcard__actions">
                 <button class="sb-portal__action" type="button" data-act="edit" title="修改" aria-label="修改 ${escapeHtml(card.courseName)}">✎</button>
                 <button class="sb-portal__action sb-portal__action--danger" type="button" data-act="remove" title="删除卡片" aria-label="删除 ${escapeHtml(card.courseName)}">✕</button>
               </span>`
            : ''
        }
      </div>
    </div>
  `
}

export function createCardGrid(options: CardGridOptions): CardGridHandle {
  const element = document.createElement('div')
  element.className = 'sb-cards'

  const grid = document.createElement('div')
  grid.className = 'sb-cards__grid'
  element.appendChild(grid)

  const empty = document.createElement('p')
  empty.className = 'sb-empty'
  empty.textContent = options.editable
    ? '还没有课程卡片。点「新建卡片」开始，课程名和老师可以直接从课表带过来。'
    : '还没有课程卡片，去「课程与学习」页添加。'
  empty.hidden = true
  element.appendChild(empty)

  let cards: readonly CourseCard[] = []

  /** 待触发的翻转：双击到来时会被取消 */
  let pendingFlip = 0

  function findCard(id: string | undefined): CourseCard | undefined {
    return id ? cards.find((card) => card.id === id) : undefined
  }

  function flip(host: HTMLElement): void {
    const flipped = host.classList.toggle('sb-itemcard--flipped')
    host.querySelector('.sb-itemcard__flip')?.setAttribute('aria-pressed', flipped ? 'true' : 'false')
    const card = findCard(host.dataset['id'])
    if (card) options.onFlip?.(card, flipped)
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    const host = target.closest<HTMLElement>('.sb-itemcard')
    if (!host) return

    const act = target.closest<HTMLElement>('[data-act]')?.dataset['act']
    const card = findCard(host.dataset['id'])
    if (!card) return

    if (act === 'flip') {
      // 延迟翻转，给双击留出判断窗口
      window.clearTimeout(pendingFlip)
      pendingFlip = window.setTimeout(() => flip(host), DOUBLE_CLICK_MS)
      return
    }

    event.stopPropagation()
    switch (act) {
      case 'edit':
        options.onEdit?.(card)
        break
      case 'remove':
        options.onRemove?.(card)
        break
      case 'note':
        options.onOpenNote?.(card)
        break
      default:
        break
    }
  }

  function onDoubleClick(event: Event): void {
    const target = event.target as HTMLElement | null
    const host = target?.closest<HTMLElement>('.sb-itemcard')
    if (!host) return
    // 取消刚才排队的那次翻转，否则会在弹编辑框的同时把卡片翻过去
    window.clearTimeout(pendingFlip)
    const card = findCard(host.dataset['id'])
    if (card && options.editable) options.onEdit?.(card)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target as HTMLElement | null
    if (target?.dataset['act'] !== 'flip') return
    const host = target.closest<HTMLElement>('.sb-itemcard')
    if (!host) return
    event.preventDefault()
    flip(host)
  }

  grid.addEventListener('click', onClick)
  grid.addEventListener('dblclick', onDoubleClick)
  grid.addEventListener('keydown', onKeyDown)

  return {
    element,
    render(next) {
      cards = next
      // 重绘会丢掉翻转状态，这是可接受的：卡片内容变了，回到正面反而更清楚
      grid.innerHTML = next.map((card) => cardHtml(card, options.editable)).join('')
      empty.hidden = next.length > 0
    },
    count() {
      return cards.length
    },
    dispose() {
      window.clearTimeout(pendingFlip)
      grid.removeEventListener('click', onClick)
      grid.removeEventListener('dblclick', onDoubleClick)
      grid.removeEventListener('keydown', onKeyDown)
    }
  }
}
