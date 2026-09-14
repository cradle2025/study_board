import type { CourseStatus } from '@shared/course'
import { escapeHtml } from '../lib/html'
import { t } from '../lib/i18n'

import type { ViewContext, ViewInstance } from '../app-shell'
import { openCardForm } from '../components/card-form'
import { createCardController, type CardController } from '../components/card-controller'
import { createPortalController } from '../components/portal-controller'
import { bridge, toast, unwrap } from '../lib/ipc'

/**
 * 模块二：课程与学习。
 *
 * 需求里这一块是「以卡片形式展示课程（卡片可点击翻转）」，
 * 卡片连接着一篇可编辑的笔记，正面是课程名 / 老师 / 打分 / 难度 / 掌握程度，
 * 背面是给分标准与课程结构。
 *
 * 一个刻意的取舍：**新建卡片时课程名和老师可以从课表直接带过来**
 * （需求：「如果前面的课程表是以表格方式填写则……直接从表格中自动拷贝填写」）。
 * 但不强制——课表还没填、或者想加一门课表里没有的课，也应该能建卡片。
 *
 * 后来加的三态（想学 / 在学 / 已学）落成**这一页的两个页签 + 一个独立页面**：
 * 「在学」和「想学」在这里切换，「已学」单独开一个「已学库」。
 * 为什么不在这一页做三个页签：已学是「翻旧账」的场景，用的时候人已经不在学期里了，
 * 混在一起只会让日常最常用的在学列表被挤短。
 */

/** 本页负责的两档。已学不在这里 */
type StudyTab = Extract<CourseStatus, 'learning' | 'wish'>

const TAB_ORDER: readonly StudyTab[] = ['learning', 'wish']

const TAB_LABEL: Record<StudyTab, string> = {
  learning: 'study.tab.learning',
  wish: 'study.tab.wish'
}

const TAB_EMPTY: Record<StudyTab, string> = {
  learning: 'study.empty.learning',
  wish: 'study.empty.wish'
}

