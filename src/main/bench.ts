import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { context } from './context'
import { marksReport } from './metrics'
import { encodePng } from './services/png'

/**
 * 性能 / 内存基准。
 *
 * 只在 STUDY_BOARD_BENCH=1 时启用，跑在临时数据目录里（与冒烟测试共用隔离机制），
 * 结果既打到 stdout，也写一份 JSON 到 STUDY_BOARD_BENCH_OUT，方便优化前后 diff。
 *
 * 为什么不用纯 Node 的微基准：
 *  - 真正会拖慢用户的是「IPC 往返 + 落盘 + DOM 重绘」这一整条链路，
 *    分开量每个环节都很快，合起来才是真数字；
 *  - 内存要看**进程级工作集**，不是 JS 堆——渲染进程里解码后的位图
 *    根本不在 JS 堆里记账，只看 heapUsed 会严重低估。
 */

/** 单元格保存的压测轮数。40 轮足以看出中位数与长尾，又不至于让报告跑成分钟级 */
const CELL_ITERATIONS = 40

/** 预热轮数：这几次的耗时不计入统计（见探针里的说明） */
const CELL_WARMUP = 6

/** 造一份有代表性的课表：多填一些格子，免得优化只在小数据上好看 */
async function seedBenchData(): Promise<void> {
  const { timetable, settings } = context()

  settings.patch({ timetable: { periodCount: 11 } })

  const rows = []
  for (let index = 1; index <= 11; index += 1) {
    const start = 8 * 60 + (index - 1) * 55
    const fmt = (total: number): string =>
      `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    rows.push({ index, start: fmt(start), end: fmt(start + 45) })
  }
  timetable.setRows(rows)

  // 大约填满一半的格子：这个密度下「整表重绘」和「单格重绘」的差距才会显出来
  const courses = ['高等数学 A', '大学英语', '数据结构', '线性代数', '概率论', '操作系统']
  const teachers = ['张启明', 'Li Na', '王海', '陈静', '刘一鸣', '赵敏']
  let filled = 0
  for (let period = 1; period <= 11; period += 1) {
    for (let column = 0; column < 7; column += 1) {
      if ((period + column) % 2 !== 0) continue
      const pick = (period + column) % courses.length
      timetable.setCell(`${period}:${column}`, {
        courseName: courses[pick] as string,
        teacher: teachers[pick] as string,
        location: `教${(pick % 4) + 1}-${200 + period * 3 + column}`,
        duration: '45 分钟',
        remark: period % 3 === 0 ? '每周有作业' : ''
      })
      filled += 1
    }
  }

  // 两张课表照片，顺带把图片链路也压进来
  const sources: string[] = []
  for (let i = 0; i < 2; i += 1) {
    const source = join(app.getPath('temp'), `study-board-bench-${Date.now()}-${i}.png`)
    writeFileSync(source, makeTestPng(1600, 1100, i))
    sources.push(source)
  }
  const result = await timetable.addImages(sources)
  console.info(`[bench] 造数据：${filled} 个单元格，${result.added} 张课表照片`)

  if (filled < 20 || result.added !== 2) throw new Error('基准数据准备失败')
}

/** 画一张有明显色块的图，保证图片链路真的被走到 */
function makeTestPng(width: number, height: number, seed: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const band = Math.floor(y / Math.max(1, Math.floor(height / 6)))
      rgba[i] = (band * 37 + seed * 90) % 256
      rgba[i + 1] = ((x + y + seed * 40) % 220) < 110 ? 110 : 190
      rgba[i + 2] = (band * 53 + seed * 30) % 256
      rgba[i + 3] = 255
    }
  }
  return encodePng(rgba, width, height)
}

/* ------------------------------------------------------------------ 渲染层探针 */

/**
 * 探针只做两件事：
 *  1. 读出渲染层自己的耗时打点与内存；
 *  2. **真的驱动界面**跑 40 轮「双击 → 填值 → 保存」，量端到端耗时。
 *
 * 不用轮询等待渲染结果，改用 MutationObserver——它一有变化就被唤醒，
 * 不会把「等 DOM」的时间算进被测目标里。
 */
const BENCH_PROBE = `(async () => {
  const r = (value) => Math.round(value * 100) / 100
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const waitFor = (selector, timeout = 20000) =>
    new Promise((resolve) => {
      const found = document.querySelector(selector)
      if (found) return resolve(found)
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector)
        if (el) { observer.disconnect(); resolve(el) }
      })
      observer.observe(document.body, { subtree: true, childList: true })
      setTimeout(() => { observer.disconnect(); resolve(null) }, timeout)
    })

  const waitForText = (selector, expected, timeout = 5000) =>
    new Promise((resolve) => {
      const ok = () => {
        const el = document.querySelector(selector)
        return Boolean(el && el.textContent === expected)
      }
      if (ok()) return resolve(true)
      const observer = new MutationObserver(() => {
        if (ok()) { observer.disconnect(); resolve(true) }
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      setTimeout(() => { observer.disconnect(); resolve(false) }, timeout)
    })

  /**
   * 等某个打点条目的数量超过已知值。
   *
   * 用打点而不是查 DOM，是因为它对应的是**语义上的完成**
   * （例如 sb:view:timetable:ready 是在「数据取回并渲染完」之后打的），
   * 而查 DOM 只能碰运气撞上某个中间态。
   */
  const waitForNewMark = (name, previousCount, timeout = 20000) =>
    new Promise((resolve) => {
      const deadline = Date.now() + timeout
      const tick = () => {
        if (performance.getEntriesByName(name).length > previousCount) return resolve(true)
        if (Date.now() > deadline) return resolve(false)
        setTimeout(tick, 8)
      }
      tick()
    })

  const shell = await waitFor('study-board-app .sb-shell')
  if (!shell) return JSON.stringify({ error: '应用外壳未挂载' })

  const navButton = await waitFor('[data-route="timetable"]', 25000)
  if (!navButton) return JSON.stringify({ error: '导航未就绪' })

  /**
   * 关键：必须等应用**完全初始化完**再开始计时。
   *
   * 导航按钮在 bootstrap 早期（renderNav）就存在了，而那时首页自己的表格
   * 还在加载。这时候点导航，测到的会是「首页加载 + 课表页加载」互相争抢的结果。
   */
  const shellReady0 = performance.getEntriesByName('sb:shell-ready').length
  if (!(await waitForNewMark('sb:shell-ready', shellReady0))) {
    return JSON.stringify({ error: '应用未在超时内完成初始化' })
  }
  await wait(120)

  const nav = performance.getEntriesByType('navigation')[0]
  const navigation = nav
    ? {
        domInteractiveMs: r(nav.domInteractive),
        domContentLoadedMs: r(nav.domContentLoadedEventEnd),
        loadEndMs: r(nav.loadEventEnd)
      }
    : null

  /* ---- 冷导航：点导航 → 页面挂载 → 数据加载 + 渲染完成 ---- */
  const readyBefore = performance.getEntriesByName('sb:view:timetable:ready').length
  const navStart = performance.now()
  navButton.click()
  const editor = await waitFor('input[name="tt-mode"]')
  if (!editor) return JSON.stringify({ error: '课程表编辑页未挂载' })
  const navToMountMs = performance.now() - navStart

  if (!(await waitForNewMark('sb:view:timetable:ready', readyBefore, 25000))) {
    return JSON.stringify({ error: '课程表数据未加载完成' })
  }
  const navToReadyMs = performance.now() - navStart

  const domNodesIdle = document.querySelectorAll('*').length
  const heapIdle = performance.memory ? performance.memory.usedJSHeapSize : 0

  /* ---- 单元格保存压测 ---- */
  /**
   * 前若干次不计入统计：首次调用要付 JIT 编译、样式首次命中、渲染层刚起来的
   * 各种一次性成本。把它们算进来只会抬高 p95，而且抬高多少完全取决于
   * 「什么时候开始测」，不可复现。
   */
  const WARMUP = ${CELL_WARMUP}
  const samples = []
  let missed = 0
  for (let i = 0; i < ${CELL_ITERATIONS} + WARMUP; i += 1) {
    const period = 2 + (i % 9)
    const column = i % 6
    const key = period + ':' + column
    const cell = document.querySelector('.sb-timetable__cell[data-key="' + key + '"]')
    if (!cell) { missed += 1; continue }

    const value = '压测课程 ' + i
    const t0 = performance.now()
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    const input = document.querySelector('.sb-tt-editor [data-field="courseName"]')
    const save = document.querySelector('.sb-tt-editor [data-role="save"]')
    if (!input || !save) { missed += 1; continue }
    input.value = value
    save.click()

    const painted = await waitForText(
      '.sb-timetable__cell[data-key="' + key + '"] .sb-ttcell__name',
      value
    )
    if (!painted) { missed += 1; continue }
    if (i >= WARMUP) samples.push(performance.now() - t0)
  }

  const sorted = samples.slice().sort((a, b) => a - b)
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0)
  const sum = samples.reduce((acc, value) => acc + value, 0)

  /* ---- 热导航：回首页再进来，量无人争抢时的整表渲染成本 ---- */
  const navReadyBefore = performance.getEntriesByName('sb:view:timetable:ready').length
  const homeReadyBefore = performance.getEntriesByName('sb:view:home:ready').length
  document.querySelector('[data-route="home"]')?.click()
  await waitForNewMark('sb:view:home:ready', homeReadyBefore, 25000)
  await wait(150)
  const warmClick = performance.now()
  document.querySelector('[data-route="timetable"]')?.click()
  await waitForNewMark('sb:view:timetable:ready', navReadyBefore, 25000)
  const warmNavMs = performance.now() - warmClick

  const memory = performance.memory

  // 打点放在最后读：此时 bootstrap 与首屏都已经走完，条目才齐
  const marks = performance.getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith('sb:'))
    .map((entry) => ({ name: entry.name, ms: r(entry.startTime) }))

  return JSON.stringify({
    navigation,
    marks,
    navToMountMs: r(navToMountMs),
    navToReadyMs: r(navToReadyMs),
    warmNavMs: r(warmNavMs),
    save: {
      warmup: WARMUP,
      measured: samples.length,
      missed,
      totalMs: r(sum),
      avgMs: samples.length ? r(sum / samples.length) : 0,
      p50Ms: r(at(0.5)),
      p95Ms: r(at(0.95)),
      maxMs: r(sorted.length ? sorted[sorted.length - 1] : 0)
    },
    dom: {
      idleNodes: domNodesIdle,
      nodesAfterSaves: document.querySelectorAll('*').length,
      timetableCells: document.querySelectorAll('.sb-timetable__cell').length,
      toasts: document.querySelectorAll('.sb-toast').length
    },
    rendererHeap: memory
      ? {
          idleUsedMB: r(heapIdle / 1048576),
          usedMB: r(memory.usedJSHeapSize / 1048576),
          totalMB: r(memory.totalJSHeapSize / 1048576),
          limitMB: r(memory.jsHeapSizeLimit / 1048576)
        }
      : null
  })
})()`

/* ------------------------------------------------------------------ 主流程 */

export function benchEnabled(): boolean {
  return process.env['STUDY_BOARD_BENCH'] === '1'
}

/** 必须在建窗之前 await 完成，否则渲染层可能先读到空数据 */
export async function prepareBenchDataIfRequested(): Promise<void> {
  if (!benchEnabled()) return
  await seedBenchData()
  measureLazyLoads()
}

const lazyLoads: Array<{ name: string; ms: number; ok: boolean }> = []

/**
 * 量一下几个「只在用到时才 require」的依赖要花多久。
 * 这些数字决定了它们值不值得继续懒加载——HEIF 解码器有 2MB，
 * 一旦加载成本高，就必须保持懒加载，绝不能挪到启动路径上。
 */
function measureLazyLoads(): void {
  const targets: Array<[string, () => unknown]> = [
    ['libheif-js/wasm-bundle', () => require('libheif-js/wasm-bundle')]
  ]
  for (const [name, load] of targets) {
    const started = process.hrtime.bigint()
    let ok = true
    try {
      load()
    } catch (error) {
      ok = false
      console.error(`[bench] 懒加载 ${name} 失败：`, error)
    }
    const ms = round(Number(process.hrtime.bigint() - started) / 1e6, 2)
    lazyLoads.push({ name, ms, ok })
    console.info(`[bench] 懒加载 ${name}：${ms} ms`)
  }
}

export function runBenchIfRequested(win: BrowserWindow): void {
  if (!benchEnabled()) return

  const timer = setTimeout(() => {
    console.error('[bench] 超时：渲染层未在 90 秒内跑完基准')
    app.exit(1)
  }, 90_000)

  // 探针失败时如果没有渲染层日志，只能靠猜，所以照样转出来
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: string; message?: string; sourceId?: string; lineNumber?: number }
    if (first && typeof first === 'object' && 'message' in first) {
      console.info(`[renderer:${first.level ?? '?'}] ${first.message} (${first.sourceId ?? ''}:${first.lineNumber ?? 0})`)
      return
    }
    const [, level, message, line, sourceId] = args as [unknown, number, string, number, string]
    console.info(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    clearTimeout(timer)
    console.error('[bench] 渲染进程崩溃：', details.reason, details.exitCode)
    app.exit(1)
  })

  win.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(timer)
    console.error(`[bench] 加载失败：${code} ${description}`)
    app.exit(1)
  })

  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(BENCH_PROBE, true)
      .then((raw: unknown) => {
        clearTimeout(timer)
        const renderer = JSON.parse(String(raw)) as Record<string, unknown>
        if (renderer['error']) {
          console.error('[bench] 渲染层探针失败：', renderer['error'])
          app.exit(1)
          return
        }
        const report = buildReport(renderer)
        emit(report)
        app.exit(0)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        console.error('[bench] 探针执行失败：', error)
        app.exit(1)
      })
  })
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function mb(bytes: number): number {
  return round(bytes / 1048576, 1)
}

/** 进程级内存：工作集才是用户真正占用的物理内存，JS 堆只是其中一部分 */
function memorySnapshot(): Record<string, unknown> {
  const processes = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    cpuPercent: round(metric.cpu?.percentCPUUsage ?? 0, 2),
    workingSetMB: round((metric.memory?.workingSetSize ?? 0) / 1024, 1),
    peakWorkingSetMB: round((metric.memory?.peakWorkingSetSize ?? 0) / 1024, 1)
  }))

  const main = process.memoryUsage()
  const total = processes.reduce((sum, item) => sum + item.workingSetMB, 0)

  return {
    processes,
    totalWorkingSetMB: round(total, 1),
    mainProcess: {
      rssMB: mb(main.rss),
      heapUsedMB: mb(main.heapUsed),
      heapTotalMB: mb(main.heapTotal),
      externalMB: mb(main.external)
    }
  }
}

function buildReport(renderer: Record<string, unknown>): Record<string, unknown> {
  const phases = marksReport()
  const at = (name: string): number | null => {
    const found = phases.find((item) => item.name === name)
    return found ? found.ms : null
  }
  const delta = (from: string, to: string): number | null => {
    const a = at(from)
    const b = at(to)
    return a === null || b === null ? null : round(b - a, 2)
  }

  return {
    generatedAt: new Date().toISOString(),
    versions: {
      electron: process.versions['electron'] ?? '',
      chrome: process.versions['chrome'] ?? '',
      node: process.versions['node'] ?? ''
    },
    platform: `${process.platform}-${process.arch}`,
    /**
     * 启动耗时拆解。把「Electron 自己的启动」和「我们代码的耗时」分开看很重要——
     * 否则很容易把 Chromium 的 150ms 记在自己账上，然后去做无用的优化。
     */
    startup: {
      electronBootMs: delta('main:index-start', 'app:ready'),
      ourInitMs: delta('app:ready', 'ipc:registered'),
      seedMs: delta('ipc:registered', 'window:created'),
      windowToFirstPaintMs: delta('window:created', 'window:ready-to-show'),
      firstPaintTotalMs: delta('main:index-start', 'window:ready-to-show')
    },
    // 主进程阶段打点：每个数字都是「相对主进程 JS 起点」的毫秒数
    mainPhases: phases,
    lazyLoads,
    renderer,
    memory: memorySnapshot()
  }
}

function emit(report: Record<string, unknown>): void {
  const json = `${JSON.stringify(report, null, 2)}\n`
  console.info(`\n[bench] ===== 基准报告 =====\n${json}`)

  const target = process.env['STUDY_BOARD_BENCH_OUT']
  if (!target) return
  try {
    writeFileSync(target, json, 'utf-8')
    console.info(`[bench] 已写入 ${target}`)
  } catch (error) {
    console.error('[bench] 报告写入失败：', error)
  }
}
