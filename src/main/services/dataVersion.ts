import { app, dialog } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { DEFAULT_WEEK_COUNT } from '@shared/limits'

import { dataRoot, newId } from '../paths'

/**
 * 数据格式版本，以及「换版本时数据会不会坏」这件事的唯一闸口。
 *
 * ## 为什么需要它
 *
 * 各存储自己的 `version` 字段只写了**不读**（notes / cards / materials /
 * portal / secrets 都是这样），所以那些字段只能算注释，挡不住任何东西。
 * 真正需要回答的是两个问题，而它们都必须在**任何存储被构造之前**回答：
 *
 *  1. **升级**：这份数据是旧版写的，新版的读法还认不认？要不要搬一次？
 *  2. **降级**：这份数据是**更新的**版本写的，当前这个旧程序还该不该动它？
 *
 * 第 2 条是真会丢数据的：旧程序的加载器只认识自己那几个字段，
 * 存盘时按认识的重建一遍 —— 新版加的东西会被**静默抹掉**。
 * 用户装回旧版（或从 U 盘跑一份旧的），打开一次笔记，新版写入的内容就没了。
 * 这种损坏没有任何提示，等发现时已经过了好几轮自动保存。
 *
 * ## 三个决定
 *
 * **印记单独一个文件**（`data-version.json`），不塞进 `config.json`。
 * 配置是用户能改的东西，印记是程序的事实记录，混在一起会让
 * 「用户删掉配置」变成「版本印记一起消失」。
 *
 * **迁移之前先整目录备份**。迁移是唯一会成批改写用户数据的操作，
 * 它必须有一个「回到操作前」的按钮。备份放在 `.backups/`，不参与
 * 自身的复制（否则会递归复制自己）。
 *
 * **降级不阻止启动，但要说清楚，并且先备份**。直接拒绝启动对
 * 一个学习工具太重了（用户可能就是想先看一眼笔记）；而静默继续
 * 又等于默认同意丢数据。折中是：备份 + 显著提示 + 记进日志，
 * 把选择权留给用户。
 */

/**
 * 当前程序认识的数据格式版本。
 *
 * 什么时候该 +1：**改动会让旧程序读错或写坏数据**的时候。
 * 纯新增字段（旧程序读到就忽略、新程序读到就用默认值）不算，
 * 那种情况两边都能跑，加版本号只会白白触发一次备份。
 *
 * 0.1.0 → 0.2.0 之间加过笔记分组、图片资料，都是纯新增，所以仍是 1。
 *
 * v1 → v2（0.4.0）：课表格子从「一个对象」变成「数组」（同一时间段
 * 可以并存多门课，按周次区分）。这是**改形状**而不是加字段 ——
 * 旧程序读到数组会把它当成一个残缺的对象，存盘时按自己的字段表重建，
 * 用户录的课就被静默抹掉了。所以必须 +1。
 */
export const DATA_SCHEMA = 2

/** 印记文件的名字。放在数据根目录下 */
const STAMP_FILE = 'data-version.json'

/** 备份目录名。以 `.` 开头：既不参与自身复制，也不会混进用户的视线 */
const BACKUP_DIR = '.backups'

/** 最多留几份备份。再多就是白占磁盘，而真正会用到的基本只有最近一份 */
const MAX_BACKUPS = 3

/**
 * 备份时跳过的子目录。
 *
 * `temp` 是导入过程的中转站（半截文件，没有价值）；
 * `logs` 是运行日志（可能很大，且与数据无关）；
 * `.backups` 必须跳过，否则会把自己复制进自己里面。
 */
const SKIP_ON_BACKUP = new Set([BACKUP_DIR, 'temp', 'logs'])

export interface DataStamp {
  /** 写入这份数据的程序所认识的数据格式版本 */
  schema: number
  /** 写入这份数据的程序版本，出问题时用来对账 */
  app: string
  /** 印记最后一次更新（即数据最后一次被某个版本「认领」）的时间 */
  writtenAt: string
}

export type SchemaVerdict =
  /** 数据根目录里什么都没有 —— 全新安装 */
  | { kind: 'fresh' }
  /** 印记与当前程序一致 */
  | { kind: 'same'; stamp: DataStamp }
  /** 旧数据（或没有印记的老数据），需要迁移 */
  | { kind: 'upgrade'; from: number }
  /** 数据来自更新的版本，当前程序不该动它 */
  | { kind: 'downgrade'; stamp: DataStamp }
  /**
   * 印记文件在，但读不出合法内容。
   *
   * 与「没有印记」必须分开处置：没有印记说明这是**老版本**留下的数据，
   * 按升级处理；而读不出来的印记有可能是**更新的版本换了印记格式**，
   * 不能想当然地当成老数据直接覆盖掉。
   */
  | { kind: 'corrupt' }

