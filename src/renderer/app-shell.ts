import type { AppInfo, AppSettings } from '@shared/types'

import { bridge, formatError, toast, unwrap } from './lib/ipc'
import { escapeHtml } from './lib/html'
import { applyTheme, watchSystemTheme } from './lib/theme'
import { createHomeView } from './views/home-view'
import { createNotesView } from './views/notes-view'
import { createSettingsView } from './views/settings-view'
import { createStudyView } from './views/study-view'
import { createTimetableEditorView } from './views/timetable-editor-view'

export type RouteId = 'home' | 'timetable' | 'study' | 'notes' | 'settings'

export interface ViewContext {
  getSettings(): AppSettings
  getInfo(): AppInfo | null
  navigate(route: RouteId): void
  reloadSettings(): Promise<void>
}

export interface ViewInstance {
  element: HTMLElement
  onEnter?(): void | Promise<void>
  dispose?(): void
}

export type ViewFactory = (ctx: ViewContext) => ViewInstance

interface RouteDef {
  id: RouteId
  label: string
  group: string
  icon: string
  factory: ViewFactory
}

const ROUTES: readonly RouteDef[] = [
  {
    id: 'home',
    label: '概览',
    group: '看板',
    icon: '◧',
    factory: createHomeView
  },
  {
    id: 'timetable',
    label: '课程表',
    group: '模块一',
    icon: '▦',
    factory: createTimetableEditorView
  },
  {
    id: 'study',
    label: '课程与学习',
    group: '模块二',
    icon: '◈',
    factory: createStudyView
  },
  {
    id: 'notes',
    label: '笔记',
    group: '模块二',
    icon: '✎',
    factory: createNotesView
  },
  {
    id: 'settings',
    label: '设置',
    group: '系统',
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

  connectedCallback(): void {
    this.render()
    void this.bootstrap()

    this.#unwatchTheme = watchSystemTheme(() => {
      const mode = this.#settings?.theme ?? 'system'
      applyTheme(mode)
    })
  }

  disconnectedCallback(): void {
    this.#unwatchTheme?.()
    this.#current?.dispose?.()
  }

  private render(): void {
    this.innerHTML = `
      <div class="sb-shell">
        <aside class="sb-sidebar">
          <div class="sb-brand">
            <div class="sb-brand__mark">学</div>
            <div>
              <div class="sb-brand__text">学习看板</div>
              <div class="sb-brand__sub" data-role="version">加载中…</div>
            </div>
          </div>
          <nav class="sb-nav" data-role="nav" aria-label="主导航"></nav>
          <div class="sb-sidebar__footer" data-role="footer">本地数据 · 不联外网</div>
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
      applyTheme(this.#settings.theme)

      const versionEl = this.querySelector<HTMLElement>('[data-role="version"]')
      if (versionEl) versionEl.textContent = `v${info.version} · ${info.platform}`

      const footerEl = this.querySelector<HTMLElement>('[data-role="footer"]')
      if (footerEl) footerEl.textContent = `数据目录：${info.paths.userData}`

      this.renderNav()
      await this.go('home')

      bridge().events.onSettingsChanged((next) => {
        this.#settings = next
        applyTheme(next.theme)
      })
    } catch (error) {
      this.showFatal(formatError(error))
    }
  }

  private showFatal(message: string): void {
    if (!this.#stage) return
    this.#stage.innerHTML = `
      <div class="sb-view">
        <div class="sb-notice">应用初始化失败：${escapeHtml(message)}</div>
      </div>
    `
  }

  private renderNav(): void {
    if (!this.#nav) return
    let lastGroup = ''
    const parts: string[] = []
    for (const route of ROUTES) {
      if (route.group !== lastGroup) {
        lastGroup = route.group
        parts.push(`<div class="sb-nav__group">${escapeHtml(route.group)}</div>`)
      }
      parts.push(
        `<button class="sb-nav__item" type="button" data-route="${route.id}">
           <span aria-hidden="true">${route.icon}</span>
           <span>${escapeHtml(route.label)}</span>
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

  private async go(route: RouteId): Promise<void> {
    if (route === this.#currentRoute) return
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
      }
    })

    this.#current = view
    this.#currentRoute = route
    this.#stage.appendChild(view.element)
    this.markActive(route)

    try {
      await view.onEnter?.()
    } catch (error) {
      toast(`页面加载失败：${formatError(error)}`, 'error')
    }
  }
}

export { escapeHtml }
