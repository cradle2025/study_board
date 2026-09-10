import type { ViewContext, ViewInstance } from '../app-shell'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'

/** 笔记页：骨架阶段先展示笔记库位置，并把「打开目录」接通 */
export function createNotesView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">笔记</h1>
        <p class="sb-view__desc">笔记以纯 Markdown 文件保存在本地，目录可以直接作为 Obsidian 库打开。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="open">打开笔记库目录</button>
      </div>
    </div>

    <div class="sb-notice" data-role="lib-path">读取中…</div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">笔记列表</h2>
        <span class="sb-badge">开发中</span>
      </div>
      <div class="sb-card sb-empty">
        Markdown / 富文本双模式编辑器、卡片联动、导出与 AI 整理都在这个模块里。
      </div>
    </section>
  `

  const pathEl = element.querySelector<HTMLElement>('[data-role="lib-path"]')

  function renderPath(): void {
    if (!pathEl) return
    const dir = ctx.getSettings().notesLibraryDir
    pathEl.textContent = `笔记库目录：${dir}`
  }

  element.querySelector('[data-action="open"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().app.openPath(ctx.getSettings().notesLibraryDir))
    } catch (error) {
      toast(`无法打开目录：${formatError(error)}`, 'error')
    }
  })

  renderPath()

  return {
    element,
    onEnter: async () => {
      await ctx.reloadSettings()
      renderPath()
    }
  }
}
