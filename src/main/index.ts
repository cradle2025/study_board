import { BrowserWindow, app } from 'electron'
import { writeFileSync } from 'node:fs'

import { context, initContext } from './context'
import { registerIpcHandlers } from './ipc/register'
import { installAssetProtocol } from './services/assetProtocol'
import {
  hardenBeforeReady,
  installSessionHardening,
  installWebContentsGuards
} from './security'
import { createMainWindow } from './window'

// 必须先于 app ready：注册自有协议、开启渲染进程沙箱
hardenBeforeReady()

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
    .then(() => {
      initContext()

      installSessionHardening()
      installWebContentsGuards()
      installAssetProtocol(() => context().buckets)
      registerIpcHandlers()

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

/**
 * 冒烟测试：CI / 本地用 STUDY_BOARD_SMOKE=1 启动，渲染层加载完成即自动退出。
 * 没人盯着屏幕时，用它验证「主进程起得来、preload 注得进去、渲染层跑得起来」。
 */
function runSmokeTestIfRequested(win: BrowserWindow): void {
  if (process.env['STUDY_BOARD_SMOKE'] !== '1') return

  const timer = setTimeout(() => {
    console.error('[smoke] 超时：渲染层 20 秒内未加载完成')
    app.exit(1)
  }, 20_000)

  win.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(timer)
    console.error(`[smoke] 加载失败：${code} ${description}`)
    app.exit(1)
  })

  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        `(() => {
           const app = document.querySelector('study-board-app')
           return JSON.stringify({
             customElement: Boolean(app),
             mounted: Boolean(app && app.querySelector('.sb-shell')),
             bridge: typeof window.studyBoard === 'object'
           })
         })()`,
        true
      )
      .then((raw: unknown) => {
        clearTimeout(timer)
        const parsed = JSON.parse(String(raw)) as Record<string, boolean>
        console.info('[smoke] 渲染层自检：', raw)
        const passed = Boolean(parsed['customElement'] && parsed['mounted'] && parsed['bridge'])
        void captureIfRequested(win).finally(() => {
          setTimeout(() => app.exit(passed ? 0 : 1), 300)
        })
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        console.error('[smoke] 自检脚本执行失败：', error)
        app.exit(1)
      })
  })
}

/** 设了 STUDY_BOARD_SMOKE_SHOT 就把窗口截图存下来，方便在没人看屏幕时留个证据 */
async function captureIfRequested(win: BrowserWindow): Promise<void> {
  const target = process.env['STUDY_BOARD_SMOKE_SHOT']
  if (!target) return
  try {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const image = await win.webContents.capturePage()
    writeFileSync(target, image.toPNG())
    console.info(`[smoke] 截图已保存：${target}`)
  } catch (error) {
    console.error('[smoke] 截图失败：', error)
  }
}
