import type { ViewContext, ViewInstance } from '../app-shell'

/** 模块二：网站门户 + 课程卡片（骨架阶段先占位） */
export function createStudyView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">课程与学习</h1>
        <p class="sb-view__desc">快捷入口、课程卡片与笔记都从这里进。</p>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">网站门户</h2>
        <span class="sb-badge">开发中</span>
      </div>
      <div class="sb-card sb-empty">
        默认提供慕课、B站、知网三个入口，可自行添加网址、命名并自动抓取图标。
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">课程卡片</h2>
        <div class="sb-toolbar">
          <button class="sb-btn" type="button" data-action="to-notes">前往笔记</button>
        </div>
      </div>
      <div class="sb-card sb-empty">
        卡片可翻转：正面是课程名 / 授课老师 / 打分 / 难度 / 掌握程度，背面是给分标准与课程结构。
      </div>
    </section>
  `

  element.querySelector('[data-action="to-notes"]')?.addEventListener('click', () => {
    ctx.navigate('notes')
  })

  return { element }
}
