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
 *   npm run bench            性能与内存基准，报告打到 stdout 并写入 .preview/
 *
 * 它们都跑在系统临时目录里，不会碰你真实的学习数据。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// electron 包的入口在普通 Node 下导出的是二进制路径
const electronPath = require('electron')

const requested = process.argv[2] ?? ''
const bench = requested === 'bench'
const scenario = ['timetable', 'portal', 'cards', 'notes', 'sync', 'export'].includes(requested)
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
