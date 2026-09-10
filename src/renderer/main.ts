import { AppShell } from './app-shell'

/**
 * 渲染层入口。
 * 单一自定义元素承载整个应用，避免引入任何前端框架带来的版本与体积负担。
 */
if (!customElements.get('study-board-app')) {
  customElements.define('study-board-app', AppShell)
}
