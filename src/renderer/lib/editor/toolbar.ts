import { escapeHtml } from '../html'
import { t } from '../i18n'
import { TOOLBAR, isCommandAvailable, type EditorCommand, type EditorMode, type EditorHandle } from './commands'

/**
 * 两个编辑器共用的工具栏。
 *
 * 只认命令词汇表，不认背后是 CodeMirror 还是 TipTap——
 * 所以「加粗」按钮在两边的实现完全不同，但按钮本身一行都不用改。
 *
 * Markdown 表达不了的命令（下划线、高亮、对齐）在 md 模式下会被**禁用**，
 * 而不是藏起来：按钮位置不变，用户不会觉得工具栏在跳；
 * 但灰掉能明确传达「这个模式不支持」，鼠标悬停还有解释。
 */

export interface ToolbarOptions {
  handle: EditorHandle
  /** 需要用户输入点什么的时候（比如链接地址）由外面接管 */
  onNotice?(message: string): void
  /**
   * 需要**视图层**接管的命令。返回 true 表示这条命令已经被处理掉了。
   *
   * 「插入图片」是第一个用上它的：它要弹一个选择器、走 IPC 读资料库，
   * 是异步的，而 `EditorHandle.run()` 是同步返回 boolean 的。
   * 硬把异步塞进那个签名会让两个编辑器都要多背一个 Promise，
   * 而它们其实一点都不关心图片是从哪来的——图片地址是视图层拼好传进去的。
   */
  onCommand?(command: EditorCommand): boolean
}

export interface ToolbarHandle {
  element: HTMLElement
  /** 换编辑器 / 换模式后重新绑定并刷新按钮状态 */
  bind(handle: EditorHandle): void
  /** 光标移动后刷新高亮状态 */
  refresh(): void
  destroy(): void
}

export function createEditorToolbar(options: ToolbarOptions): ToolbarHandle {
  const element = document.createElement('div')
  element.className = 'sb-editorbar'

  let handle = options.handle

  const groups: number[] = []
  for (const item of TOOLBAR) {
    if (!groups.includes(item.group)) groups.push(item.group)
  }

  element.innerHTML = groups
    .map((group) => {
      const items = TOOLBAR.filter((item) => item.group === group)
      const buttons = items
        .map(
          (item) => `
            <button class="sb-editorbar__btn" type="button" data-command="${item.command}"
                    title="${escapeHtml(t(item.titleKey))}" aria-label="${escapeHtml(t(item.titleKey))}">
              ${escapeHtml(item.labelKey ? t(item.labelKey) : (item.label ?? ''))}
            </button>
          `
        )
        .join('')
      return `<span class="sb-editorbar__group">${buttons}</span>`
    })
    .join('')

  const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-command]'))

  const items = new Map(TOOLBAR.map((item) => [item.command as string, item]))

  function refresh(): void {
    for (const button of buttons) {
      const command = button.dataset['command'] as EditorCommand | undefined
      if (!command) continue
      const item = items.get(command)
      const available = item ? isCommandAvailable(item, handle.mode) : false

      button.disabled = !available
      if (!available) {
        button.classList.remove('sb-editorbar__btn--on')
        continue
      }
      // 需要「当前状态」的命令才高亮；撤销重做这类一次性动作永远不高亮
      const active = handle.isActive(command)
      button.classList.toggle('sb-editorbar__btn--on', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    const button = target?.closest<HTMLButtonElement>('[data-command]')
    if (!button || button.disabled) return
    const command = button.dataset['command'] as EditorCommand | undefined
    if (!command) return

    // 视图层先挑：需要弹选择器这类异步动作由它接走
    if (options.onCommand?.(command)) {
      refresh()
      return
    }

    const done = handle.run(command)
    if (!done && options.onNotice) {
      options.onNotice(t('editor.notSupported'))
    }
    refresh()
  }

  element.addEventListener('click', onClick)

  return {
    element,
    bind(next) {
      handle = next
      refresh()
    },
    refresh,
    destroy() {
      element.removeEventListener('click', onClick)
    }
  }
}

/** 供视图层判断某条命令在当前模式下是否可用（比如决定快捷键要不要拦） */
export function commandAvailable(command: EditorCommand, mode: EditorMode): boolean {
  const item = TOOLBAR.find((entry) => entry.command === command)
  return item ? isCommandAvailable(item, mode) : false
}
