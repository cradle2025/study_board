import { BrowserWindow, app } from 'electron'

import { benchEnabled, prepareBenchDataIfRequested, runBenchIfRequested } from './bench'
import { context, dataStatus, initContext, sweepOrphanFiles } from './context'
import { startMaterialsInboxWatch } from './ipc/materials'
import { startNotesSync } from './ipc/notes'
import { registerIpcHandlers } from './ipc/register'
import { mark } from './metrics'
import { installMainProcessGuards, logLine } from './resilience'
import { installAssetProtocol } from './services/assetProtocol'
import { reportDataWarning } from './services/dataVersion'
import { configureAppIdentity } from './services/reminders'
import {
  hardenBeforeReady,
  installSessionHardening,
  installWebContentsGuards
} from './security'
import {
  prepareIsolatedDataDir,
  prepareSmokeDataIfRequested,
  prepareUpdateScenarioIfRequested,
  runSmokeTestIfRequested,
  smokeEnabled
} from './smoke'
import { createMainWindow } from './window'

mark('main:index-start')

// 必须先于 app ready：注册自有协议、开启渲染进程沙箱
hardenBeforeReady()
mark('main:hardened')

/**
 * 把应用身份告诉 Windows。
 *
 * 必须**在任何通知之前**调，而且要与 electron-builder.yml 的 appId 一致 ——
 * Windows 只认「已注册过 AppUserModelID」的应用发的 toast，不设的话
 * `show()` 既不报错也不发 `failed`，通知直接消失（实测见 DECISIONS.md D-012）。
 * 放在这里而不是窗口起来之后：提醒可能在任何时刻到点。
 */
configureAppIdentity()

// 自动化运行（冒烟 / 基准）跑在临时数据目录里，绝不碰用户真实数据
prepareIsolatedDataDir()
// 更新场景要在数据闸口（initContext）之前把「未来版本」的印记摆好
prepareUpdateScenarioIfRequested()

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

      // 文件监听放在数据准备之后：ignoreInitial 只保证「首轮扫描不报事件」，
      // 而那之后再发生的写入都会报，种数据正好卡在这个缝里
      mark('notes-sync:start')
      startNotesSync()

      // 资料收件箱（浏览器扩展的下载落点）。ignoreInitial:false 是有意的：
      // 应用没开着的时候收件箱里攒下的文件，启动这一扫就会弹出来
      startMaterialsInboxWatch()

      const win = createMainWindow()
      mark('window:created')
      logLine('start', `v${app.getVersion()} ${process.platform}/${process.arch} electron=${process.versions['electron']}`)

      /**
       * 日程提醒调度。
       *
       * 放在窗口之后启动：它是后台的定时检查，跟首屏显示没有任何关系，
       * 排在前面只会让启动路径多一件事。晚启动的代价是「启动后 30 秒内
       * 到点的提醒会在下一次检查时才发」，可以接受。
       */
      context().reminders.start()

      /**
       * 数据版本不匹配的警告，等窗口起来之后再说。
       *
       * 放在 `initContext` 里直接弹的话，那是一个**窗口都还没出现**的
       * 模态框，用户看到的就是「双击了没反应」。而且自检 / 基准跑的时候
       * 它会永远卡在一个没人点的确认框上。
       */
      const dataWarning = dataStatus().warning
      if (dataWarning) reportDataWarning(dataWarning, !smokeEnabled() && !benchEnabled())

      win.once('ready-to-show', () => {
        mark('window:ready-to-show')
        // 首屏显示之后的空闲时间再做清理，不跟首屏抢
        sweepOrphanFiles()
      })

      if (smokeEnabled()) runSmokeTestIfRequested(win)
      else if (benchEnabled()) runBenchIfRequested(win)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((error: unknown) => {
      console.error('[main] 启动失败：', error)
      // 启动失败是最需要留下现场的一种：用户看到的就是「双击了没反应」，
      // 终端里那行字他永远看不到
      logLine(
        'startup-failed',
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      )
      app.quit()
    })

  // Windows / Linux 上关掉所有窗口就退出；macOS 保持常驻
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 未捕获异常 / 未处理的拒绝统一由这里接管：既打到终端，也落盘到数据目录。
  // 打包后的应用没有控制台，只打 console 等于什么都没留下
  installMainProcessGuards()
}
