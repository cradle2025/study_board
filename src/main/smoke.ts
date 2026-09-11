import { BrowserWindow, app } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { EXPORT_EXTENSIONS } from '@shared/limits'
import type { ExportFormat } from '@shared/types'

import { context } from './context'
import { ensureDir, setUserDataOverride, tempDir } from './paths'
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
 *  - portal    额外验证网站门户：内置站点、图标走 sb-asset、增删改隐藏全链路
 *  - cards     额外验证课程卡片：翻转、从课表带过课程、建卡片自动建笔记、
 *              「记笔记」跳转、笔记落盘成 Obsidian 认得的文件
 *  - notes     额外验证双模式编辑器：CodeMirror 与 TipTap 的按需加载、
 *              工具栏命令、md ↔ 富文本来回切换、切换前自动备份
 *  - sync      额外验证笔记库文件监听：外部新增 / 改动 / 删除能不能被认出来、
 *              自己写盘会不会造成事件回环、外部改动撞上未保存内容时会不会先问一句
 *  - export    额外验证笔记导出：导出菜单挂得上、md / html / docx / pdf
 *              四种产物都能落到磁盘，而且**内容对得上**
 *
 * 门户场景**不测图标抓取**：那需要真实网络，在无网的 CI 里会让自检变成随机失败。
 * 图标文件由本文件直接造好写进图标目录，测的是「图标能不能显示出来」这条链路，
 * 而不是「能不能从外网抓下来」——后者本来就该由人点一下按钮确认。
 *
 * sync 场景也刻意**不测「换个真编辑器」**：这里直接往磁盘上写文件，
 * 那正是任何外部程序最终做的事——Obsidian 保存、VS Code 保存、记事本保存，
 * 落到文件系统层面都是同一件事。测 IPC 之外那条真实路径才有意义。
 *
 * export 场景**不弹保存对话框**：对话框是系统的，自动化点不了它。
 * 改为直接给 `targetPath`，落在一个临时目录里——这正是对话框之后
 * 主进程会走的那条写入路径，同时让「产物到底对不对」可以被硬断言。
 */

export type SmokeScenario = 'basic' | 'timetable' | 'portal' | 'cards' | 'notes' | 'sync' | 'export'

export function smokeEnabled(): boolean {
  return process.env['STUDY_BOARD_SMOKE'] === '1'
}

