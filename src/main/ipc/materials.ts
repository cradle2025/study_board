import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { watch } from 'chokidar'
import { app, dialog, shell } from 'electron'

import { CHANNELS } from '@shared/channels'
import { MATERIAL_EXTENSIONS, MATERIAL_INBOX_DIRNAME, isMaterialExtension } from '@shared/materials'
import type {
  MaterialImportInput,
  MaterialImportResult,
  MaterialInboxCandidate,
  MaterialItem
} from '@shared/types'

import { context } from '../context'
import { ensureDir, safeJoin } from '../paths'
import { broadcast, handle } from './index'

/**
 * 课程资料 IPC。
 *
 * 渲染层**永远不传完整路径**，只传 id 或收件箱内的文件名——
 * 库目录与收件箱目录都由主进程持有并 safeJoin，渲染层拼不出越界路径。
 */

/** 收件箱目录：设置里配了就用配置值，否则用系统下载目录下的约定子目录 */
function resolveInboxDir(): string {
  const configured = context().settings.get().materials.inboxDir.trim()
  if (configured.length > 0) return configured
  return ensureDir(join(app.getPath('downloads'), MATERIAL_INBOX_DIRNAME))
}

export function inboxDir(): string {
  return resolveInboxDir()
}

/** 归属课程的名字（拼进入库文件名前缀用）。卡片不存在 / 未归类 → 空串 */
function courseNameOf(cardId: string): string {
  if (!cardId) return ''
  return context().cards.find(cardId)?.courseName ?? ''
}

