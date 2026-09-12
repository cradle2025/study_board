import { dialog } from 'electron'
import { isAbsolute, resolve } from 'node:path'

import { CHANNELS } from '@shared/channels'
import type {
  AiPatch,
  AppSettings,
  NotionPatch,
  SettingsPatch,
  TimetablePatch
} from '@shared/types'

import { context, refreshBuckets } from '../context'
import { ensureDir } from '../paths'
import { MAX_PERIODS, MIN_PERIODS, resolveNotesDir } from '../services/settings'
import { broadcast, handle } from './index'
import { restartNotesSync } from './notes'

/**
 * 设置相关的 IPC。
 * 入参一律当成不可信数据做白名单校验：不认识的键直接丢弃，
 * 数值做范围收敛，路径必须是绝对路径。
 */

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} 取值不合法`)
  }
  return value as T
}

function asString(value: unknown, maxLength = 4096): string {
  return String(value ?? '').slice(0, maxLength)
}

function asUrl(value: unknown): string {
  const raw = asString(value, 2048).trim()
  if (!raw) return ''
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('只支持 http / https 地址')
  }
  return parsed.toString()
}

function sanitizePatch(raw: unknown): SettingsPatch {
  if (!raw || typeof raw !== 'object') throw new Error('设置参数不合法')
  const input = raw as Record<string, unknown>
  const patch: SettingsPatch = {}

  if ('theme' in input) {
    patch.theme = assertEnum(input.theme, ['system', 'light', 'dark'] as const, 'theme')
  }
  if ('language' in input) {
    patch.language = assertEnum(input.language, ['zh-CN', 'en-US'] as const, 'language')
  }
  if ('editorMode' in input) {
    patch.editorMode = assertEnum(
      input.editorMode,
      ['markdown', 'richtext'] as const,
      'editorMode'
    )
  }
  if ('portableMode' in input) {
    patch.portableMode = Boolean(input.portableMode)
  }
  if ('notesLibraryDir' in input) {
    const dir = asString(input.notesLibraryDir, 1024).trim()
    if (dir && !isAbsolute(dir)) throw new Error('笔记库目录必须是绝对路径')
    patch.notesLibraryDir = dir
  }
  if ('timetable' in input && input.timetable && typeof input.timetable === 'object') {
    const t = input.timetable as Record<string, unknown>
    const timetable: TimetablePatch = {}
    if ('mode' in t) {
      timetable.mode = assertEnum(t.mode, ['image', 'table'] as const, 'timetable.mode')
    }
    if ('periodCount' in t) {
      const n = Number(t.periodCount)
      if (!Number.isFinite(n)) throw new Error('节数必须是数字')
      timetable.periodCount = Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, Math.trunc(n)))
    }
    if ('weekdays' in t) {
      if (!Array.isArray(t.weekdays) || t.weekdays.length !== 8) {
        throw new Error('表头必须是 8 列')
      }
      timetable.weekdays = t.weekdays.map((d) => asString(d, 24) || '—')
    }
    patch.timetable = timetable
  }
  if ('ai' in input && input.ai && typeof input.ai === 'object') {
    const a = input.ai as Record<string, unknown>
    const ai: AiPatch = {}
    // 预设 id。**不按白名单校验**：它是拿来做查找用的（决定要不要密钥、
    // 给模型名当候选），不认识的值落到「无预设」这条路上，不影响任何功能。
    // 真正会影响行为的是下面的 baseUrl 与 model，那两个才是必须卡死的。
    if ('provider' in a) ai.provider = asString(a.provider, 64).trim().replace(/[^\w.-]/g, '')
    if ('baseUrl' in a) ai.baseUrl = asUrl(a.baseUrl)
    if ('model' in a) ai.model = asString(a.model, 128).trim()
    if ('temperature' in a) {
      const t = Number(a.temperature)
      if (!Number.isFinite(t)) throw new Error('temperature 必须是数字')
      ai.temperature = Math.min(2, Math.max(0, t))
    }
    patch.ai = ai
  }
  if ('notion' in input && input.notion && typeof input.notion === 'object') {
    const n = input.notion as Record<string, unknown>
    const notion: NotionPatch = {}
    if ('targetId' in n) notion.targetId = asString(n.targetId, 128).trim()
    patch.notion = notion
  }

  return patch
}

/**
 * 设置改完之后统一收尾。
 *
 * 三个设置入口都会走到这里，但**只有真的换了笔记库目录时**才去重接文件监听：
 * 改个主题、调下节数也会走这条路，每次都重接的话会顺手推一个 reset，
 * 笔记页正在编辑的那篇会被莫名其妙地放掉。
 */
function refreshBucketsAndResync(): void {
  const before = context().notes.dir
  refreshBuckets()
  if (context().notes.dir !== before) restartNotesSync()
}

export function registerSettingsHandlers(): void {
  handle<unknown, AppSettings>(CHANNELS.SETTINGS_GET, () => {
    return structuredClone(context().settings.get()) as AppSettings
  })

  handle<unknown, AppSettings>(CHANNELS.SETTINGS_PATCH, (raw) => {
    const patch = sanitizePatch(raw)
    const next = context().settings.patch(patch)
    refreshBucketsAndResync()
    broadcast(CHANNELS.EVENT_SETTINGS_CHANGED, next)
    return structuredClone(next) as AppSettings
  })

  handle<unknown, AppSettings>(CHANNELS.SETTINGS_CHOOSE_LIBRARY, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择笔记库目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return structuredClone(context().settings.get()) as AppSettings
    }
    const picked = resolve(result.filePaths[0] as string)
    ensureDir(picked)
    const next = context().settings.patch({ notesLibraryDir: picked })
    refreshBucketsAndResync()
    broadcast(CHANNELS.EVENT_SETTINGS_CHANGED, next)
    return structuredClone(next) as AppSettings
  })

  handle<unknown, AppSettings>(CHANNELS.SETTINGS_RESET_LIBRARY, () => {
    const settings = context().settings.get()
    const next = context().settings.patch({ notesLibraryDir: '' })
    ensureDir(resolveNotesDir(next))
    refreshBucketsAndResync()
    broadcast(CHANNELS.EVENT_SETTINGS_CHANGED, next)
    console.info(`[settings] 笔记库已回退到默认位置（原目录：${settings.notesLibraryDir}）`)
    return structuredClone(next) as AppSettings
  })
}
