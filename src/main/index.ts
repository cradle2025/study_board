import { BrowserWindow, app } from 'electron'

import { benchEnabled, prepareBenchDataIfRequested, runBenchIfRequested } from './bench'
import { context, initContext, sweepTimetableOrphans } from './context'
import { registerIpcHandlers } from './ipc/register'
import { mark } from './metrics'
import { installAssetProtocol } from './services/assetProtocol'
import {
  hardenBeforeReady,
  installSessionHardening,
  installWebContentsGuards
} from './security'
import {
  prepareIsolatedDataDir,
  prepareSmokeDataIfRequested,
  runSmokeTestIfRequested,
  smokeEnabled
} from './smoke'
import { createMainWindow } from './window'

mark('main:index-start')

// 必须先于 app ready：注册自有协议、开启渲染进程沙箱
hardenBeforeReady()
mark('main:hardened')

// 自动化运行（冒烟 / 基准）跑在临时数据目录里，绝不碰用户真实数据
prepareIsolatedDataDir()

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
      mark('app:ready')

      // 启动关键路径上只做一件事：把渲染首屏必须的数据读进来
      mark('context:start')
      initContext()
      mark('context:end')

      installSessionHardening()
      installWebContentsGuards()
      installAssetProtocol(() => context().buckets)
      registerIpcHandlers()
      mark('ipc:registered')

      // 必须在建窗之前把测试数据写好，否则渲染层可能先读到空数据
      await prepareSmokeDataIfRequested()
      if (benchEnabled()) await prepareBenchDataIfRequested()

      const win = createMainWindow()
      mark('window:created')
      win.once('ready-to-show', () => {
        mark('window:ready-to-show')
        // 首屏显示之后的空闲时间再做清理，不跟首屏抢
        sweepTimetableOrphans()
      })

      if (smokeEnabled()) runSmokeTestIfRequested(win)
      else if (benchEnabled()) runBenchIfRequested(win)

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