export function smokeScenario(): SmokeScenario {
  const value = process.env['STUDY_BOARD_SMOKE_SCENARIO']
  if (value === 'timetable') return 'timetable'
  if (value === 'portal') return 'portal'
  if (value === 'cards') return 'cards'
  if (value === 'notes') return 'notes'
  if (value === 'sync') return 'sync'
  if (value === 'export') return 'export'
  return 'basic'
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

/**
 * 卡片测试数据。
 *
 * 同时要种课表：需求里「课程名和老师从课表自动带过来」这条链路，
 * 没有课表数据就根本测不到。
 */
function seedCards(): void {
  const { timetable, cards, notes } = context()

  timetable.setCell('1:0', {
    courseName: '高等数学 A',
    teacher: '张启明',
    location: '教三-201',
    duration: '45 分钟',
    remark: ''
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
    remark: ''
  })

  // 只种两张：第三张留给探针从课表带过来新建。
  // 如果连「数据结构」也种上，探针新建时会因为重名变成「数据结构_王海 (2)」，
  // 断言就得跟着变复杂——测试数据不该给测试本身制造歧义。
  const maths = cards.upsert({
    courseName: '高等数学 A',
    teacher: '张启明',
    score: '92',
    difficulty: 4,
    mastery: 3,
    gradingPolicy: '平时 30% + 期末 70%',
    outline: '极限 → 导数 → 积分'
  })
  const english = cards.upsert({
    courseName: '大学英语',
    teacher: 'Li Na',
    score: 'A',
    difficulty: 2,
    mastery: 4
  })
  // 故意放一个超长课程名：卡片高度是写死的，这种名字会不会把内容顶出去，
  // 只有真的摆一张出来才知道。短名字的样本测不到这个
  const longName = cards.upsert({
    courseName: '毛泽东思想和中国特色社会主义理论体系概论',
    teacher: '李建国',
    score: '良好',
    difficulty: 3,
    mastery: 2,
    gradingPolicy: '论文 40% + 期末 60%'
  })

  // 卡片与笔记的关联在真实流程里由 IPC 层建立，这里手工补上等价的结果
  for (const card of [maths, english, longName]) {
    const note = notes.create(`${card.courseName}_${card.teacher}`)
    cards.linkNote(card.id, note.id)
  }
}

/**
 * 笔记编辑器测试数据。
 *
 * 内容是刻意挑的：标题、加粗、行内代码、列表各来一个——
 * 这些正好是「Markdown 转 HTML 再转回 Markdown」这一圈里最容易走样的几种。
 */
function seedNotes(): void {
  const { notes } = context()
  notes.create(
    '编辑器自检',
    [
      '# 一级标题',
      '',
      '正文段落，带 **加粗** 和 `行内代码`。',
      '',
      '- 列表项一',
      '- 列表项二',
      ''
    ].join('\n')
  )
}

/**
 * 门户测试数据：给内置站点塞一张真图标。
 *
 * 目的是验证「图标目录 → sb-asset 协议 → CSP → <img> 显示」这条链路，
 * 这一步跟「从外网抓」是两件事，只有前者适合放进自动化自检。
 */
function seedPortal(): void {
  const { portal } = context()
  const fileName = portal.writeIcon(makeTestPng(64, 64))
  portal.setIcon('builtin-mooc', fileName)
}

/**
 * 导出测试用的标记文本。
 *
 * 故意做成一眼能认出来的怪字符串：断言是「产物里包含它」，
 * 而这个串不可能被格式转换自己造出来。
 */
const EXPORT_MARKER = '导出标记 MK-7f3a'
const EXPORT_NOTE_TITLE = '导出自检'

/**
 * 导出测试数据。
 *
 * 正文把四种格式各自最容易走样的东西各放一份：标题（docx 里得是真正的
 * 标题样式而不是加粗大字）、行内代码与代码块（等宽 + 底纹）、
 * 表格（docx 里最复杂的结构）、引用、列表、分隔线。
 * 只放一段纯文本的话，导出一份只有一段话的文档也能全绿。
 */
function seedExport(): void {
  const { notes } = context()
  notes.create(
    EXPORT_NOTE_TITLE,
    [
      '# 一级标题',
      '',
      `正文段落，带 **加粗**、*斜体* 和 \`行内代码\`，还有 ${EXPORT_MARKER}。`,
      '',
      '## 二级标题',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '1. 有序项一',
      '2. 有序项二',
      '',
      '> 引用一段话',
      '',
      '```js',
      'const answer = 42',
      '```',
      '',
      '| 科目 | 分数 |',
      '| --- | --- |',
      '| 高等数学 | 92 |',
      '',
      '---',
      '',
      '最后一段。',
      ''
    ].join('\n')
  )
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
  const waitForCount = async (selector, count, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      if (document.querySelectorAll(selector).length === count) return true
      if (Date.now() > deadline) return false
      await wait(100)
    }
  }
  const waitForGone = async (text, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      if (!document.body.textContent.includes(text)) return true
      if (Date.now() > deadline) return false
      await wait(100)
    }
  }
  // 元素在不在不代表数据到了：输入框是页面搭好就存在的，值要等异步加载才填上
  const waitForValue = async (selector, value, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const el = document.querySelector(selector)
      if (el && el.value === value) return true
      if (Date.now() > deadline) return false
      await wait(100)
    }
  }
  const waitForText = async (selector, text, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const el = document.querySelector(selector)
      if (el && el.textContent.includes(text)) return true
      if (Date.now() > deadline) return false
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

const NOTES_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="notes"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  const listed = await waitForCount('.sb-notes__item', 1)
  if (!listed) return JSON.stringify({ error: '笔记列表为空' })
  document.querySelector('.sb-notes__item').click()

  // 编辑器是动态 import 进来的：这里等它真的挂上，顺便验证
  // 「按需加载的 chunk 在 file:// + CSP 下能不能加载成功」
  const cmReady = await waitFor('.cm-editor', 20000)
  if (!cmReady) return JSON.stringify({ error: 'Markdown 编辑器没挂上' })

  // 标题输入框被填上，才说明笔记内容真的读出来并灌进编辑器了
  const loaded = await waitForValue('[data-role="title"]', '编辑器自检')
  if (!loaded) return JSON.stringify({ error: '笔记内容未载入' })
  await wait(300)

  const initialText = document.querySelector('.cm-content').textContent
  const initialOk = initialText.includes('一级标题') && initialText.includes('列表项一')

  // —— 把光标移到文档末尾，再用工具栏插一条分隔线。
  // 从外面模拟键盘输入到 contenteditable 里太脆弱，走工具栏命令既可靠，
  // 又顺带把「点了按钮到底生不生效」测了；插在末尾则不会破坏原有结构
  const content = document.querySelector('.cm-content')
  const cursorRange = document.createRange()
  cursorRange.selectNodeContents(content)
  cursorRange.collapse(false)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(cursorRange)
  content.focus()
  // 给 CodeMirror 一点时间把 DOM 选区同步成内部光标位置，
  // 不然它还以为光标在文档开头，内容就插到最前面去了
  await wait(250)

  const hrButton = document.querySelector('.sb-editorbar [data-command="hr"]')
  if (!hrButton) return JSON.stringify({ error: '工具栏没渲染' })
  hrButton.click()
  const appended = await waitForText('[data-role="status"]', '已保存', 8000)
  const textAfterHr = document.querySelector('.cm-content').textContent
  const hrOk = textAfterHr.includes('---')
  // 插在末尾 ⇒ 第一行还是原来那个标题。这是「光标真的移到末尾了」的证据
  const firstLine = document.querySelector('.cm-line').textContent
  const h1Kept = firstLine.includes('# 一级标题')

  // 下划线在 Markdown 模式下该是禁用的——Markdown 表达不了它，
  // 与其假装支持再在存盘时丢掉，不如直接不给点
  const underlineDisabled = document.querySelector(
    '.sb-editorbar [data-command="underline"]'
  ).disabled

  // —— 切到富文本：会先弹确认框（提示格式转换可能退化），确认后还要备份
  document.querySelector('[data-mode="richtext"]').click()
  const modal = await waitFor('.sb-modal [data-role="confirm"]')
  if (!modal) return JSON.stringify({ error: '切模式没有弹出确认框' })
  modal.click()

  const rtReady = await waitFor('.sb-rt__body', 20000)
  if (!rtReady) return JSON.stringify({ error: '富文本编辑器没挂上' })
  await wait(400)

  const richHtml = document.querySelector('.sb-rt__body').innerHTML
  // 转换结果的检验点：标题变 h1、加粗变 strong、行内代码变 code、列表变 ul
  const convertOk =
    richHtml.includes('<h1') &&
    richHtml.includes('<strong>') &&
    richHtml.includes('<code>') &&
    richHtml.includes('<ul>')

  // 富文本模式下，下划线该是可用的（这正是富文本存在的意义）
  const underlineEnabled = !document.querySelector(
    '.sb-editorbar [data-command="underline"]'
  ).disabled

  // —— 在富文本里插一张表格，再切回 Markdown 看它有没有变成 GFM 表格语法
  document.querySelector('.sb-editorbar [data-command="table"]').click()
  const tableMade = await waitFor('.sb-rt__body table')
  const savedAfterTable = await waitForText('[data-role="status"]', '已保存', 8000)

  // 切回 Markdown 不需要确认（往富文本切才需要，因为那一步才开始可能丢格式）
  document.querySelector('[data-mode="markdown"]').click()
  const backToCm = await waitFor('.cm-editor', 20000)
  await wait(500)
  const backText = document.querySelector('.cm-content').textContent
  // GFM 表格的样子：至少要有一行 | 分隔符
  const roundTripOk = backText.includes('|') && backText.includes('一级标题')
  const backHead = backText.slice(0, 160)
  const afterHrHead = textAfterHr.slice(0, 160)

  return JSON.stringify({
    initialOk, hrOk, h1Kept, appended, underlineDisabled, convertOk,
    afterHrHead, backHead,
    underlineEnabled, tableMade: Boolean(tableMade), savedAfterTable, roundTripOk,
    richTags: ['h1', 'strong', 'code', 'ul'].filter((t) => richHtml.includes('<' + t)),
    editorOk: initialOk && hrOk && h1Kept && appended,
    toolbarOk: underlineDisabled && underlineEnabled,
    convertCheck: convertOk,
    tableOk: Boolean(tableMade) && savedAfterTable,
    roundTrip: backToCm && roundTripOk
  })
})()`

/* --------------------------------------------------- 文件监听（双向同步） */

/**
 * 「外部程序」写入的那篇笔记。
 *
 * id 写死是有意的：下一步要让一张卡片指着它，好验证「文件被外部删掉之后
 * 卡片会不会自动解开关联」。id 写在文件里，认领时就会被原样捡回来。
 */
const SYNC_EXTERNAL_FILE = '外部新增的笔记.md'
const SYNC_EXTERNAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
/** 种子那篇被外部改名之后的名字 */
const SYNC_RENAMED_FILE = '改过名的笔记.md'

const EXTERNAL_APPEND_1 = '外部追加的第一段。'
const EXTERNAL_APPEND_2 = '外部追加的第二段。'
const EXTERNAL_APPEND_3 = '外部追加的第三段。'

/** 打开那篇笔记，并验明「自己写盘不会引起事件回环」 */
/**
 * 导出探针。
 *
 * 一次测两件事：
 *  1. **界面上的导出菜单**——点得开、四种格式齐全、Esc 关得掉；
 *  2. **四种格式真能导出**——明确给 targetPath，绕开系统保存对话框
 *     （对话框是操作系统的，自动化点不了）。
 *
 * 产物本身对不对交给主进程去磁盘上验，这里只把路径带回来。
 * 收尾刻意把菜单重新打开，好让截图里能看到它长什么样。
 */
function exportProbe(dir: string): string {
  return `(async () => {
  ${PROBE_HELPERS}
  const dir = ${JSON.stringify(dir)}
  const base = ${JSON.stringify(EXPORT_NOTE_TITLE)}
  const want = ['md', 'html', 'docx', 'pdf']

  const nav = await waitFor('[data-route="notes"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  const listed = await window.studyBoard.notes.list()
  const note = listed.ok ? listed.data.find((n) => n.title === base) : null
  if (!note) return JSON.stringify({ error: '列表里找不到那篇导出自检笔记' })

  const item = await waitFor('[data-role="list"] [data-note="' + note.id + '"]')
  if (!item) return JSON.stringify({ error: '笔记列表里没有那一篇' })
  item.click()
  // 等编辑器真的挂上，别在 open() 还没走完时就去点导出
  await waitFor('[data-role="stage"] .cm-editor', 8000)

  const trigger = await waitFor('[data-action="export"]')
  if (!trigger) return JSON.stringify({ error: '找不到导出按钮' })
  trigger.click()

  const first = await waitFor('.sb-menu [data-format]', 5000)
  if (!first) return JSON.stringify({ error: '导出菜单没弹出来' })

  const items = Array.from(document.querySelectorAll('.sb-menu [data-format]'))
  const formats = items.map((el) => el.getAttribute('data-format'))
  const labels = items.map((el) => (el.textContent || '').trim())

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  let closed = false
  for (let i = 0; i < 40; i += 1) {
    if (!document.querySelector('.sb-menu')) { closed = true; break }
    await wait(50)
  }

  const results = {}
  for (const format of want) {
    const res = await window.studyBoard.exporter.note({
      noteId: note.id,
      format: format,
      targetPath: dir + '/' + base + '.' + format
    })
    results[format] = res.ok ? (res.data.filePath || '') : ('ERR: ' + res.error)
  }

  trigger.click()
  await waitFor('.sb-menu [data-format]', 5000)

  return JSON.stringify({
    menuOk: formats.length === 4 && want.every((f) => formats.indexOf(f) >= 0) && closed,
    formats: formats,
    labels: labels,
    closed: closed,
    results: results,
    noteId: note.id
  })
})()`
}

const SYNC_OPEN_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="notes"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  // 顺手把收到的事件记下来：出问题时这几行比任何猜测都管用
  window.__syncEvents = []
  window.studyBoard.events.onLibraryChanged((p) => {
    window.__syncEvents.push(p.kind + ' ' + p.fileName)
  })

  const listed = await waitForCount('.sb-notes__item', 1)
  if (!listed) return JSON.stringify({ error: '笔记列表不是 1 条' })
  document.querySelector('.sb-notes__item').click()

  const cmReady = await waitFor('.cm-editor', 20000)
  const loaded = await waitForValue('[data-role="title"]', '编辑器自检')
  if (!cmReady || !loaded) return JSON.stringify({ error: '笔记没打开' })
  await wait(300)

  // —— 自己写一次盘。自动保存每次落盘都会产生文件事件，没过滤掉的话
  // 用户每打一个字编辑器就会被重建一次。编辑器是不是同一个 DOM 节点，
  // 是这件事最直接、也最不容易假装过去的证据，所以留个引用到后面比
  window.__syncEditorRef = document.querySelector('.cm-editor')
  const hr = document.querySelector('.sb-editorbar [data-command="hr"]')
  if (!hr) return JSON.stringify({ error: '工具栏没渲染' })
  hr.click()
  const saved = await waitForText('[data-role="status"]', '已保存', 8000)
  await wait(2000)

  const same = window.__syncEditorRef === document.querySelector('.cm-editor')
  return JSON.stringify({
    opened: true, saved, noEcho: same,
    selfEvents: window.__syncEvents.slice()
  })
})()`

/** 外部新增一篇：列表要自己长出来 */
const SYNC_ADD_PROBE = `(async () => {
  ${PROBE_HELPERS}
  await waitForCount('.sb-notes__item', 2, 12000)
  // 元素取不到时不要把探针本身弄崩——那样只会得到一句「执行失败」，
  // 什么线索都没有，不如把现场描述清楚
  const list = document.querySelector('[data-role="list"]')
  const listed = list ? list.textContent.includes('外部新增的笔记') : false
  const count = document.querySelectorAll('.sb-notes__item').length
  return JSON.stringify({
    count, listed, hasList: Boolean(list),
    addOk: listed && count === 2,
    events: window.__syncEvents.slice()
  })
})()`

/** 外部改了正在编辑的这篇：编辑器要整个换成磁盘上的新版 */
const SYNC_CHANGE_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const shown = await waitForText('.cm-content', '外部追加的第一段', 12000)
  const refreshed = window.__syncEditorRef !== document.querySelector('.cm-editor')
  const title = document.querySelector('[data-role="title"]').value
  return JSON.stringify({ shown, refreshed, title, changeOk: shown && refreshed && title === '编辑器自检' })
})()`

/** 外部删掉那篇：列表要收起；顺便把编辑器置脏，好验下一步的冲突追问 */
const SYNC_UNLINK_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const gone = await waitForGone('外部新增的笔记', 12000)
  const count = document.querySelectorAll('.sb-notes__item').length

  // 改标题不会触发自动保存（只有点「重命名」才落盘），所以这个「脏」
  // 会稳稳留到下一步，不会半路被自动保存清掉
  const input = document.querySelector('[data-role="title"]')
  input.value = '编辑器自检（改了还没保存）'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const dirty = document.querySelector('[data-role="status"]').textContent.includes('标题待保存')

  return JSON.stringify({ gone, count, dirty, unlinkOk: gone && count === 1 && dirty })
})()`

