import type { CourseStatus } from '@shared/course'
import { MAX_CARD_LEVEL } from '@shared/limits'
import type { CourseCard } from '@shared/types'

import { t } from '../lib/i18n'
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
 *
 * 三种状态（想学 / 在学 / 已学）**共用这一个渲染器**：合并成两套只会让
 * 「翻转、双击、记笔记」这些共用行为各写一遍，迟早只改一边。
 * 差异集中在两处：正面渲染（`frontHtml`）和脚部的状态按钮。
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
  /** 点状态流转按钮（归档 / 想学 / 开始学 / 移回在学） */
  onStatus?(card: CourseCard, status: CourseStatus): void
  /** 点「资料」角标。回调存在才渲染角标；每张卡显示几份资料由 options.materialCount 决定 */
  onMaterials?(card: CourseCard): void
  /** 资料数（按 cardId 统计）。不提供则角标不显示数字 */
  materialCount?(card: CourseCard): number
}

/** 一组卡片。`label` 为空表示这一组不显示标题（也就是不分组时的样子） */
export interface CardGroup {
  label: string
  cards: readonly CourseCard[]
}

export interface CardGridHandle {
  element: HTMLElement
  /** 不分组渲染 */
  render(cards: readonly CourseCard[]): void
  /** 分组渲染。已学库按学期分组走这条 */
  renderGroups(groups: readonly CardGroup[]): void
  count(): number
  /** 空态文案跟着页签走——「在学」和「想学」空着说的是两件事 */
  setEmptyText(text: string): void
  dispose(): void
}

/**
 * 脚部的状态流转按钮，**按卡片自身的状态决定**，而不是看当前在哪个页面。
 *
 * 同一个网格同时服务「在学」页签、「想学」页签和归档页；按状态算才不会出现
 * 「在一张想学的卡片上找不到『开始学』」这种错位。
 *
 * 每张卡片只给一条最可能的下一步（在学的额外给一条「想学」，因为
 * 「这学期不修了、下学期再说」是常事），其余改动走双击表单里的状态下拉——
 * 一个脚部塞四五个按钮，卡片会变成一排工具条。
 */
const STATUS_ACTIONS: Record<
  CourseStatus,
  readonly { to: CourseStatus; labelKey: string; titleKey: string }[]
> = {
  learning: [
    { to: 'learned', labelKey: 'card.act.archive', titleKey: 'card.act.archiveTitle' },
    { to: 'wish', labelKey: 'card.act.wish', titleKey: 'card.act.wishTitle' }
  ],
  wish: [{ to: 'learning', labelKey: 'card.act.start', titleKey: 'card.act.startTitle' }],
  learned: [{ to: 'learning', labelKey: 'card.act.moveBack', titleKey: 'card.act.moveBackTitle' }]
}

/**
 * 难度 / 掌握程度：0 表示没填。
 *
 * 用「标签在上、圆点在下」的小块，而不是把标签和值甩到左右两端——
 * 后者在两个评分并排时会拉出一大片空白，看着又挤又散。
 */
function ratingHtml(label: string, value: number): string {
  const dots: string[] = []
  for (let i = 1; i <= MAX_CARD_LEVEL; i += 1) {
    dots.push(`<span class="sb-course__dot${i <= value ? ' sb-course__dot--on' : ''}"></span>`)
  }
  const text = value > 0 ? `${value} / ${MAX_CARD_LEVEL}` : t('card.unset')
  return `
    <div class="sb-course__rating">
      <span class="sb-course__rating-label">${escapeHtml(label)}</span>
      <span class="sb-course__dots" title="${escapeHtml(`${label}：${text}`)}">${dots.join('')}</span>
    </div>
  `
}

function nameHtml(card: CourseCard): string {
  return `
    <div class="sb-course__id">
      <div class="sb-course__name" title="${escapeHtml(card.courseName)}">${escapeHtml(card.courseName)}</div>
      ${card.teacher ? `<div class="sb-course__teacher">${escapeHtml(card.teacher)}</div>` : ''}
    </div>
  `
}

/**
 * 想学的卡片正面。
 *
 * 这门课还没上过，打分 / 难度 / 掌握全是空的——照搬在学卡片的正面会得到
 * 一排「未填」，等于什么都没说。换成「想修的理由 + 计划学期」，
 * 这才是愿望单里真正有信息量、也真正会被回看的部分。
 */
