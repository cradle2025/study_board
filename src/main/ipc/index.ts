import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import { CHANNELS, EVENT_CHANNELS, type ChannelName } from '@shared/channels'
import type { IpcResult } from '@shared/types'

/**
 * IPC 注册中心。
 *
 * 所有 handle 都必须经过这里，好处是：
 *  - 通道名必须在 channels.ts 白名单里，杜绝随手新增通道；
 *  - 统一校验调用方来源，杜绝其它 frame / 外部页面调用；
 *  - 统一把异常收敛成 IpcResult，渲染层永远拿不到主进程堆栈。
 */

const KNOWN_CHANNELS = new Set<string>(Object.values(CHANNELS))
const registered = new Set<string>()

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 渲染层页面只可能来自本地打包文件或开发服务器 */
function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false
  if (url.startsWith('file://')) return true
  if (url.startsWith('devtools://')) return true
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const url = frame?.url ?? event.sender.getURL()
  if (!isTrustedRendererUrl(url)) {
    throw new Error('拒绝来自非本应用页面的调用')
  }
  if (event.sender.isDestroyed()) {
    throw new Error('调用方已销毁')
  }
}

export function handle<TReq, TRes>(
  channel: ChannelName,
  handler: (payload: TReq, event: IpcMainInvokeEvent) => Promise<TRes> | TRes
): void {
  if (!KNOWN_CHANNELS.has(channel)) {
    throw new Error(`未登记的 IPC 通道：${channel}`)
  }
  if (registered.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<TRes>> => {
    try {
      assertTrustedSender(event)
      const data = await handler(payload as TReq, event)
      return { ok: true, data }
    } catch (error) {
      console.error(`[ipc] ${channel} 失败：`, error)
      return { ok: false, error: messageOf(error) }
    }
  })
}

/** 主进程主动推事件给所有窗口 */
export function broadcast<T>(channel: ChannelName, payload: T): void {
  if (!EVENT_CHANNELS.includes(channel)) {
    throw new Error(`未登记的事件通道：${channel}`)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

/** 已经注册过的通道（供「未实现功能占位」逻辑判断） */
export function registeredChannels(): ReadonlySet<string> {
  return registered
}

/** 启动结束后自检：每个通道都必须被注册，漏注册直接暴露出来 */
export function assertAllChannelsRegistered(): void {
  // 这两个是 main -> renderer 的单向事件，不需要 handle
  const skip = new Set<string>(EVENT_CHANNELS)
  const missing = [...KNOWN_CHANNELS].filter((c) => !skip.has(c) && !registered.has(c))
  if (missing.length > 0) {
    throw new Error(`以下 IPC 通道未注册：${missing.join(', ')}`)
  }
}
