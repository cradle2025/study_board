/**
 * 冒烟测试 / 性能基准：启动真实的 Electron 窗口跑一遍自检，然后自动退出。
 *
 * 退出码：
 *   0  自检全部通过
 *   1  任一步骤失败或超时
 *
 * 用法：
 *   npm run smoke            基础自检：主进程起得来、preload 注得进去、界面挂得上
 *   npm run smoke:timetable  课程表端到端：写入单元格 + 图片导入 + 渲染 + 截图
 *   npm run smoke:portal     网站门户端到端：内置站点 + 图标显示 + 增删改隐藏
 *   npm run smoke:cards      课程卡片端到端：翻转 + 课表带过课程 + 自动建笔记
 *   npm run smoke:notes      笔记编辑器端到端：双模式切换 + 工具栏 + md 往返
 *   npm run smoke:sync       笔记库文件监听：外部新增/改动/删除 + 冲突追问
 *   npm run smoke:export     笔记导出：md / html / docx / pdf 四种产物落到磁盘
 *   npm run smoke:ai         AI 助手与密钥：没配密钥时拦在出网之前 + 密钥密文落盘
 *   npm run smoke:notion     Notion 同步：id 解析、未配置时拦在出网之前、冲突不自动覆盖
 *   npm run smoke:security   渗透测试：逃逸 / XSS / 协议穿越 / IPC 模糊 / 导航劫持 / 端口
 *   npm run bench            性能与内存基准，报告打到 stdout 并写入 .preview/
 *
 * 它们都跑在系统临时目录里，不会碰你真实的学习数据。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// electron 包的入口在普通 Node 下导出的是二进制路径
const electronPath = require('electron')

const requested = process.argv[2] ?? ''
const bench = requested === 'bench'
const scenario = ['timetable', 'portal', 'cards', 'notes', 'sync', 'export', 'ai', 'notion', 'security', 'materials'].includes(requested)
  ? requested
  : 'basic'
const label = bench ? 'bench' : scenario

const env = { ...process.env }
// 某些环境（CI 容器、部分终端）会预设这个变量，会让 electron 退化成普通 Node
delete env.ELECTRON_RUN_AS_NODE

const previewDir = resolve(root, '.preview')
mkdirSync(previewDir, { recursive: true })

if (bench) {
  env.STUDY_BOARD_BENCH = '1'
  env.STUDY_BOARD_BENCH_OUT = process.env.STUDY_BOARD_BENCH_OUT ?? resolve(previewDir, 'bench.json')
} else {
  env.STUDY_BOARD_SMOKE = '1'
  env.STUDY_BOARD_SMOKE_SCENARIO = scenario
  // 顺手截图，方便在没人盯着屏幕时确认渲染结果
  if (!env.STUDY_BOARD_SMOKE_SHOT) {
    env.STUDY_BOARD_SMOKE_SHOT = resolve(previewDir, 'screenshot.png')
  }
}

const TIMEOUT_MS = bench ? 150_000 : 90_000

/**
 * 先构建一份 out/，再启动。
 *
 * 这里是 `spawn(electron, ['.'])`，读的正是 `out/`，所以**必须先构建**——
 * 否则测的是上一次留下的产物，源码改了也看不出来。
 *
 * 但两种模式要的产物不一样，这一点必须分清：
 *
 *   自检（smoke）要**带测试代码**的产物。
 *     生产构建会把 smoke.ts 换成空实现（见 electron.vite.config.ts），
 *     用一个空壳去跑自检，所有场景都会「通过」却一行断言都没跑——
 *     比失败更危险，因为它看起来是绿的。
 *
 *   性能基准（bench）要**跟出厂一致**的产物。
 *     基准数字是要拿来跟历史数据比、用来判断「这次改动有没有变慢」的。
 *     拿一份掺了测试代码的构建去测，量出来的既不是用户装到的那个东西，
 *     也不跟历史基线可比——数字全是假的。
 *
 * 所以：只有 smoke 才传 STUDY_BOARD_TEST_BUILD=1。
 * 历史上这里漏了 `!bench` 这个判断，于是 bench 一直在量测试版构建，
 * 产物是 321 KB 而真实产物 182 KB。别再把这两个模式混在一起了。
 */
