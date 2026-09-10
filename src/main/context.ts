import {
  detectPortableMode,
  ensureDir,
  iconsCacheDir,
  timetableImagesDir
} from './paths'
import type { AssetBuckets } from './services/assetProtocol'
import { resolveNotesDir, SettingsStore } from './services/settings'

/**
 * 应用级单例上下文。
 * 只在这里持有「需要跨模块共享、且必须唯一」的东西：设置与资源目录。
 */

export interface AppContext {
  settings: SettingsStore
  buckets: AssetBuckets
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
  current = {
    settings,
    buckets: buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot))
  }
  return current
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
