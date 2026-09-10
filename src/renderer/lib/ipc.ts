import type { IpcResult } from '@shared/types'

/** 渲染层的 IPC 门面：统一解包 IpcResult，失败时抛带可读信息的错误 */
export function bridge(): Window['studyBoard'] {
  if (!window.studyBoard) {
    throw new Error('preload 未注入，应用无法与主进程通信')
  }
  return window.studyBoard
}

export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}

type ToastKind = 'info' | 'success' | 'error'

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