export interface PrepareResult {
  verdict: SchemaVerdict
  /** 这次真的做了什么（用于日志与自检断言），没做就是空数组 */
  actions: string[]
  /** 需要让用户看到的话；没有就是 null */
  warning: string | null
}

function stampPath(portable: boolean): string {
  return join(dataRoot(portable), STAMP_FILE)
}

function backupRoot(portable: boolean): string {
  return join(dataRoot(portable), BACKUP_DIR)
}

/**
 * 老版本（还没有印记的那一版）会留下的东西。
 *
 * 用来判断「这个目录里有没有**我们的**数据」。
 */
const LEGACY_DATA_ENTRIES = new Set([
  'config.json',
  'secrets.bin',
  'cards.json',
  'portal.json',
  'timetable.json',
  /**
   * 日历 / 日程（0.5.0 新增）。
   *
   * **新增一个存储文件时，必须同时登记到这里。** 漏了的话，一个
   * 「只记了日程、没别的文件」的数据目录会被判成全新安装 ——
   * 于是闸口不备份就写印记，用户的老数据直接失去回头路。
   * 这个坑项目里踩过一次（HANDOFF 坑位区），所以自检里专门有一条
   * 断言盯着它：`smoke:calendar` 会造一份只有 calendar.json 的目录。
   */
  'calendar.json',
  'notes_library',
  'timetable_images',
  'icons_cache'
])

/**
 * 数据根目录里有没有「用户的数据」。
 *
 * 用来把「全新安装」和「老版本留下的、没有印记的数据」分开——
 * 这两者的处理方式不同：前者直接写印记就行，后者要先备份再迁移。
 *
 * **只认我们自己的那几个文件 / 目录，不能只看「目录非空」。**
 * `userData` 目录同时也是 Chromium 的 profile 目录，Electron 启动时
 * 会往里写 `Preferences`、`Local Storage` 之类的东西。按「非空」
 * 判断的话，**每一次全新安装都会被当成老数据**：用户第一次打开
 * 就会看到「迁移前已备份」的日志和一份毫无意义的备份。
 * 这是自检时抓到的——全新临时目录也走了迁移分支。
 */
function hasUserData(portable: boolean): boolean {
  const root = dataRoot(portable)
  if (!existsSync(root)) return false
  try {
    return readdirSync(root).some((name) => LEGACY_DATA_ENTRIES.has(name))
  } catch {
    // 读不了目录就当有数据：宁可多备份一次，也不要跳过迁移
    return true
  }
}

export function readStamp(portable: boolean): DataStamp | null {
  const file = stampPath(portable)
  if (!existsSync(file)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    const schema = Number(record['schema'])
    if (!Number.isInteger(schema) || schema < 0) return null
    return {
      schema,
      app: String(record['app'] ?? ''),
      writtenAt: String(record['writtenAt'] ?? '')
    }
  } catch {
    return null
  }
}

/**
 * 印记文件存在、但读不出合法内容。
 *
 * 必须与「没有印记」分开：没有印记 = 老版本的数据（要迁移），
 * 读不出来 = 可能是**更新的版本换了印记格式**（不能当老数据覆盖）。
 *
 * 不做成 `readStamp` 的一种返回值，是因为调用方（设置页、自检）
 * 只需要「读到的印记」这一件事，多一种返回值会让它们都要处理一个
 * 它们不关心的分支。
 */
export function stampUnreadable(portable: boolean): boolean {
  const file = stampPath(portable)
  if (!existsSync(file)) return false
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!raw || typeof raw !== 'object') return true
    const schema = Number((raw as Record<string, unknown>)['schema'])
    return !Number.isInteger(schema) || schema < 0
  } catch {
    return true
  }
}

function writeStamp(portable: boolean, schema: number): void {
  const file = stampPath(portable)
  const payload: DataStamp = {
    schema,
    app: app.getVersion(),
    writtenAt: new Date().toISOString()
  }
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** 把整个数据目录复制一份出来。跳过 `SKIP_ON_BACKUP` 里那些 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_ON_BACKUP.has(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) cpSync(source, target)
    // 符号链接等其它类型一律跳过：数据目录里不该有它们，
    // 而跟着链接复制可能把备份写到数据目录之外
  }
}

/**
 * 做一次备份，返回备份目录路径。
 *
 * 目录名里带上「从哪个版本到哪个版本」：事后翻备份时，
 * 一眼能看出这份备份是在哪次升级前拍的。
 */
