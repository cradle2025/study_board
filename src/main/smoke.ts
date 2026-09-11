import { BrowserWindow, app } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { context } from './context'
import { setUserDataOverride } from './paths'
import { encodePng } from './services/png'

/**
 * 冒烟 / 端到端自检。
 *
 * 只在环境变量 STUDY_BOARD_SMOKE=1 时启用，正常使用完全不会走到这里。
 *
 * 做了两件正经事：
 *  1. **隔离数据目录**：测试跑在系统临时目录里，绝不碰用户真实的学习数据；
 *  2. **真跑一遍完整链路**：主进程服务 → IPC → 渲染层 → 截图，
 *     这样在 CI 或没人盯着屏幕的时候也能确认「改完没坏」。
 *
 * 场景：
 *  - basic     只验证能起来（默认）
 *  - timetable 额外验证课程表：写入单元格、跑一次真实的图片导入链路、
 *              切到图片模式确认 sb-asset 协议与 CSP 都放行，最后截图
 */

export type SmokeScenario = 'basic' | 'timetable'

export function smokeEnabled(): boolean {
  return process.env['STUDY_BOARD_SMOKE'] === '1'
}

export function smokeScenario(): SmokeScenario {
  return process.env['STUDY_BOARD_SMOKE_SCENARIO'] === 'timetable' ? 'timetable' : 'basic'
}

/**
 * 只要处于任何自动化运行模式（冒烟或基准），就把数据目录挪到临时目录。
 * 必须在 app ready 之前调用。
 */
export function prepareIsolatedDataDir(): void {
  if (!smokeEnabled() && process.env['STUDY_BOARD_BENCH'] !== '1') return
  const dir = mkdtempSync(join(tmpdir(), 'study-board-run-'))
  setUserDataOverride(dir)
  try {
    app.setPath('userData', dir)
  } catch {
    /* 个别平台不允许覆盖，忽略即可——我们自己的数据已经隔离了 */
  }
  console.info(`[自动化] 使用临时数据目录：${dir}`)
}

/* ------------------------------------------------------------------ 造测试数据 */

/** 画一张有明显色块的图，方便截图里一眼看出图片链路通没通 */
function makeTestPng(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const band = Math.floor(y / Math.max(1, Math.floor(height / 6)))
      const on = (x + y) % 220 < 110
      rgba[i] = band % 2 === 0 ? 59 : 220
      rgba[i + 1] = on ? 110 : 190
      rgba[i + 2] = band % 2 === 0 ? 240 : 90
      rgba[i + 3] = 255
    }
  }
  return encodePng(rgba, width, height)
}

async function seedTimetable(): Promise<void> {
  const { timetable, settings } = context()

  settings.patch({ timetable: { periodCount: 11 } })

  timetable.setRows([
    { index: 1, start: '08:00', end: '08:45' },
    { index: 2, start: '08:55', end: '09:40' },
    { index: 3, start: '10:00', end: '10:45' },
    { index: 4, start: '10:55', end: '11:40' }
  ])

  timetable.setCell('1:0', {
    courseName: '高等数学 A',
    teacher: '张启明',
    location: '教三-201',
    duration: '45 分钟',
    remark: '带计算器'
  })
  timetable.setCell('1:1', {
    courseName: '大学英语',
    teacher: 'Li Na',
    location: '外语楼 B305',
    duration: '45 分钟',
    remark: ''
  })
  timetable.setCell('3:2', {
    courseName: '数据结构',
    teacher: '王海',
    location: '计算机楼 402',
    duration: '1-2 节连上',
    remark: '每周有上机作业'
  })

  // 走一遍真实的导入链路：PNG → nativeImage → 等比缩放 → 落盘 → 建索引
  const source = join(tmpdir(), `study-board-smoke-${Date.now()}.png`)
  writeFileSync(source, makeTestPng(1800, 1200))
  const result = await timetable.addImages([source])
  console.info(`[smoke] 图片导入：成功 ${result.added} 张，失败 ${result.errors.length} 张`)
  for (const message of result.errors) console.error(`[smoke] 导入失败：${message}`)
  if (result.added !== 1) throw new Error('图片导入链路自检失败')

  const content = timetable.get()
  const image = content.images[0]
  if (!image || image.width <= 0) throw new Error('图片落盘后尺寸信息缺失')
  console.info(
    `[smoke] 图片归一化结果：${image.width}×${image.height}，${Math.round(image.bytes / 1024)} KB`
  )
  if (image.width > 2400) throw new Error('图片没有被等比缩放')
}

