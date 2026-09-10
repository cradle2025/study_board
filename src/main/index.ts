import { BrowserWindow, app } from 'electron'

import { context, initContext } from './context'
import { registerIpcHandlers } from './ipc/register'
import { installAssetProtocol } from './services/assetProtocol'
import {
  hardenBeforeReady,
  installSessionHardening,
  installWebContentsGuards
} from './security'
import {
  prepareSmokeDataIfRequested,
  prepareSmokeEnvironment,
  runSmokeTestIfRequested
} from './smoke'
import { createMainWindow } from './window'

// 必须先于 app ready：注册自有协议、开启渲染进程沙箱
hardenBeforeReady()

// 冒烟测试跑在临时数据目录里，绝不碰用户真实数据
prepareSmokeEnvironment()

// 只允许运行一个实例，避免两个进程同时写同一个笔记库
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app
    .whenReady()
    .then(async () => {
      initContext()

      installSessionHardening()
      installWebContentsGuards()
      installAssetProtocol(() => context().buckets)
      registerIpcHandlers()

      // 必须在建窗之前把测试数据写好，否则渲染层可能先读到空数据
      await prepareSmokeDataIfRequested()

      const win = createMainWindow()
      runSmokeTestIfRequested(win)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((error: unknown) => {
      console.error('[main] 启动失败：', error)
      app.quit()
    })

  // Windows / Linux 上关掉所有窗口就退出；macOS 保持常驻
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  process.on('uncaughtException', (error) => {
    console.error('[main] 未捕获异常：', error)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[main] 未处理的 Promise 拒绝：', reason)
  })
}