function makeBackup(portable: boolean, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupRoot(portable), `${stamp}-${label}`)
  copyTree(dataRoot(portable), target)
  pruneBackups(portable)
  return target
}

/** 只留最近 MAX_BACKUPS 份 */
function pruneBackups(portable: boolean): void {
  const root = backupRoot(portable)
  if (!existsSync(root)) return
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
      rmSync(join(root, name), { recursive: true, force: true })
    }
  } catch {
    /* 清理失败不影响本次备份，下次启动会再试 */
  }
}

/**
 * v1 → v2：课表格子从「一个对象」变成「数组」。
 *
 * 为什么是整格包成单元素数组而不是拆成多条记录：现有数据里一格只有
 * 一门课，语义上就是「每周都上这一门」。包成 `[{ ...cell, id, weeks: all }]`
 * 之后，旧数据零操作地变成新形状里最简单的一种，用户不需要做任何事。
 *
 * **幂等**：`cells[key]` 已经是数组时原样保留。这条不是洁癖 ——
 * 迁移函数可能因为「印记写失败」「备份后进程被杀」之类的原因被跑第二遍，
 * 第二次再包一层就会变成 `[[{...}]]`，而那是个**静默的数据损坏**：
 * 闸口照常写印记，用户下次打开课表全空了，还找不到是哪一步坏的。
 *
 * 导出它只为自检：幂等性没法从外部观察（第二次跑完形状应该**不变**），
 * 必须能再调一次才能断言。主进程内部没有别的调用点。
 */
export function migrateTimetableV1ToV2(dir: string): void {
  const file = join(dir, 'timetable.json')
  if (!existsSync(file)) return

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    // 解析失败交给 TimetableStore 的「损坏文件」分支（备份 + 重建）。
    // 迁移阶段把它删掉或重写成空文件，才是真的把用户数据弄丢
    return
  }
  if (!parsed || typeof parsed !== 'object') return

  const record = parsed as Record<string, unknown>
  const rawCells = record['cells']

  if (rawCells && typeof rawCells === 'object' && !Array.isArray(rawCells)) {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rawCells as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        next[key] = value
        continue
      }
      if (!value || typeof value !== 'object') continue
      const cell = value as Record<string, unknown>
      const blank = ['courseName', 'teacher', 'location', 'duration', 'remark'].every(
        (field) => String(cell[field] ?? '').trim() === ''
      )
      if (blank) continue
      next[key] = [{ ...cell, id: newId(), weeks: { kind: 'all' } }]
    }
    record['cells'] = next
  }

  // 周次相关的字段是 v2 新增的，老文件里没有；补默认值让存储读到的是
  // 「一个合法的 v2 文件」而不是半截形状
  if (!Number.isFinite(Number(record['weekCount']))) record['weekCount'] = DEFAULT_WEEK_COUNT
  if (!Number.isFinite(Number(record['currentWeek']))) record['currentWeek'] = 0

  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/**
 * 逐级迁移：`MIGRATIONS[n]` 负责把 v`n` 搬到 v`n+1`。
 *
 * 闸口在跑之前已经**整目录备份**，所以每一步都可以「回到操作前」。
 */
const MIGRATIONS: Record<number, (dir: string) => void> = {
  1: migrateTimetableV1ToV2
}

export function inspectData(portable: boolean): SchemaVerdict {
  // 读不出来的印记单独一路：它既不是「老数据」也不是「新数据」，
  // 而这两种的处置正好相反，猜错哪一边都不好
  if (stampUnreadable(portable)) return { kind: 'corrupt' }

  const stamp = readStamp(portable)
  if (stamp) {
    if (stamp.schema > DATA_SCHEMA) return { kind: 'downgrade', stamp }
    if (stamp.schema === DATA_SCHEMA) return { kind: 'same', stamp }
    return { kind: 'upgrade', from: stamp.schema }
  }
  // 没有印记：可能是全新安装，也可能是老版本留下的数据。
  // 用「目录里有没有别的东西」来分，而不是一律当成全新 ——
  // 一律当全新的话，老数据就绕过了备份，而它恰恰最需要备份
  if (!hasUserData(portable)) return { kind: 'fresh' }
  return { kind: 'upgrade', from: 0 }
}

/**
 * 启动时的数据闸口。**必须在任何存储被构造之前调用。**
 *
 * 存储的构造函数会读文件，读完就形成了内存态；那时候再迁移，
 * 内存里拿的还是旧格式，等于白搬一次。
 *
 * 刻意**不在这里弹窗**：启动路径上一个模态框会让人以为程序卡住了，
 * 而且会把自检卡在一个没人点的确认框上。警告随返回值交给调用方，
 * 由它在窗口起来之后决定怎么呈现。
 */