/** 有未保存内容时撞上外部改动：必须先问一句；选「保留我的内容」则编辑器不动 */
const SYNC_CONFLICT_KEEP_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const confirm = await waitFor('.sb-modal [data-role="confirm"]', 12000)
  if (!confirm) return JSON.stringify({ error: '外部改动没有追问' })
  const asked = document.querySelector('.sb-modal__message').textContent.includes('还没有保存')
  document.querySelector('.sb-modal [data-role="cancel"]').click()
  await wait(700)

  const body = document.querySelector('.cm-content').textContent
  const status = document.querySelector('[data-role="status"]').textContent
  const kept = !body.includes('外部追加的第二段')
  return JSON.stringify({ asked, kept, status, keepOk: asked && kept })
})()`

/** 同样的冲突，这次选「载入磁盘版本」：编辑器要换成磁盘上的内容 */
const SYNC_CONFLICT_LOAD_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const confirm = await waitFor('.sb-modal [data-role="confirm"]', 12000)
  if (!confirm) return JSON.stringify({ error: '第二次外部改动没有追问' })
  confirm.click()

  const shown = await waitForText('.cm-content', '外部追加的第三段', 12000)
  const title = document.querySelector('[data-role="title"]').value
  const status = document.querySelector('[data-role="status"]').textContent
  return JSON.stringify({ shown, title, status, loadOk: shown && title === '编辑器自检' })
})()`

