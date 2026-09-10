import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer')
}

/** 生产环境：渲染层永远不联网 */
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sb-asset:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' sb-asset:",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** 开发环境：只额外放开 Vite 的 HMR（脚本与 websocket） */
const CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sb-asset:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "media-src 'self' sb-asset:",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * 把 index.html 里的 %CSP% 换成对应环境的策略。
 * 这样开发和生产用的是同一份页面，不会出现「只在打包后才被 CSP 拦住」的问题。
 */
function cspPlugin(): Plugin {
  return {
    name: 'study-board:csp',
    transformIndexHtml(html, ctx) {
      const isDev = Boolean(ctx.server)
      return html
        .replace('%CSP%', isDev ? CSP_DEV : CSP_PROD)
        // 打包后页面是 file:// 打开的，crossorigin 属性会触发无意义的 CORS 校验
        .replace(/\s+crossorigin(="[^"]*")?/g, '')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      target: 'node20',
      sourcemap: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      target: 'node20',
      sourcemap: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [cspPlugin()],
    resolve: { alias },
    build: {
      target: 'chrome128',
      sourcemap: false,
      // file:// 场景下 modulepreload 提示没有意义，反而多出一次资源请求
      modulePreload: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
