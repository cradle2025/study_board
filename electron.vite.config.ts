import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer')
}

/**
 * 测试与基准代码不进生产包。
 *
 * `smoke.ts` / `bench.ts` 各自上千行，里面是渗透测试的探针与 payload，
 * 以及性能基准的取样逻辑。它们只对**我们**有用，对用户毫无价值，
 * 却会因为「都在 src/ 里、走同一条构建管线」而被打进 asar。
 *
 * 光靠 `STUDY_BOARD_SMOKE=1` 门控是不够的：那是运行期开关，
 * 拦得住执行，拦不住代码在包里躺着被解出来看。
 * 所以在**构建期**把这两个模块换成空实现——产物里连探针都搜不到。
 *
 * 为什么用插件而不是 `resolve.alias`：
 * 被换掉的说明符是**相对路径**（`'./smoke'`）。Vite 的 alias 是给
 * 包名 / 路径别名用的，对相对说明符不保证生效——实测写了 `'./smoke$'`
 * 也照旧把上千行探针打进了包。插件挂在 Rollup 的 `resolveId` 上，
 * 那正是相对说明符真正被解析的地方，所以这里它是可靠的。
 * （教训：判断「替换生效了没有」不能只看构建成功，要回产物里搜关键词。）
 *
 * **为什么还要留 `STUDY_BOARD_TEST_BUILD` 这个开关**：
 * `scripts/smoke.mjs` 是 `spawn(electron, ['.'])`，读的就是 `out/` 这个
 * 生产产物。如果无条件替换，冒烟测试会变成「跑了一个空壳，然后假装通过」——
 * 这是最坏的一种失败：测试全绿，但什么都没测。
 * 所以默认替换（打包安全），跑测试时由 runner 显式要求「带测试构建」。
 * 一个必须由人主动打开的开关，比一个必须记得关掉的开关安全得多。
 */
const TEST_BUILD = process.env['STUDY_BOARD_TEST_BUILD'] === '1'

function stubTestsInProduction(isProduction: boolean): Plugin {
  const enabled = isProduction && !TEST_BUILD
  const swaps: Record<string, string> = {
    smoke: resolve('src/main/smoke.stub.ts'),
    bench: resolve('src/main/bench.stub.ts')
  }
  return {
    name: 'study-board:stub-tests-in-production',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!enabled) return null
      // 只认 `./smoke` 这种裸相对说明符：带扩展名、带子路径的一律不动
      const match = /^\.\/([a-zA-Z]+)$/.exec(source)
      const name = match?.[1]
      const target = name ? swaps[name] : undefined
      // 只在「确实是 main 目录下那一对模块的直系引用」时替换。
      // 用 importer 判断而不是只认名字：万一别处也有个 ./smoke，替换它会莫名其妙
      if (!target || !importer) return null
      if (!/src[\\/]main[\\/](index|window|context)\.ts$/.test(importer)) return null
      return target
    }
  }
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

export default defineConfig(({ command }) => {
  // `electron-vite dev` / `preview` 都走 command === 'serve'，只有 build 才是生产
  const isProduction = command === 'build'
  return {
    main: {
      plugins: [stubTestsInProduction(isProduction), externalizeDepsPlugin()],
      resolve: { alias },
      build: {
        target: 'node20',
        sourcemap: false,
        emptyOutDir: false,
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
        emptyOutDir: false,
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
        emptyOutDir: false,
        // file:// 场景下 modulepreload 提示没有意义，反而多出一次资源请求
        modulePreload: false,
        chunkSizeWarningLimit: 900,
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      }
    }
  }
})