function wishFrontHtml(card: CourseCard): string {
  const reason = card.reason.trim()
  const semester = card.semester.trim()
  return `
    <div class="sb-itemcard__face sb-itemcard__face--front">
      <div class="sb-course__top">${nameHtml(card)}</div>
      <div class="sb-course__wish">
        <div class="sb-course__block-title">${escapeHtml(t('card.reasonTitle'))}</div>
        ${
          reason
            ? `<p class="sb-course__wish-text">${escapeHtml(reason)}</p>`
            : `<p class="sb-course__wish-text sb-course__wish-text--empty">${escapeHtml(t('card.reasonEmpty'))}</p>`
        }
      </div>
      <div class="sb-course__footrow">
        <span class="sb-course__chip" title="${escapeHtml(t('card.plannedWhen'))}">${escapeHtml(t('card.planned', { term: semester || t('card.termUnset') }))}</span>
      </div>
    </div>
  `
}

function frontHtml(card: CourseCard): string {
  if (card.status === 'wish') return wishFrontHtml(card)

  // 打分是「结果」，做成右上角的徽章；没填就整个不渲染，不留一个空占位
  const score = card.score.trim()
  const badge = score.length > 0
    ? `<span class="sb-course__score" title="${escapeHtml(t('card.scoreTitle', { score }))}">${escapeHtml(score)}</span>`
    : ''

  return `
    <div class="sb-itemcard__face sb-itemcard__face--front">
      <div class="sb-course__top">
        ${nameHtml(card)}
        ${badge}
      </div>
      <div class="sb-course__ratings">
        ${ratingHtml(t('card.difficulty'), card.difficulty)}
        ${ratingHtml(t('card.mastery'), card.mastery)}
      </div>
    </div>
  `
}

function backHtml(card: CourseCard): string {
  // 想学的课没有给分标准和课程结构可写，与其显示一句「背面还空着」，
  // 不如说清楚这一面是干什么的、什么时候再回来填
  if (card.status === 'wish') {
    return `
      <div class="sb-itemcard__face sb-itemcard__face--back">
        <div class="sb-course__block">
          <div class="sb-course__block-title">${escapeHtml(t('card.notTakenTitle'))}</div>
          <p class="sb-course__block-body">${escapeHtml(t('card.notTakenBody'))}</p>
        </div>
      </div>
    `
  }

  const hasContent = card.gradingPolicy.length > 0 || card.outline.length > 0
  if (!hasContent) {
    return `
      <div class="sb-itemcard__face sb-itemcard__face--back">
        <div class="sb-course__empty">
          <div class="sb-course__empty-title">${escapeHtml(t('card.backEmptyTitle'))}</div>
          <p class="sb-course__empty-hint">${escapeHtml(t('card.backEmptyHint'))}</p>
        </div>
      </div>
    `
  }

  const block = (title: string, body: string): string => `
    <div class="sb-course__block">
      <div class="sb-course__block-title">${escapeHtml(title)}</div>
      <p class="sb-course__block-body">${escapeHtml(body)}</p>
    </div>
  `

  const parts: string[] = []
  // 学期只在背面顶端带一行：正面高度是写死的，再多塞一行会把课程名挤到一行去
  if (card.semester.length > 0) {
    parts.push(`<div class="sb-course__semester">${escapeHtml(t('card.termLine', { term: card.semester }))}</div>`)
  }
  if (card.gradingPolicy.length > 0) parts.push(block(t('card.grading'), card.gradingPolicy))
  if (card.outline.length > 0) parts.push(block(t('card.outline'), card.outline))
  return `<div class="sb-itemcard__face sb-itemcard__face--back">${parts.join('')}</div>`
}

function statusButtonsHtml(card: CourseCard, enabled: boolean): string {
  if (!enabled) return ''
  const actions = STATUS_ACTIONS[card.status]
  return actions
    .map(
      (action) => `
        <button class="sb-itemcard__status" type="button" data-act="status" data-to="${action.to}"
                title="${escapeHtml(t(action.titleKey))}">${escapeHtml(t(action.labelKey))}</button>
      `
    )
    .join('')
}

