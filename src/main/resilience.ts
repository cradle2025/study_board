import { app, dialog, type BrowserWindow } from 'electron'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { detectPortableMode, ensureDir, logsDir } from './paths'

/**
 * 崩溃与卡死的自救。
 *
 * 离线桌面应用有两种「用户自己完全没办法」的故障：
 *
 *  1. **界面卡死**。窗口还在、标题栏还能拖，但点哪儿都没反应。
 *     用户唯一能想到的办法是去任务管理器结束进程——那不但吓人，
 *     还会连带丢掉最近一次自动保存之后敲的字。
 *  2. **渲染进程崩溃**。窗口变成一片空白，连个提示都没有。
 *     用户会以为是自己按坏了什么，然后重装。
 *
 * 共同点是「程序说不了话」。所以这里做三件事：
 * 把现场写进日志、给用户一个明确的「重新载入」出口、
 * 能在后台自动恢复的就别去打扰用户。
 *
 * 有一件事这里做不到，得如实说：**如果是主进程自己卡住**
 * （比如某个 IPC 处理函数里转不出来了），那连这个对话框都弹不出来，
 * 只能靠系统层面的强杀。能缓解的是「主进程不干重活」这条纪律——
 * 所有可能耗时的活儿（图片解码、PDF 排版、网络请求）都不在主进程的启动路径上。
 */

/** 单个日志文件的上限。超了就轮转一次，只为留现场，不做长期堆积 */
const MAX_LOG_BYTES = 512 * 1024

/** 自动重新载入的频率限制：短时间反复崩说明不是偶发，再自动重载就是死循环 */
const RELOAD_WINDOW_MS = 60_000
const MAX_AUTO_RELOADS = 3

let cachedLogFile: string | null = null

function logFilePath(): string {
  if (cachedLogFile) return cachedLogFile
  try {
    cachedLogFile = join(ensureDir(logsDir(detectPortableMode())), 'main.log')
  } catch {
    // 数据目录都写不了（极少见）也得有个落点，否则日志整条链路就断了
    cachedLogFile = join(app.getPath('temp'), 'study-board-main.log')
  }
  return cachedLogFile
}

/**
 * 追加一行日志。
 *
 * **整个函数吞掉所有异常**：写日志这件事本身绝不允许把应用带下水——
 * 磁盘满了、文件被占用、权限不对，都不该让一个只是想记录信息的动作变成新的故障源。
 */
export function logLine(scope: string, message: string): void {
  try {
    const file = logFilePath()
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`)
    }
    appendFileSync(file, `${new Date().toISOString()} [${scope}] ${message}\n`, 'utf-8')
  } catch {
    /* 写不了就算了 */
  }
}

/** 日志文件的完整路径，出错提示里要给用户看 */
export function mainLogPath(): string {
  return logFilePath()
}

/**
 * 主进程级别的兜底。
 *
 * 打包后的应用没有控制台，`console.error` 打出去没人看得见，
 * 所以这些异常一律落盘——用户反馈「它有时候就不动了」的时候，
 * 这个文件是唯一能还原现场的东西。
 */
export function installMainProcessGuards(): void {
  process.on('uncaughtException', (error) => {
    // 开发时终端里也要看得到；打包后终端是空的，所以必须同时落盘
    console.error('[main] 未捕获异常：', error)
    logLine('uncaught', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[main] 未处理的 Promise 拒绝：', reason)
    logLine(
      'unhandled',
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    )
  })

  // GPU / 网络 / 工具进程挂掉：单独一个进程而已，应用还能用，但值得记一笔
  app.on('child-process-gone', (_event, details) => {
    logLine('child-gone', `${details.type} ${details.reason} exitCode=${details.exitCode}`)
  })
}

/**
 * 给主窗口装上「卡住能出来」的出口。
 *
 * 只在主窗口上装：导出 PDF 用的隐藏窗口是一次性的，它卡住只会让那次导出超时，
 * 弹对话框反而莫名其妙。
 */
export function attachWindowResilience(win: BrowserWindow): void {
  let recentReloads: number[] = []
  let recovering = false

  const noteReload = (): void => {
    recentReloads.push(Date.now())
  }

  const canAutoReload = (): boolean => {
    const now = Date.now()
    recentReloads = recentReloads.filter((at) => now - at < RELOAD_WINDOW_MS)
    return recentReloads.length < MAX_AUTO_RELOADS
  }

  win.on('unresponsive', () => {
    logLine('unresponsive', '界面超过阈值没有响应')
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '界面没有响应',
        message: '学习看板的界面卡住了',
        detail:
          '通常是一篇特别长的笔记、或者一张特别大的课表照片拖住了界面。\n\n' +
          '点「重新载入界面」可以恢复。笔记有自动保存，' +
          '最多丢失最近一次自动保存（停手 0.8 秒）之后敲进去的内容。',
        buttons: ['重新载入界面', '再等一会儿'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response !== 0) return
        logLine('unresponsive', '用户选择重新载入界面')
        noteReload()
        win.webContents.reload()
      })
      .catch(() => undefined)
  })

  win.on('responsive', () => {
    logLine('responsive', '界面恢复响应')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logLine('render-gone', `${details.reason} exitCode=${details.exitCode}`)
    if (recovering) return
    // 正常退出（用户关窗口）会走到这里，别把它当成崩溃
    if (details.reason === 'clean-exit') return

    if (canAutoReload()) {
      recovering = true
      noteReload()
      logLine('render-gone', '自动重新载入界面')
      win.webContents.reload()
      setTimeout(() => {
        recovering = false
      }, 3000)
      return
    }

    // 短时间内反复崩，说明不是偶发。停止自动重载，把话说清楚并给出日志位置
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: '学习看板异常退出',
        message: '界面进程反复崩溃，已停止自动重载',
        detail:
          `崩溃原因已经记在这个文件里：\n${mainLogPath()}\n\n` +
          '数据本身是安全的：所有内容都是原子写入的，' +
          '写入过程中断只会留下一个 .tmp 文件，不会损坏已有数据。',
        buttons: ['再重新载入一次', '关闭'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response !== 0) return
        recentReloads = []
        win.webContents.reload()
      })
      .catch(() => undefined)
  })

  /**
   * 首屏就没加载起来（比如安装包不完整）。
   * 不处理的话用户看到的是一个永远空白的窗口，什么线索都没有。
   */
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 是「主动取消」，用户点刷新之类的正常行为，不是故障
    if (!isMainFrame || errorCode === -3) return
    logLine('load-failed', `${errorCode} ${errorDescription} ${validatedUrl}`)
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: '界面加载失败',
        message: '学习看板没能加载界面',
        detail:
          `${errorDescription}（${errorCode}）\n\n` +
          `如果反复出现，可能是安装包不完整，建议重新下载安装。\n日志：${mainLogPath()}`,
        buttons: ['重试', '关闭'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0) win.webContents.reload()
      })
      .catch(() => undefined)
  })
}