export function prepareDataDir(portable: boolean): PrepareResult {
  const verdict = inspectData(portable)
  const actions: string[] = []

  if (verdict.kind === 'fresh') {
    writeStamp(portable, DATA_SCHEMA)
    return { verdict, actions: ['写入初始数据版本印记'], warning: null }
  }

  if (verdict.kind === 'same') {
    // 同一版格式，但可能换了程序版本（0.2.0 → 0.3.0 不改格式）。
    // 刷新印记里的 app 字段，让「这份数据最后被哪个版本写过」保持准确
    if (verdict.stamp.app !== app.getVersion()) {
      writeStamp(portable, DATA_SCHEMA)
      actions.push(`印记程序版本 ${verdict.stamp.app} → ${app.getVersion()}`)
    }
    return { verdict, actions, warning: null }
  }

  if (verdict.kind === 'corrupt') {
    /**
     * 印记读不出来。备份 + 把它留档 + 写一份新的。
     *
     * 为什么不留着它一直报警：那样每次启动都会「降级一次」——
     * 备份越堆越多，用户每次打开都看到一条吓人的提示，而其实
     * 什么都没发生。印记是原子写入的，真读不出来基本只有两种可能：
     * 磁盘出问题，或者更新的版本换了印记格式。两种都不该让用户
     * 永久背一条警告。
     *
     * 留档（改名而不是删除）是为了还能事后查证到底是怎么回事。
     */
    const target = makeBackup(portable, 'before-unreadable-stamp')
    const file = stampPath(portable)
    try {
      renameSync(file, `${file}.unreadable`)
    } catch {
      /* 改名失败不影响主流程，writeStamp 会直接覆盖 */
    }
    writeStamp(portable, DATA_SCHEMA)
    const warning =
      `数据版本印记读不出来，已把它留档为 ${STAMP_FILE}.unreadable。\n\n` +
      `为稳妥起见，数据已先备份到：\n${target}\n\n` +
      `如果这份数据是更新版本的 StudyBoard 写的，建议先升级再继续使用。`
    return { verdict, actions: ['印记读不出来：已备份并留档，写入新的印记'], warning }
  }

  if (verdict.kind === 'downgrade') {
    /**
     * 数据比程序新。**先备份，再继续**。
     *
     * 不阻止启动：用户可能只是想打开看一眼，或者临时用旧版顶一下。
     * 但备份必须做，因为接下来这个旧程序一旦存盘，就会按自己的
     * 字段表重建文件，新版写的东西会被静默抹掉。
     */
    const target = makeBackup(portable, `before-downgrade-schema${verdict.stamp.schema}`)
    const warning =
      `这份数据是由更新版本的 StudyBoard 写的（数据格式 v${verdict.stamp.schema}，` +
      `当前程序只支持到 v${DATA_SCHEMA}）。继续使用当前版本，可能会丢失新版本写入的内容。\n\n` +
      `已自动备份到：\n${target}\n\n建议升级到最新版本再打开。`
    return { verdict, actions: [`降级保护：已备份到 ${basename(target)}`], warning }
  }

  // 升级：备份 → 逐级迁移 → 写新印记
  const target = makeBackup(portable, `before-upgrade-schema${verdict.from}-to${DATA_SCHEMA}`)
  actions.push(`迁移前备份到 ${basename(target)}`)

  const dir = dataRoot(portable)
  for (let from = verdict.from; from < DATA_SCHEMA; from += 1) {
    const migrate = MIGRATIONS[from]
    if (!migrate) continue
    migrate(dir)
    actions.push(`数据格式 v${from} → v${from + 1}`)
  }

  writeStamp(portable, DATA_SCHEMA)
  actions.push(`印记更新到 v${DATA_SCHEMA}`)

  return { verdict, actions, warning: null }
}

/**
 * 把降级警告摆到用户面前。
 *
 * 只在有窗口可用时用对话框；自检 / 基准跑的时候不能弹 ——
 * 那会把自动化流程卡在一个没人点的确认框上。
 */
export function reportDataWarning(warning: string | null, interactive: boolean): void {
  if (!warning) return
  console.error(`[data] ${warning}`)
  if (!interactive) return
  dialog.showMessageBoxSync({
    type: 'warning',
    title: '数据版本不匹配',
    message: '这份数据来自更新版本的 StudyBoard',
    detail: warning,
    buttons: ['我知道了'],
    noLink: true
  })
}

/** 数据根目录，供自检与设置页展示 */
export function dataRootPath(portable: boolean): string {
  return dataRoot(portable)
}