function cardHtml(
  card: CourseCard,
  editable: boolean,
  statusEnabled: boolean,
  materialsEnabled: boolean,
  materialCount: number | null
): string {
  const linked = card.noteId.length > 0
  const materialButton =
    materialsEnabled && materialCount !== null
      ? `<button class="sb-itemcard__mats" type="button" data-act="materials"
              title="${escapeHtml(t('card.materials'))}">▣ ${materialCount > 0 ? materialCount : escapeHtml(t('card.materialsShort'))}</button>`
      : ''
  return `
    <div class="sb-itemcard" data-id="${escapeHtml(card.id)}" data-status="${card.status}">
      <div class="sb-itemcard__flip" data-act="flip" role="button" tabindex="0"
           aria-label="${escapeHtml(t('card.cardLabel', { name: card.courseName }))}">
        <div class="sb-itemcard__inner">
          ${frontHtml(card)}
          ${backHtml(card)}
        </div>
      </div>
      <div class="sb-itemcard__foot">
        <button class="sb-itemcard__note" type="button" data-act="note"
                title="${escapeHtml(t(linked ? 'card.openNote' : 'study.noNoteYet'))}">
          ${escapeHtml(t('card.takeNotes'))}
        </button>
        ${materialButton}
        <span class="sb-itemcard__actions">
          ${statusButtonsHtml(card, statusEnabled)}
          ${
            editable
              ? `<button class="sb-iconbtn" type="button" data-act="edit" title="${escapeHtml(t('common.edit'))}" aria-label="${escapeHtml(t('card.editLabel', { name: card.courseName }))}">✎</button>
                 <button class="sb-iconbtn sb-iconbtn--danger" type="button" data-act="remove" title="${escapeHtml(t('card.removeTitle'))}" aria-label="${escapeHtml(t('card.removeLabel', { name: card.courseName }))}">✕</button>`
              : ''
          }
        </span>
      </div>
    </div>
  `
}

export function createCardGrid(options: CardGridOptions): CardGridHandle {
  const element = document.createElement('div')
  element.className = 'sb-cards'

  // 内层容器不带网格样式：分组渲染时它装的是若干个「组」，每个组里才是网格。
  // 若直接用网格当容器，组本身会被当成一个格子，整页布局就散了
  const body = document.createElement('div')
  body.className = 'sb-cards__body'
  element.appendChild(body)

  const empty = document.createElement('p')
  empty.className = 'sb-empty'
  empty.textContent = options.editable
    ? t('card.emptyWithAction')
    : t('card.empty')
  empty.hidden = true
  element.appendChild(empty)

  let cards: readonly CourseCard[] = []
  const statusEnabled = typeof options.onStatus === 'function'
  const materialsEnabled = typeof options.onMaterials === 'function'

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

    const actionEl = target.closest<HTMLElement>('[data-act]')
    const act = actionEl?.dataset['act']
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
      case 'status': {
        const to = actionEl?.dataset['to']
        if (to) options.onStatus?.(card, to as CourseStatus)
        break
      }
      case 'materials':
        options.onMaterials?.(card)
        break
      default:
        break
    }
  }

  function onDoubleClick(event: Event): void {
    const target = event.target as HTMLElement | null
    // 脚部的按钮不该被当成「双击卡片进编辑」——双击「归档」会顺手把表单也弹出来
    if (target?.closest('.sb-itemcard__foot')) return
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

  body.addEventListener('click', onClick)
  body.addEventListener('dblclick', onDoubleClick)
  body.addEventListener('keydown', onKeyDown)

  function renderGroups(groups: readonly CardGroup[]): void {
    // 事件委托挂在内层容器上，重绘只换 innerHTML，监听器不用重新绑
    cards = groups.flatMap((group) => group.cards)

    body.innerHTML = groups
      .filter((group) => group.cards.length > 0)
      .map((group) => {
        const list = `<div class="sb-cards__grid">${group.cards
          .map((card) => {
            const count =
              materialsEnabled && options.materialCount
                ? options.materialCount(card)
                : null
            return cardHtml(card, options.editable, statusEnabled, materialsEnabled, count)
          })
          .join('')}</div>`
        if (group.label.length === 0) return list
        return `
          <section class="sb-cards__group">
            <div class="sb-cards__group-head">
              <h3 class="sb-cards__group-title">${escapeHtml(group.label)}</h3>
              <span class="sb-cards__group-count">${escapeHtml(t('card.groupCount', { count: group.cards.length }))}</span>
            </div>
            ${list}
          </section>
        `
      })
      .join('')

    empty.hidden = cards.length > 0
  }

  return {
    element,
    render(next) {
      renderGroups([{ label: '', cards: next }])
    },
    renderGroups,
    count() {
      return cards.length
    },
    setEmptyText(text) {
      empty.textContent = text
    },
    dispose() {
      window.clearTimeout(pendingFlip)
      body.removeEventListener('click', onClick)
      body.removeEventListener('dblclick', onDoubleClick)
      body.removeEventListener('keydown', onKeyDown)
    }
  }
}