const TEST_BUILD = !bench
console.log(`[${label}] 构建${TEST_BUILD ? '测试版' : '生产版'}产物…`)
const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: TEST_BUILD ? { ...process.env, STUDY_BOARD_TEST_BUILD: '1' } : { ...process.env }
})
if (build.status !== 0) {
  console.error(`[${label}] 构建失败，退出码 ${build.status}`)
  process.exit(1)
}

/**
 * 构建完就地验一次「产物的形态和这次要跑的模式对得上」。
 *
 * 这一步看着冗余，其实是整套自动化的保险丝：判据一旦失效，
 * 我们会拿着一堆假绿继续往前走。
 *
 * 做法很土：直接在打包产物里搜一个只可能来自真身的字符串。
 * 用测试自身的入口文案，而不是 `smoke.ts` 里的某个变量名——
 * 变量名会被压缩器改名，字符串字面量不会。
 * 实测「自检」在测试构建里出现 22 次、生产构建里 0 次，是个干净的判据。
 *
 * 注意是**双向**校验：smoke 少了测试代码要拦（空通过），
 * bench 混进了测试代码也要拦（量出来的数字不反映出厂形态）。
 */
const MAIN_BUNDLE = resolve(root, 'out', 'main', 'index.js')
const MARKER = '自检'
let bundleSource = ''
try {
  bundleSource = readFileSync(MAIN_BUNDLE, 'utf-8')
} catch {
  console.error(`[${label}] 找不到主进程产物：${MAIN_BUNDLE}`)
  process.exit(1)
}
if (TEST_BUILD && !bundleSource.includes(MARKER)) {
  console.error(`[${label}] 产物里没有测试代码，拒绝跑一次「空通过」`)
  console.error('  这通常意味着 STUDY_BOARD_TEST_BUILD 没有生效，')
  console.error('  检查 electron.vite.config.ts 里的 stubTestsInProduction 插件。')
  process.exit(1)
}
if (!TEST_BUILD && bundleSource.includes(MARKER)) {
  console.error(`[${label}] 产物里混进了测试代码，拒绝拿它量性能`)
  console.error('  基准必须跑在跟出厂一致的构建上，否则数字跟历史基线不可比。')
  console.error('  检查 scripts/smoke.mjs 里的 TEST_BUILD 判断。')
  process.exit(1)
}

console.log(`[${label}] 启动 Electron…`)
const child = spawn(electronPath, ['.'], { stdio: 'inherit', env })

const timer = setTimeout(() => {
  console.error(`[${label}] 超过 ${TIMEOUT_MS / 1000} 秒未完成，强制结束`)
  child.kill()
  process.exit(1)
}, TIMEOUT_MS)

child.on('error', (error) => {
  clearTimeout(timer)
  console.error(`[${label}] 无法启动 Electron：`, error.message)
  console.error('提示：如果 electron 二进制没下载成功，试试设置镜像后重装：')
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron')
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (signal) {
    console.error(`[${label}] 被信号 ${signal} 终止`)
    process.exit(1)
  }
  if (bench) {
    // 报告由主进程自己写盘，这里只负责把结果路径说清楚
    const out = env.STUDY_BOARD_BENCH_OUT
    const summary = { scenario: label, exitCode: code ?? 1, report: out }
    writeFileSync(resolve(previewDir, 'bench-last-run.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(code === 0 ? `[${label}] 完成，报告：${out}` : `[${label}] 失败，退出码 ${code}`)
    process.exit(code ?? 1)
  }
  console.log(code === 0 ? `[smoke] 通过（${scenario}）` : `[smoke] 失败（${scenario}），退出码 ${code}`)
  process.exit(code ?? 1)
})