/**
 * 外部改名。
 *
 * 这是整条链路上最容易出事的一种：如果对账把「改名」当成「删一篇 + 加一篇」，
 * 卡片与笔记的关联就会在用户改个文件名的时候无声地断掉。
 * 所以这里同时验三件事：列表里的标题跟着换、正在编辑的那篇没被弄丢、
 * 卡片仍然指着同一个 id。
 */
const SYNC_RENAME_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const listed = await waitForText('[data-role="list"]', '改过名的笔记', 12000)
  const title = document.querySelector('[data-role="title"]').value
  const body = document.querySelector('.cm-content').textContent
  const oldGone = !document.querySelector('[data-role="list"]').textContent.includes('编辑器自检')
  const keptBody = body.includes('外部追加的第三段')
  return JSON.stringify({
    listed, title, keptBody, oldGone,
    renameOk: listed && title === '改过名的笔记' && keptBody && oldGone
  })
})()`

const CARDS_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="study"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()
  await waitFor('[data-role="cards"]')

  // 先等课表数据到了再开——「从课表带过来」这个下拉是靠它填的。
  // 直接看下拉有没有选项，等于等语义状态而不是等元素（老坑了）
  const cardCount = await waitForCount('.sb-itemcard', 3)
  if (!cardCount) return JSON.stringify({ error: '卡片没渲染出来' })

  // —— 翻转：单击应该把卡片翻到背面，再点一次翻回来
  const first = document.querySelector('.sb-itemcard')
  const flipTarget = first.querySelector('[data-act="flip"]')
  flipTarget.click()
  await wait(420)
  const flipped = first.classList.contains('sb-itemcard--flipped')
  // 背面必须真的有内容，不能只是转了个空壳
  const backText = first.querySelector('.sb-itemcard__face--back').textContent.trim().length
  flipTarget.click()
  await wait(420)
  const flippedBack = !first.classList.contains('sb-itemcard--flipped')

  // 正面该显示的东西
  const frontFace = first.querySelector('.sb-itemcard__face--front')
  const frontText = frontFace.textContent
  const frontOk = frontText.includes('高等数学 A') && frontText.includes('张启明')

  // —— 排版体检：这些东西"看着挤不挤"没法自动判断，
  // 但"字号够不够大、内容溢没溢出、留白有多宽"是可以量的
  const nameEl = first.querySelector('.sb-course__name')
  const teacherEl = first.querySelector('.sb-course__teacher')
  const ratingsEl = first.querySelector('.sb-course__ratings')
  const faceRect = frontFace.getBoundingClientRect()
  const cardRect = first.getBoundingClientRect()
  const nameFont = nameEl ? parseFloat(getComputedStyle(nameEl).fontSize) : 0
  const teacherFont = teacherEl ? parseFloat(getComputedStyle(teacherEl).fontSize) : 0
  const bodyFont = ratingsEl
    ? parseFloat(getComputedStyle(first.querySelector('.sb-course__rating-label') || ratingsEl).fontSize)
    : 0
  // 正面内容不能溢出：写死高度之后，多出来的字会被切掉
  const faceOverflow = frontFace.scrollHeight > frontFace.clientHeight + 1
  // 名字块底边到分隔线之间还剩多少空白——太少显得挤，太多显得空
  const gapBeforeRule = ratingsEl
    ? Math.round(ratingsEl.getBoundingClientRect().top -
        (teacherEl ? teacherEl.getBoundingClientRect().bottom : faceRect.top))
    : 0
  const scoreBadge = first.querySelector('.sb-course__score')
  const scoreFont = scoreBadge ? parseFloat(getComputedStyle(scoreBadge).fontSize) : 0

  // 超长课程名的那张：名字必须被夹到两行且不能把内容顶出卡片。
  // 中文课名动辄十几个字，这是真实用户一定会碰到的情形，不是边角案例
  const longCard = document.querySelectorAll('.sb-itemcard')[2]
  const longFace = longCard.querySelector('.sb-itemcard__face--front')
  const longNameEl = longCard.querySelector('.sb-course__name')
  const longNameHeight = longNameEl.getBoundingClientRect().height
  const longLineHeight = parseFloat(getComputedStyle(longNameEl).lineHeight) || 23
  const longNameLines = Math.round(longNameHeight / longLineHeight)
  const longOverflow = longFace.scrollHeight > longFace.clientHeight + 1
  const longNameOk = longNameLines === 2 && !longOverflow

  // 强调色当文字用的时候，必须走 --color-accent-text 那一档：
  // 直接用主色在柔和底上对比度只有 3.9:1（浅色）/ 2.8:1（深色），读起来费劲
  const accentText = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-accent-text')
    .trim()
  const badgeColor = scoreBadge ? getComputedStyle(scoreBadge).color : ''
  // 用 split/join 而不是正则：探针整段是模板字符串，
  // 正则里的 \s 会被当成转义吃掉，变成「去掉所有字母 s」这种鬼东西
  const contrastOk = badgeColor.split(' ').join('') === 'rgb(47,92,214)'
  // 名字块与分隔线之间的留白只设下限：课程名一行还是两行本来就差 23px，
  // 想把两边都卡进一个窄区间是不可能的。只要不挤就行
  const typoOk =
    nameFont >= 16 &&
    teacherFont >= 12.5 &&
    bodyFont >= 12 &&
    scoreFont >= 12.5 &&
    !faceOverflow &&
    cardRect.width >= 260 &&
    gapBeforeRule >= 10

  // —— 新建卡片：课程名与老师从课表带过来，不再手打一遍
  document.querySelector('[data-action="add"]').click()
  const picker = await waitFor('.sb-modal__card--form [data-field="picker"]')
  const nameInput = document.querySelector('.sb-modal__card--form [data-field="courseName"]')
  const teacherInput = document.querySelector('.sb-modal__card--form [data-field="teacher"]')
  const scoreInput = document.querySelector('.sb-modal__card--form [data-field="score"]')
  const saveBtn = document.querySelector('.sb-modal__card--form [data-role="save"]')
  if (!picker || !nameInput || !teacherInput || !saveBtn) {
    return JSON.stringify({ error: '卡片表单未挂载' })
  }
  const options = picker.querySelectorAll('option').length
  // 选项 = "手动填写" + 课表里去重后的课程数（种子里是 3 门）
  const pickerOk = options === 4
  picker.value = '2'
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  const carriedName = nameInput.value
  const carriedTeacher = teacherInput.value
  if (scoreInput) scoreInput.value = 'A'
  saveBtn.click()

  const addedInTime = await waitForCount('.sb-itemcard', 4)
  const addedText = document.body.textContent.includes(carriedName)
  const carriedOk = carriedName.length > 0 && carriedTeacher.length > 0

  // —— 切到笔记页：卡片应该已经自动建好了同名笔记
  document.querySelector('[data-route="notes"]').click()
  await waitFor('[data-role="list"]')
  const expectedTitle = carriedTeacher ? carriedName + '_' + carriedTeacher : carriedName
  const listItems = await waitForCount('.sb-notes__item', 4)
  // 精确比对标题那一行，不能用整块的 includes——
  // 「A_老师」和「A_老师 (2)」互相包含，模糊匹配会挑错人
  const titles = Array.from(document.querySelectorAll('.sb-notes__item-title')).map((el) =>
    el.textContent.trim()
  )
  const autoNoteOk = titles.indexOf(expectedTitle) >= 0

  // 打开那篇自动建的笔记，写点东西并等自动保存落盘
  const target = Array.from(document.querySelectorAll('.sb-notes__item'))
    .find((el) => el.querySelector('.sb-notes__item-title').textContent.trim() === expectedTitle)
  let typedOk = false
  let editorMounted = false
  if (target) {
    target.click()
    // 编辑器是动态加载的，得等它挂上；标题被填上才说明内容真的读出来了
    editorMounted = Boolean(await waitFor('.cm-editor', 20000))
    const loaded = await waitForValue('[data-role="title"]', expectedTitle)
    if (editorMounted && loaded) {
      // 用工具栏插一张表：既证明编辑器能用，又给磁盘校验留了个好认的记号
      const tableButton = document.querySelector('.sb-editorbar [data-command="table"]')
      if (tableButton) {
        tableButton.click()
        typedOk = await waitForText('[data-role="status"]', '已保存', 8000)
      }
    }
  }

  // —— 从卡片点「记笔记」应该跳到笔记页并定位到那一篇。
  // 要挑**新建的那张**卡片（它在最后），否则点到的是别的课，测了个寂寞
  document.querySelector('[data-route="study"]').click()
  await waitForCount('.sb-itemcard', 4)
  const allCards = Array.from(document.querySelectorAll('.sb-itemcard'))
  const noteBtn = allCards[allCards.length - 1]
  if (noteBtn) noteBtn.querySelector('[data-act="note"]').click()
  await waitFor('[data-role="pane"]:not([hidden])')
  const jumpedTitle = document.querySelector('[data-role="title"]').value
  const jumpOk = jumpedTitle === expectedTitle

  return JSON.stringify({
    flipped, flippedBack, backText, frontOk, options, pickerOk,
    carriedName, carriedTeacher, carriedOk, addedInTime, addedText,
    listItems, autoNoteOk, typedOk, editorMounted, jumpedTitle, jumpOk,
    nameFont, teacherFont, bodyFont, scoreFont, gapBeforeRule, faceOverflow, typoOk,
    cardW: Math.round(cardRect.width), cardH: Math.round(cardRect.height),
    longNameLines, longOverflow, longNameOk, accentText, badgeColor, contrastOk,
    flipOk: flipped && flippedBack && backText > 0,
    addOk: pickerOk && carriedOk && addedInTime && addedText,
    noteOk: listItems && autoNoteOk && typedOk
  })
})()`

