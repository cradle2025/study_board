import type { AppInfo, AppSettings } from '@shared/types'

import { bridge, formatError, toast, unwrap } from './lib/ipc'
import { setLang, t, tm } from './lib/i18n'
import { escapeHtml } from './lib/html'
import { mark } from './lib/perf'
import { describeArch, describeOs } from './lib/platform'
import { applyTheme, watchSystemTheme } from './lib/theme'
import { createArchivedView } from './views/archived-view'
import { createCalendarView } from './views/calendar-view'
import { createHomeView } from './views/home-view'
import { createMaterialsView } from './views/materials-view'
import { createNotesView } from './views/notes-view'
import { createPortalView } from './views/portal-view'
import { createSettingsView } from './views/settings-view'
import { createStudyView } from './views/study-view'
import { createTimetableEditorView } from './views/timetable-editor-view'

export type RouteId =
  | 'home'
  | 'timetable'
  | 'calendar'
  | 'portal'
  | 'study'
  | 'archived'
  | 'materials'
  | 'notes'
  | 'settings'

export interface ViewContext {
  getSettings(): AppSettings
  getInfo(): AppInfo | null
  navigate(route: RouteId): void
  reloadSettings(): Promise<void>
  /** 跳到笔记页并打开指定笔记（卡片上的「记笔记」用这条路） */
  openNote(noteId: string): void
  /** 跳到资料页并聚焦某门课的资料（卡片角标入口用） */
  openMaterials(cardId: string): void
  /**
   * 取出并清空「待打开的笔记」标记。
   * 笔记页挂载时调一次——用「取走」而不是「读取」，是为了让用户自己
   * 切回笔记页时不会被上次的跳转目标再次抢走焦点。
   */
  consumePendingNote(): string | null
  /** 同上，资料页用。空串表示「看了就走」，null 表示没有待办 */
  consumePendingMaterialCard(): string | null
}

export interface ViewInstance {
  element: HTMLElement
  onEnter?(): void | Promise<void>
  dispose?(): void
}

export type ViewFactory = (ctx: ViewContext) => ViewInstance

interface RouteDef {
  id: RouteId
  /** 文案 key，不是文案本身 —— 导航要能跟着语言切换重建 */
  labelKey: string
  groupKey: string
  icon: string
  factory: ViewFactory
}

const ROUTES: readonly RouteDef[] = [
  {
    id: 'home',
    labelKey: 'nav.home',
    groupKey: 'nav.group.board',
    icon: '◧',
    factory: createHomeView
  },
  {
    id: 'timetable',
    labelKey: 'nav.timetable',
    groupKey: 'nav.group.module1',
    icon: '▦',
    factory: createTimetableEditorView
  },
  {
    // 日历是**独立一页**，不并进课表页：两者回答的是不同的问题
    // （课表 = 这学期每周怎么上；日历 = 某一天有什么），
    // 塞进同一页只会让两边都变窄
    id: 'calendar',
    labelKey: 'nav.calendar',
    groupKey: 'nav.group.module1',
    icon: '▥',
    factory: createCalendarView
  },
  {
    id: 'portal',
    labelKey: 'nav.portal',
    groupKey: 'nav.group.module2',
    icon: '◎',
    factory: createPortalView
  },
  {
    id: 'study',
    labelKey: 'nav.study',
    groupKey: 'nav.group.module2',
    icon: '◈',
    factory: createStudyView
  },
  {
    id: 'archived',
    labelKey: 'nav.archived',
    groupKey: 'nav.group.module2',
    icon: '▤',
    factory: createArchivedView
  },
  {
    id: 'materials',
    labelKey: 'nav.materials',
    groupKey: 'nav.group.module2',
    icon: '▣',
    factory: createMaterialsView
  },
  {
    id: 'notes',
    labelKey: 'nav.notes',
    groupKey: 'nav.group.module2',
    icon: '✎',
    factory: createNotesView
  },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    groupKey: 'nav.group.system',
    icon: '⚙',
    factory: createSettingsView
  }
]

