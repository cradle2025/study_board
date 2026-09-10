import { assertAllChannelsRegistered } from './index'
import { registerPendingHandlers } from './pending'
import { registerSettingsHandlers } from './settings'
import { registerSystemHandlers } from './system'
import { registerTimetableHandlers } from './timetable'

/**
 * 所有 IPC 在这里汇总注册。
 * 顺序很重要：先注册真正实现的功能，再用占位补齐剩下的通道。
 */
export function registerIpcHandlers(): void {
  registerSystemHandlers()
  registerSettingsHandlers()
  registerTimetableHandlers()

  // 尚未实现的模块统一挂占位，等对应模块落地后从这里「顶掉」即可
  registerPendingHandlers()

  assertAllChannelsRegistered()
}