const PORTAL_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="portal"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  // 注意：只能等「站点都画出来了」，不能只等容器出现——
  // 容器是先建好、数据后到的，等容器等于什么都没等（课表探针踩过同样的坑）
  const renderedInTime = await waitForCount('.sb-portal__item', 3)
  if (!renderedInTime) return JSON.stringify({ error: '内置站点未渲染' })

  const builtins = document.querySelectorAll('.sb-portal__item').length
  const hasMooc = document.body.textContent.includes('中国大学 MOOC')
  const hasBilibili = document.body.textContent.includes('哔哩哔哩')

  // 图标走的是 sb-asset://icon/<file>，naturalWidth 只有真的加载成功才不为 0。
  // 这一步同时验证了图标目录在资源桶里、自定义协议注册成功、CSP 放行了这个协议。
  const icon = document.querySelector('.sb-portal__img')
  if (icon && !icon.complete) {
    await new Promise((resolve) => {
      icon.addEventListener('load', resolve, { once: true })
      icon.addEventListener('error', resolve, { once: true })
      setTimeout(resolve, 3000)
    })
  }
  const iconWidth = icon ? icon.naturalWidth : 0
  const letters = document.querySelectorAll('.sb-portal__letter').length

  // 光看 DOM 结构看不出布局塌掉：格子必须真的有尺寸，
  // 编辑态的操作条也必须真的占位（曾有过 flex 写错、整条被压成 0 高度的情况）
  const firstTile = document.querySelector('.sb-portal__item')
  const tileRect = firstTile ? firstTile.getBoundingClientRect() : { width: 0, height: 0 }
  const actions = firstTile ? firstTile.querySelector('.sb-portal__actions') : null
  const actionsHeight = actions ? actions.getBoundingClientRect().height : 0
  const layoutOk = tileRect.width >= 100 && tileRect.height >= 60 && actionsHeight > 0

  // —— 新增：走真实的表单链路（填表 → 保存 → 列表刷新）
  document.querySelector('[data-action="add"]').click()
  const nameInput = await waitFor('.sb-modal__card--form [data-field="name"]')
  const urlInput = document.querySelector('.sb-modal__card--form [data-field="url"]')
  const iconCheck = document.querySelector('.sb-modal__card--form [data-field="fetchIcon"]')
  const saveBtn = document.querySelector('.sb-modal__card--form [data-role="save"]')
  if (!nameInput || !urlInput || !saveBtn) return JSON.stringify({ error: '添加表单未挂载' })
  // 关掉「抓取图标」：自检环境可能没有网络，不能让这一步变成随机失败
  if (iconCheck) iconCheck.checked = false
  nameInput.value = '测试站点'
  urlInput.value = 'example.com'
  saveBtn.click()

  const addedInTime = await waitForCount('.sb-portal__item', 4)
  const addedText = document.body.textContent.includes('测试站点')
  const addedHost = document.body.textContent.includes('example.com')
  // 网址没带协议，应该被自动补成 https
  const lastTile = document.querySelectorAll('.sb-portal__item')[3]
  const addedHref = lastTile ? lastTile.querySelector('[data-act="open"]').getAttribute('title') : ''
  const urlOk = addedHref === 'https://example.com/'

  // —— 删除：新增的站点排在最后，点它的 ✕
  if (lastTile) lastTile.querySelector('[data-act="remove"]').click()
  const removedInTime = await waitForCount('.sb-portal__item', 3)
  const removedText = await waitForGone('测试站点')

  // —— 隐藏内置站点：内置的删不掉，只能隐藏，隐藏后要能从概览页看不出来。
  // 刻意挑第二个（B站）而不是第一个：第一个带着图标，留着它才能验证
  // 「首页的快捷启动也能把图标显示出来」
  const target = document.querySelectorAll('.sb-portal__item')[1]
  if (target) target.querySelector('[data-act="hide"]').click()
  await waitFor('.sb-portal__item--hidden')
  const hiddenCount = document.querySelectorAll('.sb-portal__item--hidden').length
  // 内置站点的删除按钮应该是禁用的
  const removeDisabled = target ? target.querySelector('[data-act="remove"]').disabled : false

  // —— 概览页复查：隐藏的那个不该出现在首页快捷启动里
  document.querySelector('[data-route="home"]').click()
  await waitFor('[data-role="portal-slot"]')
  const homeTiles = await waitForCount('[data-role="portal-slot"] .sb-portal__item', 2)
  const homeIcons = document.querySelectorAll('[data-role="portal-slot"] .sb-portal__img').length

  return JSON.stringify({
    builtins, hasMooc, hasBilibili, iconWidth, letters,
    addedInTime, addedText, addedHost, urlOk, addedHref,
    removedInTime, removedText, hiddenCount, removeDisabled, homeTiles, homeIcons,
    renderedInTime, tileW: Math.round(tileRect.width), tileH: Math.round(tileRect.height),
    actionsHeight: Math.round(actionsHeight),
    builtinsOk: builtins === 3 && hasMooc && hasBilibili,
    layoutOk,
    // 3 个内置站点里 1 个被塞了图标，其余 2 个回退到色块首字
    iconOk: iconWidth > 0 && letters === 2,
    addOk: addedInTime && addedText && addedHost && urlOk,
    deleteOk: removedInTime && removedText,
    hideOk: hiddenCount === 1 && removeDisabled,
    homeOk: homeTiles && homeIcons === 1
  })
})()`

/* ------------------------------------------------------------------ 主流程 */

export function runSmokeTestIfRequested(win: BrowserWindow): void {
  if (!smokeEnabled()) return

  const scenario = smokeScenario()

  // 导出场景要把四种产物写到一个**我们能去检查**的目录里。
  // 放 tempDir 下面而不是笔记库里面：笔记库里多出来的文件会参与对账，
  // 断言时容易把「导出的产物」和「笔记」混在一起看
  const exportDir =
    scenario === 'export'
      ? ensureDir(join(tempDir(context().settings.get().portableMode), 'export-check'))
      : ''

  const probe =
    scenario === 'timetable'
      ? TIMETABLE_PROBE
      : scenario === 'portal'
        ? PORTAL_PROBE
        : scenario === 'cards'
          ? CARDS_PROBE
          : scenario === 'notes'
            ? NOTES_PROBE
            : scenario === 'export'
              ? exportProbe(exportDir)
              : BASIC_PROBE
  // sync 要在主进程与渲染层之间来回走好几趟；export 要跑一次 Packer
  // 再起一个隐藏窗口打印 PDF，都比纯界面自检慢得多
  const timeoutMs =
    scenario === 'basic'
      ? 20_000
      : scenario === 'sync'
        ? 70_000
        : scenario === 'export'
          ? 60_000
          : 35_000

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
    // sync 场景要在「外部程序写盘」和「界面该有什么反应」之间来回切，
    // 一趟 executeJavaScript 装不下，所以单独走一条链路
    if (scenario === 'sync') {
      void runSyncScenario(win)
        .then((passed) => {
          clearTimeout(timer)
          setTimeout(() => app.exit(passed ? 0 : 1), 200)
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          console.error('[smoke] sync 场景执行失败：', error)
          app.exit(1)
        })
      return
    }

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
              : scenario === 'portal'
                ? Boolean(
                    parsed['builtinsOk'] &&
                      parsed['layoutOk'] &&
                      parsed['iconOk'] &&
                      parsed['addOk'] &&
                      parsed['deleteOk'] &&
                      parsed['hideOk'] &&
                      parsed['homeOk']
                  )
                  : scenario === 'notes'
                  ? Boolean(
                      parsed['editorOk'] &&
                        parsed['toolbarOk'] &&
                        parsed['convertCheck'] &&
                        parsed['tableOk'] &&
                        parsed['roundTrip']
                    )
                  : scenario === 'cards'
                  ? Boolean(
                      parsed['flipOk'] &&
                        parsed['frontOk'] &&
                        // 排版体检：字号够大、内容不溢出、留白不局促、长课名夹得住
                        parsed['typoOk'] &&
                        parsed['longNameOk'] &&
                        parsed['contrastOk'] &&
                        parsed['addOk'] &&
                        parsed['noteOk'] &&
                        parsed['jumpOk'] &&
                        // 界面说自己存了不算数，磁盘上真有一份对得上的文件才算
                        verifyNoteOnDisk()
                    )
                  : scenario === 'export'
                  ? Boolean(
                      parsed['menuOk'] &&
                        // 同理：导出接口说成功了不算数，四种产物都得在磁盘上
                        // 对得上内容才算
                        verifyExportOutputs(parsed['results'])
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
        } else if (scenario === 'portal') {
          // 自检收尾停在概览页（正好能同时看到首页的门户格子）
          await captureIfRequested(win, 'portal-home.png')
        } else if (scenario === 'cards') {
          // 收尾停在「课程与学习」页，留一张带卡片的截图
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="study"]')?.click()
                 await wait(900)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'cards.png')
        } else if (scenario === 'notes') {
          // 收尾停在 Markdown 模式，留一张带编辑器与工具栏的截图
          await captureIfRequested(win, 'notes.png')
        } else if (scenario === 'export') {
          // 收尾时导出菜单是开着的，截图里能同时看到编辑器与菜单
          await captureIfRequested(win, 'export.png')
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
  const scenario = smokeScenario()
  if (scenario === 'timetable') await seedTimetable()
  else if (scenario === 'portal') seedPortal()
  else if (scenario === 'cards') seedCards()
  else if (scenario === 'notes') seedNotes()
  else if (scenario === 'sync') seedNotes()
  else if (scenario === 'export') seedExport()
}

/**
 * 界面说自己存好了不算数——去磁盘上把那篇笔记找出来看一眼。
 *
 * 这一步验证的是「Obsidian 能不能直接读」这件事：文件确实是 .md、
 * 开头确实是 YAML frontmatter、正文确实是用户敲进去的那些字。
 * 只断言 DOM 等于只测了自己骗自己。
 */
function verifyNoteOnDisk(): boolean {
  const { notes } = context()
  let files: string[] = []
  try {
    files = readdirSync(notes.dir).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch (error) {
    console.error('[smoke] 读不了笔记库目录：', error)
    return false
  }
  console.info(`[smoke] 笔记库文件：${files.join(' / ') || '（空）'}`)

  const target = files.find((name) => name.startsWith('数据结构'))
  if (!target) {
    console.error('[smoke] 没找到自动创建的那篇笔记文件')
    return false
  }

  try {
    const raw = readFileSync(join(notes.dir, target), 'utf-8')
    const hasFrontmatter = raw.startsWith('---\n') && raw.includes('id:')
    // 探针在界面上插了一张表，磁盘上就该出现 GFM 表格语法。
    // 这一条同时证明了「编辑器写的内容确实落到了文件里」
    const hasBody = raw.includes('| 列 1 |')
    if (!hasFrontmatter || !hasBody) {
      console.error('[smoke] 笔记文件内容不符合预期：', JSON.stringify(raw.slice(0, 260)))
      return false
    }
    console.info(`[smoke] 笔记文件校验通过：${target}（${Buffer.byteLength(raw, 'utf-8')} 字节）`)
  } catch (error) {
    console.error('[smoke] 读笔记文件失败：', error)
    return false
  }

  return verifyExternalNote()
}

/**
 * 外部编辑器（Obsidian / VS Code / 记事本）丢进来的笔记必须能被认出来。
 * 这是「这个目录可以直接当 Obsidian 库用」这句话的前提，
 * 也是后面做文件监听与双向同步的地基——地基不稳，上面盖什么都会歪。
 */
function verifyExternalNote(): boolean {
  const { notes } = context()
  const fileName = '外部写的笔记.md'
  const externalId = '11111111-2222-3333-4444-555555555555'

  try {
    writeFileSync(
      join(notes.dir, fileName),
      `---\nid: ${externalId}\n---\n\n来自 Obsidian\n`,
      'utf-8'
    )
  } catch (error) {
    console.error('[smoke] 写外部笔记失败：', error)
    return false
  }

  const found = notes.list().find((note) => note.fileName === fileName)
  if (!found) {
    console.error('[smoke] 外部新增的笔记没有被认出来')
    return false
  }
  // id 要从文件自己的 frontmatter 里捡回来，而不是随便发一个——
  // 否则索引文件一丢，卡片与笔记的关联就全断了
  if (found.id !== externalId) {
    console.error(`[smoke] 外部笔记的 id 没有沿用 frontmatter：${found.id}`)
    return false
  }

  const doc = notes.read(externalId)
  if (!doc.content.includes('来自 Obsidian')) {
    console.error('[smoke] 外部笔记正文读出来不对：', JSON.stringify(doc.content))
    return false
  }

  // 外部删掉之后，索引里也不能留着幽灵条目
  try {
    rmSync(join(notes.dir, fileName), { force: true })
  } catch {
    /* 删不掉就算了，后面的断言会体现出来 */
  }
  if (notes.list().some((note) => note.fileName === fileName)) {
    console.error('[smoke] 外部删掉的笔记还留在列表里')
    return false
  }

  console.info(`[smoke] 外部笔记对账通过：新增认得出、id 捡得回、删除不掉队`)
  return true
}

/* ---------------------------------------------------------------- 导出产物 */

/**
 * 从 zip（docx 本质就是 zip）里取一个条目的文本。
 *
 * 为什么要自己解这一步：只验「文件头是 PK」的话，一个空壳 zip 也能过，
 * 那这条自检就白做了。docx 的正文全在 `word/document.xml` 里，
 * 解出来看一眼才知道内容到底写进去没有。
 *
 * 走**中央目录**而不是顺序扫本地头：本地头里的压缩大小可能写 0
 * （用 data descriptor 的写法），中央目录里的一定准。
 */
function readZipEntry(zip: Buffer, wanted: string): string | null {
  try {
    // EOCD 签名在末尾 22 字节处，后面还可能跟一段注释，所以往前后各留一点余量
    let eocd = -1
    const floor = Math.max(0, zip.length - 22 - 0xffff)
    for (let i = zip.length - 22; i >= floor; i -= 1) {
      if (zip.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const count = zip.readUInt16LE(eocd + 10)
    let offset = zip.readUInt32LE(eocd + 16)

    for (let i = 0; i < count; i += 1) {
      if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) return null
      const method = zip.readUInt16LE(offset + 10)
      const compressedSize = zip.readUInt32LE(offset + 20)
      const nameLength = zip.readUInt16LE(offset + 28)
      const extraLength = zip.readUInt16LE(offset + 30)
      const commentLength = zip.readUInt16LE(offset + 32)
      const localOffset = zip.readUInt32LE(offset + 42)
      const name = zip.toString('utf-8', offset + 46, offset + 46 + nameLength)

      if (name === wanted) {
        const localNameLength = zip.readUInt16LE(localOffset + 26)
        const localExtraLength = zip.readUInt16LE(localOffset + 28)
        const start = localOffset + 30 + localNameLength + localExtraLength
        const data = zip.subarray(start, start + compressedSize)
        if (method === 0) return data.toString('utf-8')
        if (method === 8) return inflateRawSync(data).toString('utf-8')
        return null
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
    return null
  } catch {
    return null
  }
}

/**
 * 导出产物验收：四种格式都要落到磁盘，而且**内容对得上**。
 *
 * 断言是按「能证明这件事真的发生了」来挑的，不是挑最好写的：
 *  - md：文件开头就是 `# 一级标题` —— 证明 frontmatter 确实被剥掉了；
 *  - html：是完整文档、带 CSP、表格还在 —— 证明样式与安全头都进了产物；
 *  - docx：解出 `word/document.xml`，里面有标记文本、有真正的 `Heading1`
 *    样式、有 `w:tbl`。**只验 PK 文件头等于没验**；
 *  - pdf：头 `%PDF-`、尾 `%%EOF`、体积像话。
 */
