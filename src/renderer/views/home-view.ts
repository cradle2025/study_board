import type { ViewContext, ViewInstance } from '../app-shell'
import { escapeHtml } from '../lib/html'
import { t, tm } from '../lib/i18n'
import { createPortalController } from '../components/portal-controller'
import { createTimetableController, type TimetableController } from '../components/timetable-controller'
import { bridge, formatError, unwrap } from '../lib/ipc'

/**
 * 概览页。
 *
 * 按需求「打开即见课表」，课表固定在最上方，且**与编辑页共用同一个面板**——
 * 所以首页上悬停预览、双击编辑、查看照片这些操作都能直接用，
 * 不用先跳去别的页面。
 */
export function createHomeView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('home.title'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('home.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="edit-timetable">${escapeHtml(t('home.timetableSettings'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('nav.timetable'))}</h2>
        <span class="sb-badge" data-role="timetable-meta">${escapeHtml(t('nav.group.module1'))}</span>
      </div>
      <div data-role="timetable-slot"></div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('nav.portal'))}</h2>
        <span class="sb-badge" data-role="portal-meta">${escapeHtml(t('nav.group.module2'))}</span>
      </div>
      <div class="sb-toolbar sb-toolbar--right">
        <button class="sb-btn" type="button" data-action="manage-portal">${escapeHtml(t('home.managePortal'))}</button>
      </div>
      <div data-role="portal-slot"></div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('home.cards'))}</h2>
        <span class="sb-badge" data-role="cards-meta">${escapeHtml(t('nav.group.module2'))}</span>
      </div>
      <div class="sb-toolbar sb-toolbar--right">
        <button class="sb-btn" type="button" data-action="manage-cards">${escapeHtml(t('nav.study'))}</button>
      </div>
      <p class="sb-hint" data-role="cards-slot">${escapeHtml(t('common.loading'))}</p>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="timetable-slot"]')
  const meta = element.querySelector<HTMLElement>('[data-role="timetable-meta"]')
  const portalSlot = element.querySelector<HTMLElement>('[data-role="portal-slot"]')
  const portalMeta = element.querySelector<HTMLElement>('[data-role="portal-meta"]')

  // 概览页只做快捷启动（不可编辑），管理动作都放在「网站门户」页
  const portal = createPortalController({
    editable: false,
    onData(list) {
      if (!portalMeta) return
      const shown = list.filter((site) => !site.hidden).length
      portalMeta.textContent = t('home.siteCount', { count: shown })
    }
  })
  portalSlot?.appendChild(portal.grid.element)

  const cardsMeta = element.querySelector<HTMLElement>('[data-role="cards-meta"]')
  const cardsSlot = element.querySelector<HTMLElement>('[data-role="cards-slot"]')

  /**
   * 概览页只报数字，不摆卡片。
   *
   * 这里原本写的是「可翻转的课程卡片 —— 开发中」，功能做好之后它就成了一句假话。
   * 换成一句真实的三态统计：打开应用第一眼想知道的是「这学期几门在修」，
   * 而不是把卡片网格再铺一遍——那是「课程与学习」页的事。
   */
  async function loadCards(): Promise<void> {
    if (!cardsMeta || !cardsSlot) return
    try {
      const cards = await unwrap(bridge().cards.list())
      const count = (status: string): number => cards.filter((card) => card.status === status).length
      cardsMeta.textContent = cards.length === 0 ? t('home.noCards') : t('home.cardCount', { count: cards.length })
      cardsSlot.textContent =
        cards.length === 0
          ? t('home.noCardsHint')
          : t('home.cardStats', { learning: count('learning'), wish: count('wish'), learned: count('learned') })
    } catch (error) {
      cardsSlot.textContent = t('home.cardStatsFailed', { reason: tm(formatError(error)) })
    }
  }

  const controller: TimetableController = createTimetableController({
    editable: true,
    errorPrefix: t('nav.timetable'),
    onData(data) {
      if (!meta) return
      if (data.mode === 'image') {
        meta.textContent = t('home.imageMode', { count: data.images.length })
      } else {
        const filled = Object.keys(data.cells).length
        meta.textContent = t('home.tableMode', { periods: data.periodCount, filled })
      }
    }
  })

  slot?.appendChild(controller.panel.element)

  element
    .querySelector('[data-action="edit-timetable"]')
    ?.addEventListener('click', () => ctx.navigate('timetable'))

  element
    .querySelector('[data-action="manage-portal"]')
    ?.addEventListener('click', () => ctx.navigate('portal'))

  element
    .querySelector('[data-action="manage-cards"]')
    ?.addEventListener('click', () => ctx.navigate('study'))

  // 概览页只读展示课表，一旦有数据就补一句空态提示
  const emptyHint = document.createElement('p')
  emptyHint.className = 'sb-hint sb-ttpanel__hint'
  emptyHint.hidden = true
  emptyHint.textContent = t('home.timetableEmpty')
  slot?.appendChild(emptyHint)

  return {
    element,
    async onEnter() {
      await controller.load()
      emptyHint.hidden = !controller.panel.isEmpty()
      await portal.load()
      await loadCards()
    },
    dispose() {
      controller.dispose()
      portal.dispose()
    }
  }
}
