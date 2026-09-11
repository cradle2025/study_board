import {
  detectPortableMode,
  ensureDir,
  iconsCacheDir,
  portalFile,
  timetableFile,
  timetableImagesDir
} from './paths'
import type { AssetBuckets } from './services/assetProtocol'
import { PortalStore } from './services/portal'
import { resolveNotesDir, SettingsStore } from './services/settings'
import { TimetableStore } from './services/timetable'

/**
 * 应用级单例上下文。
 * 只在这里持有「需要跨模块共享、且必须唯一」的东西：设置、资源目录、各类存储。
 */

export interface AppContext {
  settings: SettingsStore
  buckets: AssetBuckets
  timetable: TimetableStore
  portal: PortalStore
}

let current: AppContext | null = null

function buildBuckets(portable: boolean, notesDir: string): AssetBuckets {
  return {
    notes: ensureDir(notesDir),
    timetable: ensureDir(timetableImagesDir(portable)),
    icons: ensureDir(iconsCacheDir(portable))
  }
}

export function initContext(): AppContext {
  const portable = detectPortableMode()
  const settings = new SettingsStore(portable)
  const snapshot = settings.get()

  // 课表图片与门户图标各用一个目录：这样「清理孤儿文件」是各自独立的一件事，
  // 不会出现某一侧的清理逻辑误删另一侧正在使用的文件
  const timetable = new TimetableStore(
    timetableFile(snapshot.portableMode),
    timetableImagesDir(snapshot.portableMode)
  )
  const portal = new PortalStore(portalFile(snapshot.portableMode), iconsCacheDir(snapshot.portableMode))

  current = {
    settings,
    buckets: buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot)),
    timetable,
    portal
  }
  return current
}

/**
 * 清理「有文件但没记录」的孤儿文件（课表图片、门户图标）。
 *
 * 刻意**不放在启动路径上**：它是纯清理工作，不影响首屏能否显示，
 * 却要做目录遍历。放到窗口显示之后再跑，
 * 启动阶段就只做「读出必要数据」这一件事。
 */
export function sweepOrphanFiles(): void {
  const sweptImages = context().timetable.sweepOrphans()
  if (sweptImages > 0) console.info(`[timetable] 清理了 ${sweptImages} 个无主的课表图片`)

  const sweptIcons = context().portal.sweepOrphans()
  if (sweptIcons > 0) console.info(`[portal] 清理了 ${sweptIcons} 个无主的站点图标`)
}

export function context(): AppContext {
  if (!current) throw new Error('应用上下文尚未初始化')
  return current
}

/** 笔记库目录被用户改动后，同步刷新资源桶 */
export function refreshBuckets(): void {
  const ctx = context()
  const snapshot = ctx.settings.get()
  ctx.buckets = buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot))
}
