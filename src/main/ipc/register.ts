import { registerAiHandlers } from './ai'
import { registerCalendarHandlers } from './calendar'
import { registerCardsHandlers } from './cards'
import { registerExportHandlers } from './export'
import { assertAllChannelsRegistered } from './index'
import { registerMaterialsHandlers } from './materials'
import { registerNotesHandlers } from './notes'
import { registerNotionHandlers } from './notion'
import { registerPendingHandlers } from './pending'
import { registerPortalHandlers } from './portal'
import { registerSecretHandlers } from './secrets'
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
  registerSecretHandlers()
  registerTimetableHandlers()
  registerCalendarHandlers()
  registerPortalHandlers()
  registerNotesHandlers()
  registerCardsHandlers()
  registerMaterialsHandlers()
  registerExportHandlers()
  registerAiHandlers()
  registerNotionHandlers()

  // 尚未实现的模块统一挂占位，等对应模块落地后从这里「顶掉」即可
  registerPendingHandlers()

  assertAllChannelsRegistered()
}