function verifyExportOutputs(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') {
    console.error('[smoke] 渲染层没有返回导出结果')
    return false
  }

  const results = raw as Partial<Record<ExportFormat, string>>
  const formats: ExportFormat[] = ['md', 'html', 'docx', 'pdf']
  let ok = true

  for (const format of formats) {
    const path = results[format]
    if (!path || !existsSync(path)) {
      console.error(`[smoke] ${format} 没有落盘：${path || '（渲染层返回了空路径）'}`)
      ok = false
      continue
    }
    if (extname(path).slice(1).toLowerCase() !== EXPORT_EXTENSIONS[format]) {
      console.error(`[smoke] ${format} 产物的扩展名不对：${path}`)
      ok = false
      continue
    }

    const buffer = readFileSync(path)
    if (buffer.length < 200) {
      console.error(`[smoke] ${format} 产物只有 ${buffer.length} 字节，多半是空的`)
      ok = false
      continue
    }

    if (format === 'md') {
      const text = buffer.toString('utf-8')
      if (!text.startsWith('# 一级标题') || !text.includes(EXPORT_MARKER)) {
        console.error('[smoke] md 产物内容不对：开头不是正文，或者标记文本丢了')
        ok = false
      }
    } else if (format === 'html') {
      const text = buffer.toString('utf-8')
      if (
        !text.startsWith('<!DOCTYPE html') ||
        !text.includes('Content-Security-Policy') ||
        !text.includes('<h1') ||
        !text.includes('<table>') ||
        !text.includes(EXPORT_MARKER)
      ) {
        console.error('[smoke] html 产物内容不对')
        ok = false
      }
    } else if (format === 'docx') {
      const xml = readZipEntry(buffer, 'word/document.xml') ?? ''
      if (!xml.includes(EXPORT_MARKER)) {
        console.error('[smoke] docx 里找不到正文标记，内容没写进去')
        ok = false
      } else if (!xml.includes('Heading1')) {
        console.error('[smoke] docx 里的标题没套用标题样式，退化成了普通段落')
        ok = false
      } else if (!xml.includes('w:tbl')) {
        console.error('[smoke] docx 里没有表格')
        ok = false
      }
    } else {
      const head = buffer.subarray(0, 5).toString('latin1')
      const tail = buffer.subarray(Math.max(0, buffer.length - 64)).toString('latin1')
      if (head !== '%PDF-' || !tail.includes('%%EOF')) {
        console.error('[smoke] pdf 产物不是一份完整的 PDF')
        ok = false
      }
    }
  }

  if (ok) console.info('[smoke] 四种导出产物都在磁盘上，且内容对得上')
  return ok
}

