import { app, protocol, session, shell, type WebContents } from 'electron'

/**
 * 全局安全基线。
 *
 * 目标（对应「不要把端口暴露到公网」与「代码安全性审查」两条要求）：
 *  1. 本应用**从不监听任何 TCP 端口**，所有前后端通信都走 Electron IPC；
 *  2. 渲染层永远拿不到 Node 能力，只能调用 preload 白名单里的方法；
 *  3. 渲染层不能自行导航、不能开新窗口、不能加载任何远程页面；
 *  4. 所有系统权限（摄像头 / 麦克风 / 通知 / 定位…）一律拒绝；
 *  5. 通过 CSP 把渲染层能发起的网络请求压到最小。
 */

/** 允许用系统默认程序打开的协议，其余一律拒绝 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/** 应用自有协议：只用于读取本地资源，不出网 */
export const ASSET_SCHEME = 'sb-asset'

/** 必须早于 app ready 调用 */
export function hardenBeforeReady(): void {
  // 所有渲染进程一律开启沙箱
  app.enableSandbox()

  // 关闭不需要的 Chromium 能力，缩小攻击面
  app.commandLine.appendSwitch('no-pings')

  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/** 生产环境下渲染层是 file://，因此 CSP 主要靠 index.html 的 meta 标签兜底，
 *  这里额外把开发服务器返回的响应也套上同样的策略。 */
export function installSessionHardening(): void {
  const ses = session.defaultSession

  // 一律拒绝权限申请
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  // 拒绝一切设备访问
  ses.setDevicePermissionHandler(() => false)

  // 禁止渲染层使用 webRequest 之外的代理配置
  ses.setProxy({ mode: 'direct' }).catch(() => {
    /* 忽略：代理设置失败不影响主流程 */
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith('http://localhost') && !details.url.startsWith('http://127.0.0.1')) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_DEV]
      }
    })
  })
}

/** 开发服务器专用 CSP：只额外放开 Vite 的 HMR websocket */
const CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${ASSET_SCHEME}:`,
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** 拦截所有 webContents 上的危险行为 */
export function installWebContentsGuards(): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    // 不允许渲染层自行导航到任何地址
    contents.on('will-navigate', (event, url) => {
      if (!isInternalUrl(url)) {
        event.preventDefault()
        void openExternalSafely(url)
      }
    })

    // 不允许开新窗口，改为交给系统浏览器
    contents.setWindowOpenHandler(({ url }) => {
      void openExternalSafely(url)
      return { action: 'deny' }
    })

    // 不允许挂 webview
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    // 拒绝所有 webContents 的权限申请（双保险）
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    )
  })
}

function isInternalUrl(url: string): boolean {
  return (
    url.startsWith('file://') ||
    url.startsWith(`${ASSET_SCHEME}://`) ||
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:') ||
    url.startsWith('devtools://')
  )
}

/** 只有明确允许的协议才会被交给系统浏览器打开 */
export async function openExternalSafely(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('非法的链接')
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`不支持的协议：${parsed.protocol}`)
  }
  if (parsed.protocol !== 'mailto:' && !parsed.hostname) {
    throw new Error('链接缺少主机名')
  }
  await shell.openExternal(parsed.toString(), { activate: true })
}
