import type { ViewContext, ViewInstance } from '../app-shell'

/** 概览页：按需求「打开即见课表」，课表固定在最上方，下面是学习入口 */
export function createHomeView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">今天</h1>
        <p class="sb-view__desc">课程表固定在最上方，打开就能看到。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="edit-timetable">编辑课表</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">课程表</h2>
        <span class="sb-badge">模块一</span>
      </div>
      <div class="sb-card sb-empty" data-role="timetable-slot">
        课程表渲染区 —— 表格模式 / 图片模式切换已接入设置，渲染逻辑开发中。
      </div>
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

  element.querySelector('[data-action="edit-timetable"]')?.addEventListener('click', () => {
    ctx.navigate('timetable')
  })

  return { element }
}