/* --------------------------------------------------- 文件监听（双向同步） */

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 模拟外部编辑器保存：直接往文件末尾追加。Obsidian 保存落到磁盘上也是这一件事 */
function appendExternal(fileName: string, text: string): void {
  appendFileSync(join(context().notes.dir, fileName), `\n\n${text}\n`, 'utf-8')
}

/**
 * 笔记被外部删除之后，指着它的卡片必须自己解开关联。
 *
 * 只断言界面是不够的：界面那边只是把列表收起来了，卡片身上留着的 noteId
 * 才是真正会出问题的地方——用户回到课程页点「记笔记」会跳进一个空页面，
 * 而且没有任何提示说明为什么。
 */
function verifyCardUnlinked(cardId: string): boolean {
  const card = context().cards.list().find((item) => item.id === cardId)
  if (!card) {
    console.error('[smoke] 找不到关联测试用的那张卡片')
    return false
  }
  if (card.noteId !== '') {
    console.error(`[smoke] 笔记被外部删除后，卡片仍然指着 ${card.noteId}`)
    return false
  }
  console.info('[smoke] 外部删除笔记之后，卡片关联已自动解开')
  return true
}

/**
 * 改名之后卡片还得指着同一篇。
 *
 * 这一条才是「外部改名不能当成删一篇加一篇」的验金石：文件换了名字，
 * 但笔记的 id 没变（它写在文件的 frontmatter 里，认领时会原样捡回来），
 * 所以卡片的关联必须原封不动。断了就说明对账把改名拆成了删除 + 新增。
 */
