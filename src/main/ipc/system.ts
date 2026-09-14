import { app, shell } from 'electron'
import { isAbsolute, resolve, sep } from 'node:path'

import { CHANNELS } from '@shared/channels'
import type { AppInfo } from '@shared/types'

import { context, dataStatus } from '../context'
import { dataRoot, resolveAppPaths } from '../paths'
import { openExternalSafely } from '../security'
import { resolveNotesDir } from '../services/settings'
import { handle } from './index'

/** 只允许打开「本应用自己管辖」的目录，避免被当作任意文件打开器 */
function assertInsideAppRoots(target: string): string {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new Error('非法路径')
  }
  const settings = context().settings.get()
  const roots = [dataRoot(settings.portableMode), resolveNotesDir(settings)].map((r) =>
    resolve(r)
  )
  const absolute = resolve(isAbsolute(target) ? target : resolve(target))
  const inside = roots.some((root) => absolute === root || absolute.startsWith(root + sep))
  if (!inside) throw new Error('拒绝访问应用目录之外的位置')
  return absolute
}

export function registerSystemHandlers(): void {
  handle<unknown, AppInfo>(CHANNELS.APP_INFO, () => {
    const settings = context().settings.get()
    const data = dataStatus()
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale(),
      paths: resolveAppPaths(settings.portableMode, resolveNotesDir(settings)),
      dataSchema: data.supported,
      dataWrittenBy: data.stamp?.app || null,
      dataWarning: data.warning
    }
  })

  handle<string, null>(CHANNELS.APP_OPEN_EXTERNAL, async (url) => {
    await openExternalSafely(String(url))
    return null
  })

  handle<string, null>(CHANNELS.APP_OPEN_PATH, async (target) => {
    const absolute = assertInsideAppRoots(target)
    const error = await shell.openPath(absolute)
    if (error) throw new Error(error)
    return null
  })

  handle<string, null>(CHANNELS.APP_REVEAL_PATH, (target) => {
    shell.showItemInFolder(assertInsideAppRoots(target))
    return null
  })

  handle<unknown, null>(CHANNELS.APP_RELAUNCH, () => {
    app.relaunch()
    app.exit(0)
    return null
  })
}
