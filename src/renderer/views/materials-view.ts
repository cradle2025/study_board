import type { ViewContext, ViewInstance } from '../app-shell'
import {
  createMaterialsController,
  type MaterialsController
} from '../components/materials-controller'
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
        <h1 class="sb-view__title">课程资料</h1>
        <p class="sb-view__desc">课件、大纲、实验指导都收在这里，按课程分组。把文件拖进窗口就能导入。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="scan">扫描未登记</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="import">导入资料</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">全部资料</h2>
        <span class="sb-badge" data-role="meta">—</span>
      </div>
      <div data-role="materials"></div>
      <button class="sb-filternote" type="button" data-role="filter-note" hidden></button>
      <p class="sb-hint">
        资料存在笔记库的 attachments/ 目录里，Obsidian 能直接预览其中的 PDF；
        删除只是移入系统回收站。显示「文件丢失」的条目多半是被挪走了，找回来后这里会自动恢复。
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
          ? '还没有资料'
          : `共 ${items.length} 份${lost > 0 ? ` · ${lost} 份丢失` : ''}`
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
        filterNote.textContent = `只看「${courseName}」的资料 · 显示全部`
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
      toast(`导入失败：${formatError(error)}`, 'error')
    }
  }

  /** 把磁盘上有、索引里没有的文件收编进来 */
  async function scanUnregistered(): Promise<void> {
    const found = await controller.unregistered()
    if (found.length === 0) {
      toast('没有发现未登记的资料文件', 'info')
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
