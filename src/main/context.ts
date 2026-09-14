import {
  cardsFile,
  detectPortableMode,
  ensureDir,
  iconsCacheDir,
  portalFile,
  rescueStashedPortableData,
  timetableFile,
  timetableImagesDir
} from './paths'
import type { AssetBuckets } from './services/assetProtocol'
import { CardsStore } from './services/cards'
import { DATA_SCHEMA, prepareDataDir, readStamp, type PrepareResult } from './services/dataVersion'
import { MaterialsStore } from './services/materials'
import { NotesStore } from './services/notes'
import { PortalStore } from './services/portal'
import { SecretsStore } from './services/secrets'
import { resolveNotesDir, SettingsStore } from './services/settings'
import { TimetableStore } from './services/timetable'

/**
 * 应用级单例上下文。
 * 只在这里持有「需要跨模块共享、且必须唯一」的东西：设置、资源目录、各类存储。
 */

export interface AppContext {
  settings: SettingsStore
  buckets: AssetBuckets
  timetable: TimetableStore
  portal: PortalStore
  cards: CardsStore
  notes: NotesStore
  /** 课程资料库（在笔记库的 attachments/ 内，跟着笔记库走） */
  materials: MaterialsStore
  /** 密钥存储。只有主进程能拿到，渲染层只能读到布尔值 */
  secrets: SecretsStore
}

let current: AppContext | null = null

/**
 * 上一次数据闸口的结果。
 *
 * 存下来是为了让「升级搬过东西」「数据来自更新的版本」这两件事
 * 能被设置页和自检看到 —— 否则它们只存在于一行 console 里，
 * 而打包后的应用没有控制台。
 */
let lastPrepare: PrepareResult | null = null

/** 闸口当时认定的数据位置。存下来，免得闸口结论和「现在读哪个目录」对不上 */
let lastPortable = false

function buildBuckets(portable: boolean, notesDir: string): AssetBuckets {
  return {
    notes: ensureDir(notesDir),
    timetable: ensureDir(timetableImagesDir(portable)),
    icons: ensureDir(iconsCacheDir(portable))
  }
}

/**
 * 启动时先过数据闸口，再建存储。
 *
 * **顺序不能反**：存储的构造函数会读文件，读完就形成了内存态；
 * 那时候再迁移，内存里拿的还是旧格式，等于白搬一次。
 */
export function initContext(): AppContext {
  // 先看有没有「上一次更新失败留下的暂存」要救回来。必须排在探测之前：
  // 暂存挪回去之后，便携模式才认得出来
  const rescued = rescueStashedPortableData()
  if (rescued) console.warn(`[data] 已恢复上次更新暂存的便携数据：${rescued}`)

  const portable = detectPortableMode()
  lastPortable = portable

  // 闸口只做「备份 + 迁移 + 写印记」，不弹窗。弹窗要等窗口起来之后再说 ——
  // 启动路径上一个模态框会让人以为程序卡住了
  lastPrepare = prepareDataDir(portable)
  if (lastPrepare.actions.length > 0) {
    console.info(`[data] 数据闸口：${lastPrepare.actions.join('；')}`)
  }

  const settings = new SettingsStore(portable)
  const snapshot = settings.get()

  // 课表图片与门户图标各用一个目录：这样「清理孤儿文件」是各自独立的一件事，
  // 不会出现某一侧的清理逻辑误删另一侧正在使用的文件
  const timetable = new TimetableStore(
    timetableFile(snapshot.portableMode),
    timetableImagesDir(snapshot.portableMode)
  )
  const portal = new PortalStore(portalFile(snapshot.portableMode), iconsCacheDir(snapshot.portableMode))
  const cards = new CardsStore(cardsFile(snapshot.portableMode))
  const notes = new NotesStore(resolveNotesDir(snapshot))
  const materials = new MaterialsStore(resolveNotesDir(snapshot))
  const secrets = new SecretsStore(snapshot.portableMode)

  // 密钥的存在状态回填进内存态（不落盘）：设置页与笔记页都靠它决定
  // 「AI 能不能用」。hasApiKey 永远只是一个布尔，密钥本体不出主进程
  settings.markSecretPresence('ai', secrets.has('aiKey'))
  settings.markSecretPresence('notion', secrets.has('notionToken'))

  current = {
    settings,
    buckets: buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot)),
    timetable,
    portal,
    cards,
    notes,
    materials,
    secrets
  }
  return current
}

/**
 * 清理「有文件但没记录」的孤儿文件（课表图片、门户图标）。
 *
 * 刻意**不放在启动路径上**：它是纯清理工作，不影响首屏能否显示，
 * 却要做目录遍历。放到窗口显示之后再跑，
 * 启动阶段就只做「读出必要数据」这一件事。
 */
export function sweepOrphanFiles(): void {
  const sweptImages = context().timetable.sweepOrphans()
  if (sweptImages > 0) console.info(`[timetable] 清理了 ${sweptImages} 个无主的课表图片`)

  const sweptIcons = context().portal.sweepOrphans()
  if (sweptIcons > 0) console.info(`[portal] 清理了 ${sweptIcons} 个无主的站点图标`)
}

export function context(): AppContext {
  if (!current) throw new Error('应用上下文尚未初始化')
  return current
}

/** 数据闸口的结论，供设置页与自检读取。未初始化时返回空壳而不是抛异常 */
export function dataStatus(): {
  supported: number
  stamp: ReturnType<typeof readStamp>
  verdict: PrepareResult['verdict'] | null
  actions: string[]
  warning: string | null
} {
  return {
    supported: DATA_SCHEMA,
    stamp: readStamp(lastPortable),
    verdict: lastPrepare?.verdict ?? null,
    actions: lastPrepare?.actions ?? [],
    warning: lastPrepare?.warning ?? null
  }
}

/**
 * 笔记库目录被用户改动后，同步刷新资源桶与笔记存储。
 *
 * 笔记存储必须一起重建：它是绑在具体目录上的，换了库却还指着旧目录，
 * 就会出现「设置里显示新路径，但列表里还是旧库的笔记」这种让人发毛的状态。
 */
export function refreshBuckets(): void {
  const ctx = context()
  const snapshot = ctx.settings.get()
  ctx.buckets = buildBuckets(snapshot.portableMode, resolveNotesDir(snapshot))
  ctx.notes = new NotesStore(resolveNotesDir(snapshot))
  // 资料库也在笔记库内（attachments/），必须跟着一起重建，
  // 否则换了库之后资料还指向上一个库的目录
  ctx.materials = new MaterialsStore(resolveNotesDir(snapshot))
}
