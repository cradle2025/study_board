import { createTimetableController, type TimetableController } from '../components/timetable-controller'
import type { ViewContext, ViewInstance } from '../app-shell'

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
        <h1 class="sb-view__title">今天</h1>
        <p class="sb-view__desc">课程表固定在最上方，打开就能看到。悬停预览，双击即可编辑。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="edit-timetable">课表设置</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">课程表</h2>
        <span class="sb-badge" data-role="timetable-meta">模块一</span>
      </div>
      <div data-role="timetable-slot"></div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">网站门户</h2>
        <span class="sb-badge">模块二</span>
      </div>
      <div class="sb-card sb-empty" data-role="portal-slot">
        慕课 / B站 / 知网 快捷入口 —— 开发中。
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">课程卡片</h2>
        <span class="sb-badge">模块二</span>
      </div>
      <div class="sb-card sb-empty" data-role="cards-slot">
        可翻转的课程卡片 —— 开发中。
      </div>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="timetable-slot"]')
  const meta = element.querySelector<HTMLElement>('[data-role="timetable-meta"]')

  const controller: TimetableController = createTimetableController({
    editable: true,
    errorPrefix: '课表',
    onData(data) {
      if (!meta) return
      if (data.mode === 'image') {
        meta.textContent = `图片模式 · ${data.images.length} 张`
      } else {
        const filled = Object.keys(data.cells).length
        meta.textContent = `表格模式 · ${data.periodCount} 节 · 已填 ${filled} 格`
      }
    }
  })

  slot?.appendChild(controller.panel.element)

  element
    .querySelector('[data-action="edit-timetable"]')
    ?.addEventListener('click', () => ctx.navigate('timetable'))

  // 概览页只读展示课表，一旦有数据就补一句空态提示
  const emptyHint = document.createElement('p')
  emptyHint.className = 'sb-hint sb-ttpanel__hint'
  emptyHint.hidden = true
  emptyHint.textContent = '还没有录入任何课程：双击任意单元格开始填写，或到「课程表」页导入照片。'
  slot?.appendChild(emptyHint)

  return {
    element,
    async onEnter() {
      await controller.load()
      emptyHint.hidden = !controller.panel.isEmpty()
    },
    dispose() {
      controller.dispose()
    }
  }
}
