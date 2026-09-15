import type { IpcResult } from '@shared/types'
import { t } from '../lib/i18n'

/** 渲染层的 IPC 门面：统一解包 IpcResult，失败时抛带可读信息的错误 */
export function bridge(): Window['studyBoard'] {
  if (!window.studyBoard) {
    throw new Error(t('err.preloadMissing'))
  }
  return window.studyBoard
}

export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}

type ToastKind = 'info' | 'success' | 'error'

/**
 * 同时可见的提示条上限。
 *
 * 批量操作（导入多张图片、连续编辑）会在很短时间内产生一串提示，
 * 不设上限的话它们会一直堆在 DOM 里直到各自超时——既挤满界面，
 * 也让节点数无谓增长。超过就挤掉最旧的一条。
 */
const MAX_TOASTS = 4

let toastHost: HTMLElement | null = null

function ensureToastHost(): HTMLElement {
  if (toastHost && toastHost.isConnected) return toastHost
  const host = document.createElement('div')
  host.className = 'sb-toasts'
  document.body.appendChild(host)
  toastHost = host
  return host
}

export function toast(message: string, kind: ToastKind = 'info'): void {
  const host = ensureToastHost()
  while (host.childElementCount >= MAX_TOASTS) {
    host.firstElementChild?.remove()
  }

  const el = document.createElement('div')
  el.className = `sb-toast sb-toast--${kind}`
  el.textContent = message
  host.appendChild(el)
  window.setTimeout(() => {
    el.remove()
  }, kind === 'error' ? 5200 : 2600)
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