export function createStudyView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.study'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('study.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="to-notes">${escapeHtml(t('study.allNotes'))}</button>
        <button class="sb-btn" type="button" data-action="to-archived">${escapeHtml(t('nav.archived'))}</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="add">${escapeHtml(t('study.newCard'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('home.cards'))}</h2>
        <span class="sb-badge" data-role="meta">${escapeHtml(t('nav.group.module2'))}</span>
      </div>
      <div class="sb-switch" data-role="tabs" role="tablist" aria-label="${escapeHtml(t('study.filterLabel'))}">
        ${TAB_ORDER.map(
          (item) => `
            <button class="sb-switch__item" type="button" role="tab" data-tab="${item}"
                    aria-selected="${item === 'learning' ? 'true' : 'false'}">
              <span>${TAB_LABEL[item]}</span>
              <span class="sb-switch__count" data-count="${item}">0</span>
            </button>
          `
        ).join('')}
      </div>
      <div data-role="cards"></div>
      <p class="sb-hint">
        ${escapeHtml(t('study.hint'))}
      </p>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('nav.portal'))}</h2>
        <div class="sb-toolbar">
          <button class="sb-btn" type="button" data-action="to-portal">${escapeHtml(t('home.managePortal'))}</button>
        </div>
      </div>
      <div data-role="portal"></div>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="cards"]')
  const meta = element.querySelector<HTMLElement>('[data-role="meta"]')
  const tabsEl = element.querySelector<HTMLElement>('[data-role="tabs"]')

  let tab: StudyTab = 'learning'

  /** 每门课的资料份数（卡片角标用）。资料在别的页面/拖拽导入后由事件通知刷新 */
  const materialCounts = new Map<string, number>()

  async function loadMaterialCounts(): Promise<void> {
    try {
      const items = await unwrap(bridge().materials.list())
      materialCounts.clear()
      for (const item of items) {
        if (item.courseCardId.length === 0) continue
        materialCounts.set(item.courseCardId, (materialCounts.get(item.courseCardId) ?? 0) + 1)
      }
      // 角标是卡片渲染的一部分：数字变了就得重绘一次（顺带刷新筛选）
      controller.setFilter((card) => card.status === tab)
    } catch {
      /* 资料加载失败不影响卡片本身 */
    }
  }

  const onMaterialsChanged = (): void => {
    void loadMaterialCounts()
  }
  window.addEventListener('sb:materials-changed', onMaterialsChanged)

  const controller: CardController = createCardController({
    editable: true,
    filter: (card) => card.status === tab,

    onData(all) {
      // 页签上的数字统计的是**全部**卡片，不是当前筛选出来的那些；
      // 否则「在学 3 / 想学 0」会让人以为愿望单也是空的
      for (const value of TAB_ORDER) {
        const count = all.filter((card) => card.status === value).length
        const el = element.querySelector<HTMLElement>(`[data-count="${value}"]`)
        if (el) el.textContent = String(count)
      }
      if (!meta) return
      const linked = all.filter((card) => card.noteId.length > 0).length
      const learnedCount = all.filter((card) => card.status === 'learned').length
      meta.textContent =
        all.length === 0
          ? t('home.noCards')
          : t('study.stats', { total: all.length, linked, learned: learnedCount })
    },

    onEdit(card) {
      void openCardForm(card, controller.courses(), tab).then(async (result) => {
        if (!result) return
        try {
          await controller.upsert({ id: card.id, ...result })
          afterSave(result.status)
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    },

    onOpenNote(card) {
      if (card.noteId.length === 0) {
        toast(t('study.noNoteYet'), 'info')
        ctx.navigate('notes')
        return
      }
      ctx.openNote(card.noteId)
    },

    onMaterials(card) {
      ctx.openMaterials(card.id)
    },

    materialCount(card) {
      return materialCounts.get(card.id) ?? 0
    }
  })

  slot?.appendChild(controller.grid.element)

  /**
   * 保存之后如果卡片不在当前页签里，就跟着切过去。
   *
   * 否则会出现「点了保存、提示成功、界面上什么也没变」——卡片其实被存到了
   * 另一档里。归档（已学）不在本页的页签里，所以说一句它去哪了。
   */
  function afterSave(status: CourseStatus): void {
    if (status === 'learned') {
      toast(t('study.archived'), 'info')
      return
    }
    if (status !== tab) setTab(status)
  }

  function setTab(next: StudyTab): void {
    tab = next
    controller.grid.setEmptyText(TAB_EMPTY[next])
    tabsEl?.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset['tab'] === next ? 'true' : 'false')
    })
    controller.setFilter((card) => card.status === next)
  }

  tabsEl?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const btn = target?.closest<HTMLButtonElement>('[data-tab]')
    const next = btn?.dataset['tab'] as StudyTab | undefined
    if (next && next !== tab) setTab(next)
  })

  // 门户在这里只做快捷启动，管理动作在「网站门户」页——同一个渲染器，两种 editable
  const portal = createPortalController({ editable: false })
  element.querySelector<HTMLElement>('[data-role="portal"]')?.appendChild(portal.grid.element)

  element.querySelector('[data-action="add"]')?.addEventListener('click', () => {
    void openCardForm(null, controller.courses(), tab).then(async (result) => {
      if (!result) return
      try {
        await controller.upsert(result)
        afterSave(result.status)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  })

  element.querySelector('[data-action="to-notes"]')?.addEventListener('click', () => ctx.navigate('notes'))
  element.querySelector('[data-action="to-portal"]')?.addEventListener('click', () => ctx.navigate('portal'))
  element
    .querySelector('[data-action="to-archived"]')
    ?.addEventListener('click', () => ctx.navigate('archived'))

  return {
    element,
    async onEnter() {
      controller.grid.setEmptyText(TAB_EMPTY[tab])
      await controller.load()
      await loadMaterialCounts()
      await portal.load()
    },
    dispose() {
      window.removeEventListener('sb:materials-changed', onMaterialsChanged)
      controller.dispose()
      portal.dispose()
    }
  }
}
