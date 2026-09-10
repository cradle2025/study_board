import { BrowserWindow, app, shell } from 'electron'
import { join } from 'node:path'

import { ASSET_SCHEME } from './security'

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

  // 兜底：即使页面里有残留链接，也不允许在主窗口内打开外链
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

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