/* ------------------------------------------------------------------ 渲染层自检 */

/**
 * 注意：`did-finish-load` 可能早于渲染层的异步 bootstrap 完成
 * （bootstrap 里有若干次 IPC 往返），所以探测脚本必须**轮询等元素出现**，
 * 不能一把 querySelector 抓不到就跳过——这正是最初版本踩过的坑。
 */
const PROBE_HELPERS = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (selector, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const el = document.querySelector(selector)
      if (el) return el
      if (Date.now() > deadline) return null
      await wait(100)
    }
  }
`

const BASIC_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const shell = await waitFor('study-board-app .sb-shell')
  return JSON.stringify({
    customElement: Boolean(document.querySelector('study-board-app')),
    mounted: Boolean(shell),
    bridge: typeof window.studyBoard === 'object'
  })
})()`

const TIMETABLE_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="timetable"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  const editor = await waitFor('input[name="tt-mode"]')
  if (!editor) return JSON.stringify({ error: '课程表编辑页未挂载' })
  await wait(300)

  const cells = document.querySelectorAll('.sb-timetable__cell').length
  const filled = document.querySelectorAll('.sb-ttcell__name').length
  const hasCourse = document.body.textContent.includes('高等数学 A')
  const hasTime = document.body.textContent.includes('08:00')
  const activeNav = document.querySelector('[data-route][aria-current="page"]')?.getAttribute('data-route') ?? 'none'

  // 走一遍「双击 → 填值 → 保存」，确认单格增量重绘这条路径真的把内容画出来了。
  // 整表重绘与单格重绘是两条代码路径，只测其中一条等于没测。
  const targetKey = '5:3'
  const target = document.querySelector('.sb-timetable__cell[data-key="' + targetKey + '"]')
  if (target) {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  }
  const nameInput = document.querySelector('.sb-tt-editor [data-field="courseName"]')
  const teacherInput = document.querySelector('.sb-tt-editor [data-field="teacher"]')
  const saveButton = document.querySelector('.sb-tt-editor [data-role="save"]')
  if (nameInput && teacherInput && saveButton) {
    nameInput.value = '编译原理'
    teacherInput.value = '周芷若'
    saveButton.click()
  }

  const painted = await waitFor('.sb-timetable__cell[data-key="' + targetKey + '"] .sb-ttcell__name')
  const paintedText = painted ? painted.textContent : ''
  const paintedMeta = document.querySelector(
    '.sb-timetable__cell[data-key="' + targetKey + '"] .sb-ttcell__meta'
  )
  const editOk = paintedText === '编译原理' && Boolean(paintedMeta && paintedMeta.textContent.includes('周芷若'))
  const filledAfterEdit = document.querySelectorAll('.sb-ttcell__name').length

  // 切到图片模式，确认自定义协议与 CSP 都放行（naturalWidth 只有真的加载成功才不为 0）
  const imageRadio = document.querySelector('input[name="tt-mode"][value="image"]')
  if (imageRadio) {
    imageRadio.checked = true
    imageRadio.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const shot = await waitFor('.sb-ttshot__view img')
  if (shot && !shot.complete) {
    await new Promise((resolve) => {
      shot.addEventListener('load', resolve, { once: true })
      shot.addEventListener('error', resolve, { once: true })
      setTimeout(resolve, 3000)
    })
  }
  const imageWidth = shot ? shot.naturalWidth : 0
  const shots = document.querySelectorAll('.sb-ttshot').length
  // 照片必须被约束在视口内（CSS 里是 max-height: 68vh）。
  // 只看 naturalWidth 是看不出布局问题的——图片解码成功但被拉成原始像素高，
  // 一样会把整页撑爆，所以这里连渲染尺寸一起断言。
  const shotHeight = shot ? shot.getBoundingClientRect().height : 0
  const imageFits = shotHeight > 0 && shotHeight <= window.innerHeight * 0.7

  return JSON.stringify({
    cells, filled, hasCourse, hasTime, shots, imageWidth, activeNav,
    paintedText, filledAfterEdit, shotHeight: Math.round(shotHeight),
    cellsOk: cells === 11 * 7,
    filledOk: filled === 3,
    navOk: activeNav === 'timetable',
    editOk,
    // 保存一格之后，填过的格子数应该只增加 1，而不是整表被重画成别的样子
    filledAfterEditOk: filledAfterEdit === 4,
    imageOk: imageWidth > 0,
    imageFitsOk: imageFits
  })
})()`

/* ------------------------------------------------------------------ 主流程 */

export function runSmokeTestIfRequested(win: BrowserWindow): void {
  if (!smokeEnabled()) return

  const scenario = smokeScenario()
  const probe = scenario === 'timetable' ? TIMETABLE_PROBE : BASIC_PROBE
  const timeoutMs = scenario === 'timetable' ? 30_000 : 20_000

  const timer = setTimeout(() => {
    console.error(`[smoke] 超时：渲染层 ${timeoutMs / 1000} 秒内未完成自检`)
    app.exit(1)
  }, timeoutMs)

  // 把渲染层的报错原样转出来，否则自检失败时只能靠猜
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: string; message?: string; lineNumber?: number; sourceId?: string }
    if (first && typeof first === 'object' && 'message' in first) {
      console.info(`[renderer:${first.level ?? '?'}] ${first.message} (${first.sourceId ?? ''}:${first.lineNumber ?? 0})`)
      return
    }
    const [, level, message, line, sourceId] = args as [unknown, number, string, number, string]
    console.info(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    clearTimeout(timer)
    console.error('[smoke] 渲染进程崩溃：', details.reason, details.exitCode)
    app.exit(1)
  })

  win.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(timer)
    console.error(`[smoke] 加载失败：${code} ${description}`)
    app.exit(1)
  })

  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(probe, true)
      .then(async (raw: unknown) => {
        clearTimeout(timer)
        const parsed = JSON.parse(String(raw)) as Record<string, unknown>
        console.info('[smoke] 渲染层自检：', raw)

        const passed =
          scenario === 'timetable'
            ? Boolean(
                parsed['navOk'] &&
                  parsed['hasCourse'] &&
                  parsed['cellsOk'] &&
                  parsed['filledOk'] &&
                  parsed['hasTime'] &&
                  parsed['editOk'] &&
                  parsed['filledAfterEditOk'] &&
                  parsed['imageOk'] &&
                  parsed['imageFitsOk']
              )
            : Boolean(parsed['customElement'] && parsed['mounted'] && parsed['bridge'])

        if (scenario === 'timetable') {
          // 自检结束时停在图片模式，先留一张图；再切回表格模式，留第二张
          await captureIfRequested(win, 'timetable-image.png')
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 const radio = document.querySelector('input[name="tt-mode"][value="table"]')
                 if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })) }
                 await wait(900)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'timetable-table.png')
        } else {
          await captureIfRequested(win, 'screenshot.png')
        }

        setTimeout(() => app.exit(passed ? 0 : 1), 200)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        console.error('[smoke] 自检脚本执行失败：', error)
        app.exit(1)
      })
  })
}

/**
 * 数据准备。必须在窗口创建之前 await 完成，否则渲染层可能在数据写入前就读完了。
 */
export async function prepareSmokeDataIfRequested(): Promise<void> {
  if (!smokeEnabled()) return
  if (smokeScenario() !== 'timetable') return
  await seedTimetable()
}

/** 截图落到 STUDY_BOARD_SMOKE_SHOT 所在目录下 */
async function captureIfRequested(win: BrowserWindow, fileName: string): Promise<void> {
  const base = process.env['STUDY_BOARD_SMOKE_SHOT']
  if (!base) return
  const target = join(dirname(base), fileName)
  try {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const image = await win.webContents.capturePage()
    writeFileSync(target, image.toPNG())
    console.info(`[smoke] 截图已保存：${target}`)
  } catch (error) {
    console.error('[smoke] 截图失败：', error)
  }
}
