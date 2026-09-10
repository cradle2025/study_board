import { CHANNELS, EVENT_CHANNELS, type ChannelName } from '@shared/channels'

import { handle, registeredChannels } from './index'

/**
 * 未实现功能的占位注册。
 *
 * 好处是 IPC 通道清单在骨架阶段就是完整的：
 *  - 渲染层可以照常调用，拿到的是「功能开发中」这种可读提示，而不是通道不存在的底层报错；
 *  - 启动自检 assertAllChannelsRegistered 能立刻发现「新加了通道但忘了实现」。
 * 每实现一个模块，就把对应通道从占位里挤掉（不重复注册即可）。
 */
const PENDING_MESSAGE = '该功能仍在开发中，暂未接通'

export function registerPendingHandlers(): void {
  const already = registeredChannels()
  for (const channel of Object.values(CHANNELS) as ChannelName[]) {
    if (EVENT_CHANNELS.includes(channel)) continue
    if (already.has(channel)) continue
    handle(channel, () => {
      throw new Error(PENDING_MESSAGE)
    })
  }
}
