import { BrowserWindow, app } from 'electron'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
 *  - portal    额外验证网站门户：内置站点、图标走 sb-asset、增删改隐藏全链路
 *  - cards     额外验证课程卡片：翻转、从课表带过课程、建卡片自动建笔记、
 *              「记笔记」跳转、笔记落盘成 Obsidian 认得的文件
 *
 * 门户场景**不测图标抓取**：那需要真实网络，在无网的 CI 里会让自检变成随机失败。
 * 图标文件由本文件直接造好写进图标目录，测的是「图标能不能显示出来」这条链路，
 * 而不是「能不能从外网抓下来」——后者本来就该由人点一下按钮确认。
 */

export type SmokeScenario = 'basic' | 'timetable' | 'portal' | 'cards'

export function smokeEnabled(): boolean {
  return process.env['STUDY_BOARD_SMOKE'] === '1'
}

export function smokeScenario(): SmokeScenario {
  const value = process.env['STUDY_BOARD_SMOKE_SCENARIO']
  if (value === 'timetable') return 'timetable'
  if (value === 'portal') return 'portal'
  if (value === 'cards') return 'cards'
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

  // 卡片与笔记的关联在真实流程里由 IPC 层建立，这里手工补上等价的结果
  for (const card of [maths, english]) {
    const note = notes.create(`${card.courseName}_${card.teacher}`)
    cards.linkNote(card.id, note.id)
  }
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

const CARDS_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const nav = await waitFor('[data-route="study"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()
  await waitFor('[data-role="cards"]')

  // 先等课表数据到了再开——「从课表带过来」这个下拉是靠它填的。
  // 直接看下拉有没有选项，等于等语义状态而不是等元素（老坑了）
  const cardCount = await waitForCount('.sb-itemcard', 2)
  if (!cardCount) return JSON.stringify({ error: '卡片没渲染出来' })

  // —— 翻转：单击应该把卡片翻到背面，再点一次翻回来
  const first = document.querySelector('.sb-itemcard')
  const flipTarget = first.querySelector('[data-act="flip"]')
  flipTarget.click()
  await wait(420)
  const flipped = first.classList.contains('sb-itemcard--flipped')
  // 背面必须真的有内容，不能只是转了个空壳
  const backText = first.querySelector('.sb-card__face--back').textContent.trim().length
  flipTarget.click()
  await wait(420)
  const flippedBack = !first.classList.contains('sb-itemcard--flipped')

  // 正面该显示的东西
  const frontText = first.querySelector('.sb-card__face--front').textContent
  const frontOk = frontText.includes('高等数学 A') && frontText.includes('张启明')

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

  const addedInTime = await waitForCount('.sb-itemcard', 3)
  const addedText = document.body.textContent.includes(carriedName)
  const carriedOk = carriedName.length > 0 && carriedTeacher.length > 0

  // —— 切到笔记页：卡片应该已经自动建好了同名笔记
  document.querySelector('[data-route="notes"]').click()
  await waitFor('[data-role="list"]')
  const expectedTitle = carriedTeacher ? carriedName + '_' + carriedTeacher : carriedName
  const listItems = await waitForCount('.sb-notes__item', 3)
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
  if (target) {
    target.click()
    // 必须等标题被填上——那才说明笔记真的读出来了。
    // 只等 [data-role="body"] 会立刻命中（它一直在 DOM 里，只是被 hidden 藏着），
    // 这时往里写的内容会被随后到达的 open() 覆盖掉
    const loaded = await waitForValue('[data-role="title"]', expectedTitle)
    const body = document.querySelector('[data-role="body"]')
    if (loaded && body) {
      body.value = '# 第一章\\n\\n自动建的笔记也应该能直接写。'
      body.dispatchEvent(new Event('input', { bubbles: true }))
      const saved = await waitForText('[data-role="status"]', '已保存')
      typedOk = saved
    }
  }

  // —— 从卡片点「记笔记」应该跳到笔记页并定位到那一篇。
  // 要挑**新建的那张**卡片（它在最后），否则点到的是别的课，测了个寂寞
  document.querySelector('[data-route="study"]').click()
  await waitForCount('.sb-itemcard', 3)
  const allCards = Array.from(document.querySelectorAll('.sb-itemcard'))
  const noteBtn = allCards[allCards.length - 1]
  if (noteBtn) noteBtn.querySelector('[data-act="note"]').click()
  await waitFor('[data-role="pane"]:not([hidden])')
  const jumpedTitle = document.querySelector('[data-role="title"]').value
  const jumpOk = jumpedTitle === expectedTitle

  return JSON.stringify({
    flipped, flippedBack, backText, frontOk, options, pickerOk,
    carriedName, carriedTeacher, carriedOk, addedInTime, addedText,
    listItems, autoNoteOk, typedOk, jumpedTitle, jumpOk,
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
  const probe =
    scenario === 'timetable'
      ? TIMETABLE_PROBE
      : scenario === 'portal'
        ? PORTAL_PROBE
        : scenario === 'cards'
          ? CARDS_PROBE
          : BASIC_PROBE
  const timeoutMs = scenario === 'basic' ? 20_000 : 35_000

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
                : scenario === 'cards'
                  ? Boolean(
                      parsed['flipOk'] &&
                        parsed['frontOk'] &&
                        parsed['addOk'] &&
                        parsed['noteOk'] &&
                        parsed['jumpOk'] &&
                        // 界面说自己存了不算数，磁盘上真有一份对得上的文件才算
                        verifyNoteOnDisk()
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
    const hasBody = raw.includes('自动建的笔记也应该能直接写')
    if (!hasFrontmatter || !hasBody) {
      console.error('[smoke] 笔记文件内容不符合预期：', JSON.stringify(raw.slice(0, 240)))
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