function verifyCardStillLinked(cardId: string, noteId: string): boolean {
  const card = context().cards.list().find((item) => item.id === cardId)
  if (!card) {
    console.error('[smoke] 找不到改名测试用的那张卡片')
    return false
  }
  if (card.noteId !== noteId) {
    console.error(`[smoke] 外部改名把卡片关联弄断了：期望 ${noteId}，实际 ${card.noteId || '（空）'}`)
    return false
  }
  console.info('[smoke] 外部改名之后，卡片关联仍然指着同一篇')
  return true
}

/**
 * 文件监听场景。
 *
 * 来回七趟：开笔记（顺带验「自己写盘不回环」）→ 外部新增 → 外部改动 →
 * 外部删除（顺带验卡片解绑）→ 冲突选保留 → 冲突选载入 → 外部改名。
 *
 * 每一趟之间都由主进程直接写磁盘。这就是「外部编辑器」最终在做的事，
 * 只是省掉了那个编辑器——测的仍然是真实的那条路径。
 */
async function runSyncScenario(win: BrowserWindow): Promise<boolean> {
  const probe = async (script: string): Promise<Record<string, unknown>> => {
    const raw = await win.webContents.executeJavaScript(script, true)
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>
    console.info('[smoke] 同步自检：', raw)
    return parsed
  }

  const seeded = context().notes.list().find((note) => note.title === '编辑器自检')
  if (!seeded) {
    console.error('[smoke] 种子里没有那篇笔记')
    return false
  }

  // —— 1. 打开笔记，并自己写一次盘
  const opened = await probe(SYNC_OPEN_PROBE)
  if (!opened['opened']) return false
  if (!opened['noEcho']) {
    console.error('[smoke] 自己写盘触发了事件回环：编辑器被重载了')
  }

  // —— 2. 外部新增一篇：列表要自己长出来
  writeFileSync(
    join(context().notes.dir, SYNC_EXTERNAL_FILE),
    `---\nid: ${SYNC_EXTERNAL_ID}\nmode: markdown\n---\n\n来自 Obsidian 的一段话\n`,
    'utf-8'
  )
  await settle(2000)
  const added = await probe(SYNC_ADD_PROBE)

  // —— 3. 外部改正在编辑的那篇：编辑器要换成磁盘上的版本
  appendExternal(seeded.fileName, EXTERNAL_APPEND_1)
  await settle(2000)
  const changed = await probe(SYNC_CHANGE_PROBE)

  // —— 4. 先让一张卡片指着那篇外部笔记，再把文件删掉
  const card = context().cards.upsert({ courseName: '外部删除联动测试', teacher: '自检' })
  context().cards.linkNote(card.id, SYNC_EXTERNAL_ID)
  rmSync(join(context().notes.dir, SYNC_EXTERNAL_FILE), { force: true })
  // 删除要两次确认才上报（用来挡「先删原文件再写新的」那种保存方式），等久一点
  await settle(3000)
  const unlinked = await probe(SYNC_UNLINK_PROBE)
  const cardOk = verifyCardUnlinked(card.id)

  // —— 5. 编辑器里有没保存的改动时，外部再改必须先问一句
  appendExternal(seeded.fileName, EXTERNAL_APPEND_2)
  await settle(2000)
  const kept = await probe(SYNC_CONFLICT_KEEP_PROBE)

  // —— 6. 同样的冲突，这次选择载入磁盘上的版本
  appendExternal(seeded.fileName, EXTERNAL_APPEND_3)
  await settle(2000)
  const loaded = await probe(SYNC_CONFLICT_LOAD_PROBE)

  // —— 7. 外部改名：文件换个名字，但 id 写在里面没动。
  // 对账必须把「改名」认成改名，而不是「删一篇 + 加一篇」——
  // 否则用户只是在 Obsidian 里改个文件名，卡片关联就无声地断了
  const renameCard = context().cards.upsert({ courseName: '外部改名联动测试', teacher: '自检' })
  context().cards.linkNote(renameCard.id, seeded.id)
  renameSync(join(context().notes.dir, seeded.fileName), join(context().notes.dir, SYNC_RENAMED_FILE))
  await settle(2500)
  const renamed = await probe(SYNC_RENAME_PROBE)
  const renameCardOk = verifyCardStillLinked(renameCard.id, seeded.id)

  await captureIfRequested(win, 'sync.png')

  return Boolean(
    opened['noEcho'] &&
      added['addOk'] &&
      changed['changeOk'] &&
      unlinked['unlinkOk'] &&
      cardOk &&
      kept['keepOk'] &&
      loaded['loadOk'] &&
      renamed['renameOk'] &&
      renameCardOk
  )
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
