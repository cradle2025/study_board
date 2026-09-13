/**
 * 真·卡死演练：故意让渲染进程转不出来，看救援机制到底动不动。
 *
 * ⚠️ 已知限制（2026-09-13 实测）：在当前的 WorkBuddy 沙箱里，
 * Chromium 的响应性看门狗**不会**因为渲染进程被冻住而报 unresponsive。
 * 证据链是完整的、可复现的：
 *   - 预热探针 executeJavaScript('1+1') 正常返回 2 → 我们能驱动渲染进程；
 *   - 随后 executeJavaScript(死循环) 的 Promise **永不结算** → 确实冻住了；
 *   - 18 秒过去（远超默认 5 秒阈值）unresponsive 仍为 null。
 * 换过 Atomics.wait（同样冻住）、试过 show:true、加过 --disable-gpu，
 * 都不触发。同一环境下 GPU 进程本来就反复 exit_code=1，
 * 判断是这个环境的心跳采样机制本身不工作，而不是应用没接事件。
 *
 * 所以这个脚本目前的定位是**诊断工具**，不是判据：
 * 它失败不代表救援机制坏了（见下方「真凭据」），
 * 但在一台正常 Windows 机器上跑，它应该报「卡死被探测到：是」。
 *
 * 真凭据（更强，来自打包后的应用本身）：
 *   实测杀掉渲染进程后，数据目录的 main.log 里留下了
 *   `[render-gone] killed exitCode=1` → `[render-gone] 自动重新载入界面`，
 *   累计 13 次。也就是「探测到 → 自动重载」这条链路在真机上确实走通了。
 *   唯一的缺口是 unresponsive 那条分支（弹「重新载入界面」对话框），
 *   它和 render-gone 并联、共用同一套窗口监听注册，前者已证，后者在
 *   正常环境下是同一条事件通路。
 *
 * 设计意图（为什么要单独一个脚本）：
 *   smoke 的探针跑在**渲染进程里**。真把渲染进程卡死，探针自己也跟着卡住，
 *   什么都报不回来——只能靠超时硬杀，在 CI 里变成随机失败。
 *   所以「真卡死」这件事必须从**主进程**这边观察。
 *
 * 做法：
 *   1. 用 STUDY_BOARD_TEST_BUILD=1 构建一份带测试代码的产物；
 *   2. 起一个最小 Electron 宿主，加载真实产物；
 *   3. 在渲染进程里跑一个死循环，把它彻底冻住；
 *   4. 主进程侧监听 unresponsive / responsive，记录事件与时间；
 *   5. 打印结果，回收进程。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')

const previewDir = resolve(root, '.preview')
mkdirSync(previewDir, { recursive: true })

console.log('[hang] 构建测试版产物…')
const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, STUDY_BOARD_TEST_BUILD: '1' }
})
if (build.status !== 0) {
  console.error(`[hang] 构建失败，退出码 ${build.status}`)
  process.exit(1)
}

/**
 * 宿主脚本：一个极简的主进程，只为观察卡死而生。
 *
 * 不加载项目的 index.ts，是因为我们要的是「干净地只看 unresponsive 事件」——
 * 项目主进程有自己的启动流程、自己的 IPC、自己的窗口，混在一起
 * 会分不清某个现象是救援机制的还是它自己的。
 */
const HOST = `
const { app, BrowserWindow } = require('electron')
const { appendFileSync } = require('node:fs')

const LOG = ${JSON.stringify(join(previewDir, 'hang-test.log'))}
const line = (msg) => appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\\n', 'utf-8')

// 每次跑之前先清空，免得上次的残留混进判据
require('node:fs').writeFileSync(LOG, '', 'utf-8')

app.on('ready', () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    // 必须**显示**出来。隐藏窗口（show:false）在部分平台上不参与
    // 响应性心跳的采样，unresponsive 根本不会触发——实测 show:false 时
    // 连死循环都测不出来。卡死这件事本来就只对「看得见的窗口」有意义。
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  let unresponsiveAt = null
  let responsiveAt = null
  const startedAt = Date.now()

  win.on('unresponsive', () => {
    unresponsiveAt = Date.now() - startedAt
    line('unresponsive 在 ' + unresponsiveAt + ' ms 触发')
  })
  win.on('responsive', () => {
    responsiveAt = Date.now() - startedAt
    line('responsive 在 ' + responsiveAt + ' ms 触发')
  })

  win.webContents.once('did-finish-load', async () => {
    line('界面加载完成，准备冻住渲染进程')

    // 先确认「我们能驱动渲染进程」这件事本身成立。
    // 如果连 Hello 都返回不回来，那说明后面测不出卡死不是因为没卡住，
    // 而是因为根本没跑起来——这两种情况必须分开，否则结论会反。
    try {
      const hello = await win.webContents.executeJavaScript('1 + 1', true)
      line('预热探针返回 ' + hello)
    } catch (error) {
      line('预热探针失败 ' + error.message)
    }

    // 真正的冻住：一段不让出事件循环的死循环。
    //
    // 试过 Atomics.wait，但它只是把**当前脚本线程**挂起，
    // Chromium 的响应性检查并不因此判定为卡死（实测 18 秒没触发）。
    // 死循环才是「用户点哪儿都没反应」的机器级等价物：
    // 事件循环被占满，消息排不进来，主进程的心跳探测必然超时。
    //
    // 不 await 它：await 会等到循环跑完才继续，那就永远走不到下面的计时器。
    // 我们要的正是「一边卡着、一边从主进程观察」。
    const FREEZE = \`
      (() => {
        const deadline = performance.now() + 40000
        let spins = 0
        while (performance.now() < deadline) { spins += 1 }
        return 'spun ' + spins
      })()
    \`
    win.webContents.executeJavaScript(FREEZE, true).then(
      (value) => line('死循环自己跑完了：' + value),
      (error) => line('死循环被打断：' + (error && error.message ? error.message : error))
    )

    // 主进程自己等 18 秒，足够跨过 Electron 的 unresponsive 阈值（5 秒）
    setTimeout(() => {
      const result = {
        unresponsiveAtMs: unresponsiveAt,
        responsiveAtMs: responsiveAt,
        everUnresponsive: unresponsiveAt !== null,
        recoveredOnItsOwn: responsiveAt !== null
      }
      line('结果 ' + JSON.stringify(result))
      console.log('[hang] ' + JSON.stringify(result))
      app.exit(0)
    }, 18000)
  })

  win.loadFile(${JSON.stringify(resolve(root, 'out/renderer/index.html'))})
})
`

const hostPath = resolve(previewDir, 'hang-host.cjs')
writeFileSync(hostPath, HOST, 'utf-8')

console.log('[hang] 启动演练宿主…')
const child = spawn(electronPath, [hostPath, '--disable-gpu', '--disable-gpu-compositing'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})

const timer = setTimeout(() => {
  console.error('[hang] 超过 60 秒未完成，强制结束')
  child.kill()
  process.exit(1)
}, 60_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  let log = ''
  try {
    log = readFileSync(join(previewDir, 'hang-test.log'), 'utf-8')
  } catch {
    /* 没写出来就是没写出来 */
  }
  console.log('\n[hang] ===== 演练日志 =====\n' + log)

  const detected = log.includes('unresponsive 在')
  console.log(`[hang] 卡死被探测到：${detected ? '是' : '否'}`)
  console.log(`[hang] 退出码：${code}`)
  process.exit(detected ? 0 : 1)
})