export function registerMaterialsHandlers(): void {
  handle<unknown, MaterialItem[]>(CHANNELS.MATERIALS_LIST, () => context().materials.list())

  handle<MaterialImportInput, Promise<MaterialImportResult>>(
    CHANNELS.MATERIALS_IMPORT,
    async (raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
      const input = raw as MaterialImportInput
      const cardId = String(input.courseCardId ?? '')
      return context().materials.import(input, courseNameOf(cardId))
    }
  )

  // 收件箱导入：渲染层只报收件箱内的文件名，路径由主进程拼（safeJoin 锁死在收件箱里）
  handle<unknown, MaterialImportResult>(CHANNELS.MATERIALS_IMPORT_INBOX, async (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { fileNames?: unknown; courseCardId?: unknown; title?: unknown }
    const names = Array.isArray(input.fileNames) ? input.fileNames.map((n) => String(n)) : []
    if (names.length === 0) throw new Error('没有要导入的文件')
    const inbox = resolveInboxDir()
    const cardId = String(input.courseCardId ?? '')
    return context().materials.import(
      {
        paths: names.map((name) => safeJoin(inbox, name)),
        courseCardId: cardId,
        title: typeof input.title === 'string' ? input.title : undefined,
        sourcePolicy: 'recycle'
      },
      courseNameOf(cardId)
    )
  })

  handle<unknown, MaterialItem[]>(CHANNELS.MATERIALS_RENAME, async (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; title?: unknown }
    return context().materials.rename(input.id, String(input.title ?? ''))
  })

  handle<unknown, MaterialItem[]>(CHANNELS.MATERIALS_REMOVE, async (id) => {
    return context().materials.remove(id)
  })

  handle<unknown, MaterialItem[]>(CHANNELS.MATERIALS_SET_CARD, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { id?: unknown; courseCardId?: unknown }
    return context().materials.setCard(input.id, input.courseCardId)
  })

  // 打开 = 交给系统默认程序。库目录在笔记库内，天然被 pathOf 的 safeJoin 锁住
  handle<unknown, null>(CHANNELS.MATERIALS_OPEN, async (id) => {
    const item = context().materials.find(id)
    if (!item) throw new Error('资料不存在')
    const error = await shell.openPath(context().materials.pathOf(item.fileName))
    if (error) throw new Error(error)
    return null
  })

  handle<unknown, MaterialInboxCandidate[]>(CHANNELS.MATERIALS_UNREGISTERED, () => {
    return context().materials.unregistered()
  })

  handle<unknown, MaterialImportResult>(CHANNELS.MATERIALS_CLAIM, async (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as { fileName?: unknown; courseCardId?: unknown }
    const cardId = String(input.courseCardId ?? '')
    return context().materials.claim(String(input.fileName ?? ''), cardId, courseNameOf(cardId))
  })

  // 收件箱在下载目录下，不在「应用目录」白名单里，所以单独给一个打开通道。
  // 目录本身由主进程解析（safeJoin 锁不住绝对路径，但这里根本不接受外部路径）
  handle<unknown, null>(CHANNELS.MATERIALS_OPEN_INBOX, async () => {
    const error = await shell.openPath(resolveInboxDir())
    if (error) throw new Error(error)
    return null
  })

  handle<unknown, { canceled: boolean; paths: string[] }>(
    CHANNELS.DIALOG_PICK_MATERIALS,
    async () => {
      const result = await dialog.showOpenDialog({
        title: '导入课程资料',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [
          { name: '课程资料', extensions: [...MATERIAL_EXTENSIONS] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (result.canceled) return { canceled: true, paths: [] }
      return { canceled: false, paths: result.filePaths }
    }
  )
}

/* ------------------------------------------------------------------ 收件箱监控 */

/**
 * 收件箱监控：浏览器扩展把学校网站的下载改存进收件箱，
 * 这里发现新货就广播给渲染层弹归属对话框。
 *
 * 三个防线，全是从笔记文件监听（notesSync）那里学来的：
 *  - `awaitWriteFinish` 挡浏览器还在写的半截下载（.crdownload）
 *  - **不信事件类型**，防抖之后重扫整个目录，收集「白名单扩展名的现存文件」
 *  - 扩展名白名单再过滤一次——收件箱里放什么文件用户说了算，非资料类型不弹窗
 */
export function startMaterialsInboxWatch(): void {
  let timer: NodeJS.Timeout | null = null
  let lastSignature = ''
  let lastSentAt = 0

  const scanAndAnnounce = (): void => {
    timer = null
    try {
      const inbox = resolveInboxDir()
      const payload: MaterialInboxCandidate[] = []
      for (const name of readdirSync(inbox, { withFileTypes: true })) {
        if (!name.isFile() || name.name.startsWith('.')) continue
        const dot = name.name.lastIndexOf('.')
        if (dot < 0 || !isMaterialExtension(name.name.slice(dot + 1))) continue
        try {
          const stat = statSync(safeJoin(inbox, name.name))
          if (stat.size > 0) payload.push({ fileName: name.name, bytes: stat.size })
        } catch {
          /* 刚出现就被删掉，忽略 */
        }
      }
      if (payload.length === 0) return

      // 同一批文件短时间内不重复弹窗——渲染层的对话框还开着时会合并处理
      const signature = payload
        .map((item) => `${item.fileName}:${item.bytes}`)
        .sort()
        .join('|')
      const now = Date.now()
      if (signature === lastSignature && now - lastSentAt < 30_000) return
      lastSignature = signature
      lastSentAt = now

      console.info(`[materials] 收件箱发现 ${payload.length} 个待处理文件`)
      broadcast(CHANNELS.EVENT_MATERIALS_INBOX, { files: payload })
    } catch {
      /* 收件箱目录可能还不存在（用户还没装扩展），静默等下一次事件 */
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(scanAndAnnounce, 800)
  }

  const inbox = resolveInboxDir()
  watch(inbox, {
    // 应用没开着时攒下的文件不能错过，所以首扫不能依赖 ignoreInitial：
    // 渲染层的订阅要等 shell 引导完，这里给 3 秒再扫第一次
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  })
    .on('add', schedule)
    .on('change', schedule)
    .on('unlink', schedule)
  setTimeout(schedule, 3000)

  console.info(`[materials] 收件箱监控已启动：${inbox}`)
}
