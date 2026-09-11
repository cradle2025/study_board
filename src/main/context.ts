import {
  detectPortableMode,
  ensureDir,
  iconsCacheDir,
  timetableFile,
  timetableImagesDir
} from './paths'
import type { AssetBuckets } from './services/assetProtocol'
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

  const timetable = new TimetableStore(timetableFile(snapshot.portableMode), timetableImagesDir(snapshot.portableMode))

  current = {
    settings,
    buckets: buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot)),
    timetable
  }
  return current
}

/**
 * 清理「有文件但没记录」的孤儿课表图片。
 *
 * 刻意**不放在启动路径上**：它是纯清理工作，不影响首屏能否显示，
 * 却要在课表图片目录里做一次目录遍历。放到窗口显示之后再跑，
 * 启动阶段就只做「读出必要数据」这一件事。
 */
export function sweepTimetableOrphans(): void {
  const swept = context().timetable.sweepOrphans()
  if (swept > 0) console.info(`[timetable] 清理了 ${swept} 个无主的课表图片`)
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
