import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'

import { ASSET_SCHEME, openExternalSafely } from './security'
import { attachWindowResilience } from './resilience'

/** 渲染层加载入口：开发时走 Vite Dev Server，打包后走本地文件 */
function rendererEntry(): { url?: string; file?: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: devUrl }
  return { file: join(__dirname, '../renderer/index.html') }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    title: '学习看板',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 以下五项是本应用的安全底线，任何情况下都不要改
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // 打包后关闭开发者工具，防止终端用户被诱导打开控制台
      devTools: !app.isPackaged
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // 兜底：即使页面里有残留链接，也不允许在主窗口内打开外链。
  // 必须走 openExternalSafely 的协议白名单（http/https/mailto）——
  // 曾经这里直接调 shell.openExternal，而 setWindowOpenHandler 是
  // 「后注册覆盖先注册」，这一行会把 security.ts 里那个安全版整个顶掉。
  // 后果：笔记里一行 <a href="file:///C:/.../cmd.exe" target="_blank">点我</a>
  // 就能让系统执行任意路径的程序（smb:// 远程共享同理）。
  // 那是拿「打开个链接」换「跑一段代码」，不值。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url).catch(() => {
      /* 非白名单协议直接吞掉：弹错误框比静默忽略更容易被社工话术利用 */
    })
    return { action: 'deny' }
  })

  // 卡死 / 崩溃 / 加载失败时给用户一条出路，别让他只能去任务管理器
  attachWindowResilience(win)

  const entry = rendererEntry()
  if (entry.url) {
    void win.loadURL(entry.url)
    win.webContents.openDevTools({ mode: 'detach' })
  } else if (entry.file) {
    void win.loadFile(entry.file)
  }

  return win
}

/** 应用协议前缀，供渲染层拼接本地资源地址 */
export function assetPrefix(): string {
  return `${ASSET_SCHEME}://`
}
