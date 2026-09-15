import type { ViewContext, ViewInstance } from '../app-shell'
import { escapeHtml } from '../lib/html'
import {
  createMaterialsController,
  type MaterialsController
} from '../components/materials-controller'
import { t, tm } from '../lib/i18n'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'

/**
 * 课程资料页。
 *
 * 资料库里「磁盘文件是本体」，这一页只做四件事：按课程分组摆出来、
 * 打开（交给系统默认程序）、改归属、删（进回收站）。导入入口有两个：
 * 右上角按钮（系统文件对话框）和把文件直接拖进窗口（app-shell 全局接管）。
 *
 * 浏览器扩展把学校网站的下载改存进「收件箱」，主进程监控到新文件会广播事件；
 * 那条链路最终也走这里的控制器，但弹窗由 app-shell 统一处理（拖拽可能在任何页面）。
 */
export function createMaterialsView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.materials'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('materials.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="scan">${escapeHtml(t('materials.scan'))}</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="import">${escapeHtml(t('materials.import'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('materials.all'))}</h2>
        <span class="sb-badge" data-role="meta">—</span>
      </div>
      <div data-role="materials"></div>
      <button class="sb-filternote" type="button" data-role="filter-note" hidden></button>
      <p class="sb-hint">
        ${escapeHtml(t('materials.hint'))}
      </p>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="materials"]')
  const meta = element.querySelector<HTMLElement>('[data-role="meta"]')

  /** 课程候选与归属显示的数据源：课程卡片列表。拿不到时按未归类兜底 */
  let cards: readonly { id: string; courseName: string }[] = []

  async function loadCards(): Promise<void> {
    try {
      const list = await unwrap(bridge().cards.list())
      cards = list.map((card) => ({ id: card.id, courseName: card.courseName }))
    } catch {
      cards = []
    }
  }

  const controller: MaterialsController = createMaterialsController({
    courseCards: () => cards,

    onData(items) {
      if (!meta) return
      const lost = items.filter((item) => item.missing).length
      meta.textContent =
        items.length === 0
          ? t('materials.none')
          : t('materials.total', { total: items.length }) + (lost > 0 ? t('materials.lostSuffix', { lost }) : '')
    }
  })

  slot?.appendChild(controller.grid.element)

  /** 卡片角标跳转带来的「只看这门课」筛选。null = 全部 */
  let focusCardId: string | null = null
  const filterNote = element.querySelector<HTMLElement>('[data-role="filter-note"]')

  function applyFocus(courseName: string): void {
    controller.setFilter(focusCardId)
    if (filterNote) {
      filterNote.hidden = focusCardId === null
      if (focusCardId !== null) {
        filterNote.textContent = t('materials.filteredBy', { name: courseName })
      }
    }
  }

  filterNote?.addEventListener('click', () => {
    focusCardId = null
    applyFocus('')
  })

  async function importViaDialog(): Promise<void> {
    try {
      const picked = await unwrap(bridge().materials.pickFiles())
      if (picked.canceled || picked.paths.length === 0) return
      const entries = picked.paths.map((path) => ({
        name: path.replace(/\\/g, '/').split('/').pop() ?? path,
        bytes: 0,
        path
      }))
      const { openMaterialImportDialog } = await import('../components/material-form')
      const choice = await openMaterialImportDialog(entries, cards)
      if (!choice) return
      await controller.importPaths(picked.paths, choice.courseCardId, choice.title)
    } catch (error) {
      toast(t('materials.importFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  /** 把磁盘上有、索引里没有的文件收编进来 */
  async function scanUnregistered(): Promise<void> {
    const found = await controller.unregistered()
    if (found.length === 0) {
      toast(t('materials.scanEmpty'), 'info')
      return
    }
    const { inboxCandidateEntries, openMaterialImportDialog } = await import(
      '../components/material-form'
    )
    const choice = await openMaterialImportDialog(inboxCandidateEntries(found), cards)
    if (!choice) return
    for (const candidate of found) {
      await controller.claim(candidate.fileName, choice.courseCardId)
    }
  }

  element
    .querySelector('[data-action="import"]')
    ?.addEventListener('click', () => void importViaDialog())
  element
    .querySelector('[data-action="scan"]')
    ?.addEventListener('click', () => void scanUnregistered())

  // 别的页面拖拽导入成功后，这里要跟着刷新
  const onMaterialsChanged = (): void => {
    void controller.load()
  }
  window.addEventListener('sb:materials-changed', onMaterialsChanged)

  return {
    element,
    async onEnter() {
      await loadCards()
      await controller.load()
      // 卡片角标带过来的「只看这门课」：取走标记，没带就显示全部
      const pending = ctx.consumePendingMaterialCard()
      focusCardId = pending ?? null
      const courseName =
        cards.find((card) => card.id === focusCardId)?.courseName ?? ''
      applyFocus(courseName)
    },
    dispose() {
      window.removeEventListener('sb:materials-changed', onMaterialsChanged)
      controller.dispose()
    }
  }
}
