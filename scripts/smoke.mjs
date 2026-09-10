/**
 * 冒烟测试：启动真实的 Electron 窗口，等渲染层挂载完成后自动退出。
 *
 * 退出码：
 *   0  主进程启动成功、preload 注入成功、界面挂载成功
 *   1  任一步骤失败或超时
 *
 * 用法：npm run smoke
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// electron 包的入口在普通 Node 下导出的是二进制路径
const electronPath = require('electron')

const env = { ...process.env, STUDY_BOARD_SMOKE: '1' }
// 某些环境（CI 容器、部分终端）会预设这个变量，会让 electron 退化成普通 Node
delete env.ELECTRON_RUN_AS_NODE

// 顺手截一张界面图，方便在没人盯着屏幕时确认渲染结果
if (!env.STUDY_BOARD_SMOKE_SHOT) {
  const shotDir = resolve(root, '.preview')
  mkdirSync(shotDir, { recursive: true })
  env.STUDY_BOARD_SMOKE_SHOT = resolve(shotDir, 'screenshot.png')
}

const TIMEOUT_MS = 60_000

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env })

const timer = setTimeout(() => {
  console.error(`[smoke] 超过 ${TIMEOUT_MS / 1000} 秒未完成，强制结束`)
  child.kill()
  process.exit(1)
}, TIMEOUT_MS)

child.on('error', (error) => {
  clearTimeout(timer)
  console.error('[smoke] 无法启动 Electron：', error.message)
  console.error('提示：如果 electron 二进制没下载成功，试试设置镜像后重装：')
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron')
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (signal) {
    console.error(`[smoke] 被信号 ${signal} 终止`)
    process.exit(1)
  }
  console.log(code === 0 ? '[smoke] 通过' : `[smoke] 失败，退出码 ${code}`)
  process.exit(code ?? 1)
})