export class AppShell extends HTMLElement {
  #settings: AppSettings | null = null
  #info: AppInfo | null = null
  #current: ViewInstance | null = null
  #currentRoute: RouteId | null = null
  #stage: HTMLElement | null = null
  #nav: HTMLElement | null = null
  #unwatchTheme: (() => void) | null = null
  #unwatchSettings: (() => void) | null = null
  #unwatchInbox: (() => void) | null = null
  /** 别的页面请求「跳到某篇笔记」时先记在这里，笔记页挂载时取走 */
  #pendingNoteId: string | null = null
  /** 卡片角标请求「看这门课的资料」时先记在这里，资料页挂载时取走 */
  #pendingMaterialCardId: string | null = null
  /** 拖拽导入的蒙层：拖着文件悬在窗口上时全屏提示「松手导入」 */
  #dropMask: HTMLElement | null = null
  #dragDepth = 0

  connectedCallback(): void {
    this.render()
    void this.bootstrap()

    this.#unwatchTheme = watchSystemTheme(() => {
      const mode = this.#settings?.theme ?? 'system'
      applyTheme(mode)
    })
    this.#installDragImport()
  }

  disconnectedCallback(): void {
    this.#unwatchTheme?.()
    this.#unwatchTheme = null
    // 订阅一定要退掉：app-shell 被反复挂载卸载时，
    // 不退订就会在主进程侧留下一串永远不会被调用的监听器
    this.#unwatchSettings?.()
    this.#unwatchSettings = null
    this.#unwatchInbox?.()
    this.#unwatchInbox = null
    this.#uninstallDragImport()
    this.#current?.dispose?.()
    // 必须一并清掉「当前路由」的记账，否则元素被重新挂载时
    // go() 会因为「路由没变」直接返回，舞台永远空着
    this.#current = null
    this.#currentRoute = null
  }

  /**
   * 全局拖拽导入：任何页面拖着文件进来都提示「松手导入」。
   *
   * dragover 必须 preventDefault——不拦的话 Chromium 的默认行为是把窗口
   * **导航成被拖的那个文件**（渲染层的 preventDefault 是第一道，
   * 主进程 will-navigate 的 file:// 校验是兜底）。
   * dragleave 用深度计数：拖过子元素时 leave 会乱发，只看进出窗口最外层。
   */
  #installDragImport(): void {
    this.#dragDepth = 0
    window.addEventListener('dragover', this.#onDragOver)
    window.addEventListener('dragenter', this.#onDragEnter)
    window.addEventListener('dragleave', this.#onDragLeave)
    window.addEventListener('drop', this.#onDrop)
  }

  #uninstallDragImport(): void {
    window.removeEventListener('dragover', this.#onDragOver)
    window.removeEventListener('dragenter', this.#onDragEnter)
    window.removeEventListener('dragleave', this.#onDragLeave)
    window.removeEventListener('drop', this.#onDrop)
    this.#dropMask?.remove()
    this.#dropMask = null
    this.#dragDepth = 0
  }

  #onDragOver = (event: DragEvent): void => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  #onDragEnter = (event: DragEvent): void => {
    event.preventDefault()
    if (!event.dataTransfer?.types.includes('Files')) return
    this.#dragDepth += 1
    this.#showDropMask()
  }

  #onDragLeave = (event: DragEvent): void => {
    event.preventDefault()
    this.#dragDepth = Math.max(0, this.#dragDepth - 1)
    if (this.#dragDepth === 0) this.#hideDropMask()
  }

  #onDrop = (event: DragEvent): void => {
    event.preventDefault()
    this.#dragDepth = 0
    this.#hideDropMask()
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void this.#importDropped(files)
  }

  #showDropMask(): void {
    if (this.#dropMask) return
    const mask = document.createElement('div')
    mask.className = 'sb-dropmask'
    mask.innerHTML =
      '<div class="sb-dropmask__card"><div class="sb-dropmask__title">' + escapeHtml(t('shell.dropTitle')) + '</div>' +
      '<div class="sb-dropmask__hint">' + escapeHtml(t('shell.dropHint')) + '</div></div>'
    document.body.appendChild(mask)
    this.#dropMask = mask
  }

  #hideDropMask(): void {
    this.#dropMask?.remove()
    this.#dropMask = null
  }

  async #importDropped(files: File[]): Promise<void> {
    // 沙箱渲染层拿不到真实路径，让 preload 用 webUtils 换算
    const paths = bridge().pathsFromDrop(files)
    if (paths.length === 0) {
      toast(t('shell.dropNoPath'), 'info')
      return
    }
    const { openMaterialImportDialog } = await import('./components/material-form')
    const cards = await this.#courseCards()
    const entries = paths.map((path) => ({
      name: path.replace(/\\/g, '/').split('/').pop() ?? path,
      bytes: (files.find((file) => file.name === (path.replace(/\\/g, '/').split('/').pop() ?? ''))?.size) ?? 0,
      path
    }))
    const choice = await openMaterialImportDialog(entries, cards)
    if (!choice) return
    try {
      const result = await unwrap(
        bridge().materials.import({
          paths,
          courseCardId: choice.courseCardId,
          title: choice.title,
          sourcePolicy: 'keep'
        })
      )
      const failed = result.errors.length
      if (result.added > 0 && failed === 0) toast(t('shell.importedCount', { count: result.added }), 'success')
      else if (result.added > 0) toast(t('shell.importedPartial', { added: result.added, failed }), 'info')
      else toast(t('shell.importFailed', { reason: tm(result.errors[0] ?? '') }), 'error')
      window.dispatchEvent(new CustomEvent('sb:materials-changed'))
    } catch (error) {
      toast(t('shell.importFailed', { reason: formatError(error) }), 'error')
    }
  }

  async #courseCards(): Promise<readonly { id: string; courseName: string }[]> {
    try {
      const list = await unwrap(bridge().cards.list())
      return list.map((card) => ({ id: card.id, courseName: card.courseName }))
    } catch {
      return []
    }
  }

  private render(): void {
    this.innerHTML = `
      <div class="sb-shell">
        <aside class="sb-sidebar">
          <div class="sb-brand">
            <div class="sb-brand__mark">${escapeHtml(t('shell.brandMark'))}</div>
            <div>
              <div class="sb-brand__text">${escapeHtml(t('shell.brand'))}</div>
              <div class="sb-brand__sub" data-role="version">${escapeHtml(t('common.loading'))}</div>
            </div>
          </div>
          <nav class="sb-nav" data-role="nav" aria-label="${escapeHtml(t('shell.navLabel'))}"></nav>
          <div class="sb-sidebar__footer" data-role="footer">${escapeHtml(t('shell.footer'))}</div>
        </aside>
        <main class="sb-main" data-role="stage"></main>
      </div>
    `
    this.#stage = this.querySelector<HTMLElement>('[data-role="stage"]')
    this.#nav = this.querySelector<HTMLElement>('[data-role="nav"]')
  }

  private async bootstrap(): Promise<void> {
    try {
      const info = await unwrap(bridge().app.info())
      this.#info = info
      this.#settings = await unwrap(bridge().settings.get())
      // 语言必须在第一次渲染视图之前设好：视图在构造时就把文案写进
      // DOM 了，晚一步就会先闪一下中文
      setLang(this.#settings.language)
      applyTheme(this.#settings.theme)

      /**
       * 语言确定之后**把外壳重画一遍**。
       *
       * `render()` 是在 `connectedCallback()` 里跑的，那时还没读到设置，
       * 语言是模块默认的 `zh-CN` —— 于是品牌名、导航 aria-label、
       * 页脚这些**在 render() 里拼出来的文案全是中文**。
       *
       * 之前没暴露，是因为「先以中文启动、再手动切英文」会走
       * `#relocalize()` 重建一遍。而**以英文启动**（配置里就是 en-US）
       * 不会触发那条路径，中文就一直留在那儿了。
       *
       * 此刻还没有挂任何视图，重画是安全的。
       */
      this.render()

      /**
       * 语言确定之后**把外壳重画一遍**。
       *
       * `render()` 是在 `connectedCallback()` 里跑的，那时还没读到设置，
       * 语言是模块默认的 `zh-CN` —— 于是品牌名、导航 aria-label、
       * 页脚这些**在 render() 里拼出来的文案全是中文**。
       *
       * 之前没暴露，是因为「先以中文启动、再手动切英文」会走
       * `#relocalize()` 重建一遍。而**以英文启动**（配置里就是 en-US）
       * 不会触发那条路径，中文就一直留在那儿了。
       *
       * 此刻还没有挂任何视图，重画是安全的。
       */
      this.render()

      this.#applyChrome()
      this.renderNav()

      /**
       * 订阅必须在**第一次挂载视图之前**注册。
       *
       * `go('home')` 要 await 首页的 `onEnter()`（拉卡片、拉设置），中间是
       * 一段真实的异步窗口。订阅挂在它后面的话，这段时间里主进程广播的
       * 设置变更**没有收件人**——preload 的 subscribe 就是一层裸的
       * `ipcRenderer.on`，不缓冲、不重放。事件一丢，界面就永远停在旧文案上。
       *
       * 表现是 `npm run smoke` 里那条「切语言界面必须真的变」的断言
       * 时灵时不灵（冷启动首页更慢，命中概率更高）：配置已经改了、语言
       * 也真的换了，但侧栏一个字都没动。用户手动切语言时同样会撞上，
       * 只是他多半会以为「这软件得重启一次才生效」。
       *
       * 订阅要留着句柄，元素被卸载时才能退订
       */
      this.#unwatchSettings = bridge().events.onSettingsChanged((next) => {
        const languageChanged = next.language !== this.#settings?.language
        this.#settings = next
        applyTheme(next.theme)
        if (languageChanged) void this.#relocalize()
      })
      this.#unwatchInbox = bridge().events.onMaterialsInbox((payload) => {
        void this.#handleInbox(payload.files ?? [])
      })

      await this.go('home')
      mark('sb:shell-ready')
    } catch (error) {
      this.showFatal(formatError(error))
    }
  }

  /**
   * 收件箱里出现了新下载（浏览器扩展改存进来的）。
   * 弹归属对话框 → 确认后走收件箱导入通道（原文件由主进程移入系统回收站）。
   */
  async #handleInbox(files: { fileName: string; bytes: number }[]): Promise<void> {
    if (files.length === 0) return
    const { inboxCandidateEntries, openMaterialImportDialog } = await import(
      './components/material-form'
    )
    const cards = await this.#courseCards()
    const choice = await openMaterialImportDialog(inboxCandidateEntries(files), cards)
    if (!choice) return
    try {
      const result = await unwrap(
        bridge().materials.importInbox({
          fileNames: files.map((file) => file.fileName),
          courseCardId: choice.courseCardId,
          title: choice.title
        })
      )
      const failed = result.errors.length
      if (result.added > 0 && failed === 0) toast(t('shell.importedCount', { count: result.added }), 'success')
      else if (result.added > 0) toast(t('shell.importedPartial', { added: result.added, failed }), 'info')
      else toast(t('shell.importFailed', { reason: tm(result.errors[0] ?? '') }), 'error')
      window.dispatchEvent(new CustomEvent('sb:materials-changed'))
    } catch (error) {
      toast(t('shell.importFailed', { reason: formatError(error) }), 'error')
    }
  }

  private showFatal(message: string): void {
    if (!this.#stage) return
    this.#stage.innerHTML = `
      <div class="sb-view">
        <h2 class="sb-view__title">${escapeHtml(t('shell.fatalTitle'))}</h2>
        <div class="sb-notice">${escapeHtml(message)}</div>
        <p class="sb-hint">${escapeHtml(t('shell.fatalHint'))}</p>
      </div>
    `
  }

  private renderNav(): void {
    if (!this.#nav) return
    let lastGroup = ''
    const parts: string[] = []
    for (const route of ROUTES) {
      if (route.groupKey !== lastGroup) {
        lastGroup = route.groupKey
        parts.push(`<div class="sb-nav__group">${escapeHtml(t(route.groupKey))}</div>`)
      }
      parts.push(
        `<button class="sb-nav__item" type="button" data-route="${route.id}">
           <span aria-hidden="true">${route.icon}</span>
           <span>${escapeHtml(t(route.labelKey))}</span>
         </button>`
      )
    }
    this.#nav.innerHTML = parts.join('')
    this.#nav.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset['route'] as RouteId | undefined
        if (id) void this.go(id)
      })
    })
  }

  private markActive(route: RouteId): void {
    this.#nav?.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((btn) => {
      if (btn.dataset['route'] === route) btn.setAttribute('aria-current', 'page')
      else btn.removeAttribute('aria-current')
    })
  }

  /**
   * 语言变了，把界面重建一遍。
   *
   * 为什么是「重建」而不是「逐个更新文案」：文案散布在几十个视图和
   * 组件的构造函数里，还有一部分是**拼在 HTML 字符串里**的（`innerHTML`）。
   * 逐处更新等于给每个视图再写一遍渲染逻辑，漏一处就是一处永远不变的中文。
   * 重建只有一处代价 —— 当前视图的临时状态（比如笔记页正在编辑的那篇）
   * 会丢 —— 而语言切换本来就是低频动作，重挂载回到同一个路由是可以接受的。
   *
   * 必须先把 `#currentRoute` 清掉：`go()` 有一句「路由没变就直接返回」，
   * 不清的话重挂载会静默什么都不做，表现是「切了语言但界面纹丝不动」。
   */
  async #relocalize(): Promise<void> {
    const route = this.#currentRoute ?? 'home'
    setLang(this.#settings?.language)

    this.#current?.dispose?.()
    this.#current = null
    this.#currentRoute = null

    // render() 会把 innerHTML 整个换掉，侧栏与舞台都重建，所以顺序不能反：
    // 先 dispose 掉旧视图，再重建骨架
    this.render()
    this.#applyChrome()
    this.renderNav()
    await this.go(route)
  }

  /** 侧栏上那几处跟着数据走的文案。`render()` 之后单独调，便于重建时复用 */
  #applyChrome(): void {
    const info = this.#info
    if (!info) return

    const versionEl = this.querySelector<HTMLElement>('[data-role="version"]')
    if (versionEl) {
      // 别把 process.platform 直接摆出来：win32 在 64 位 Windows 上也是 win32，
      // 侧栏那点宽度又放不下完整说明，所以这里只写「系统 + 位数」
      versionEl.textContent = `v${info.version} · ${describeOs(info.platform)} ${describeArch(info.arch)}`
    }

    const footerEl = this.querySelector<HTMLElement>('[data-role="footer"]')
    if (footerEl) footerEl.textContent = t('shell.dataDir', { path: info.paths.userData })
  }

  private async go(route: RouteId): Promise<void> {    if (route === this.#currentRoute) return
    if (!this.#stage || !this.#settings) return

    const def = ROUTES.find((r) => r.id === route)
    if (!def) return

    this.#current?.dispose?.()
    this.#stage.replaceChildren()

    const view = def.factory({
      getSettings: () => this.#settings as AppSettings,
      getInfo: () => this.#info,
      navigate: (next) => {
        void this.go(next)
      },
      reloadSettings: async () => {
        this.#settings = await unwrap(bridge().settings.get())
        applyTheme(this.#settings.theme)
      },
      openNote: (noteId) => {
        this.#pendingNoteId = noteId
        void this.go('notes')
      },
      openMaterials: (cardId) => {
        this.#pendingMaterialCardId = cardId
        void this.go('materials')
      },
      consumePendingNote: () => {
        const id = this.#pendingNoteId
        this.#pendingNoteId = null
        return id
      },
      consumePendingMaterialCard: () => {
        const id = this.#pendingMaterialCardId
        this.#pendingMaterialCardId = null
        return id
      }
    })

    this.#current = view
    this.#currentRoute = route
    this.#stage.appendChild(view.element)
    mark(`sb:view:${route}:mount`)
    this.markActive(route)

    try {
      await view.onEnter?.()
    } catch (error) {
      toast(t('shell.pageLoadFailed', { reason: formatError(error) }), 'error')
    }
    mark(`sb:view:${route}:ready`)
  }
}

export { escapeHtml }
