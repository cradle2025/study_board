import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_PERIODS, DEFAULT_WEEKDAYS, MAX_PERIODS, MIN_PERIODS } from '@shared/limits'
import { DEFAULT_AI_PROVIDER } from '@shared/aiProviders'
import type { AppSettings, SettingsPatch } from '@shared/types'

import { configFile, dataRoot, defaultNotesLibraryDir, ensureDir } from '../paths'

export { DEFAULT_PERIODS, DEFAULT_WEEKDAYS, MAX_PERIODS, MIN_PERIODS }

function buildDefaults(portable: boolean): AppSettings {
  return {
    theme: 'system',
    language: 'zh-CN',
    // 空字符串表示「跟随数据目录」，用户手动改过才会写入绝对路径
    notesLibraryDir: defaultNotesLibraryDir(portable),
    portableMode: portable,
    editorMode: 'markdown',
    timetable: {
      mode: 'table',
      periodCount: DEFAULT_PERIODS,
      weekdays: [...DEFAULT_WEEKDAYS]
    },
    ai: {
      provider: DEFAULT_AI_PROVIDER.id,
      baseUrl: DEFAULT_AI_PROVIDER.baseUrl,
      model: DEFAULT_AI_PROVIDER.model,
      temperature: 0.3,
      hasApiKey: false
    },
    notion: {
      targetId: '',
      hasToken: false,
      lastSyncAt: null
    },
    // 空串 = 未配置，运行时按「系统下载目录 / StudyBoard收件箱」解析。
    // 默认值不能在这里写死：app.getPath('downloads') 在模块加载期拿不到稳定值
    materials: {
      inboxDir: ''
    }
  }
}

function clampPeriods(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, n))
}

export class SettingsStore {
  #file: string
  #cache: AppSettings

  constructor(portable: boolean) {
    ensureDir(dataRoot(portable))
    this.#file = configFile(portable)
    this.#cache = { ...buildDefaults(portable), ...this.#readRaw() }
    this.#cache.timetable = {
      ...buildDefaults(portable).timetable,
      ...this.#cache.timetable,
      periodCount: clampPeriods(this.#cache.timetable?.periodCount, DEFAULT_PERIODS)
    }
    this.#cache.notesLibraryDir = this.#resolveLibraryDir(this.#cache)
  }

  #readRaw(): Partial<AppSettings> {
    if (!existsSync(this.#file)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf-8'))
      if (parsed && typeof parsed === 'object') return parsed as Partial<AppSettings>
    } catch {
      // 配置文件损坏时不阻塞启动，直接用默认值重建
    }
    return {}
  }

  #resolveLibraryDir(next: AppSettings): string {
    const candidate = next.notesLibraryDir?.trim()
    if (candidate && candidate.length > 0) return candidate
    return defaultNotesLibraryDir(next.portableMode)
  }

  #persist(): void {
    const payload = { ...this.#cache }
    const tmp = `${this.#file}.tmp`
    ensureDir(ensureDir(dataRoot(this.#cache.portableMode)))
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
    // 先写临时文件再重命名，避免断电 / 崩溃写出半个文件
    renameSync(tmp, this.#file)
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 忽略 */
      }
    }
  }

  get(): Readonly<AppSettings> {
    return this.#cache
  }

  /** 重新读取磁盘上的配置（用于便携模式切换后） */
  reload(portable: boolean): AppSettings {
    this.#cache = { ...buildDefaults(portable), ...this.#readRaw() }
    this.#cache.portableMode = portable
    this.#cache.timetable = {
      ...buildDefaults(portable).timetable,
      ...this.#cache.timetable,
      periodCount: clampPeriods(this.#cache.timetable?.periodCount, DEFAULT_PERIODS)
    }
    this.#cache.notesLibraryDir = this.#resolveLibraryDir(this.#cache)
    this.#persist()
    return this.#cache
  }

  patch(patch: SettingsPatch): AppSettings {
    const next: AppSettings = {
      ...this.#cache,
      ...patch,
      timetable: patch.timetable
        ? { ...this.#cache.timetable, ...patch.timetable }
        : this.#cache.timetable,
      ai: patch.ai ? { ...this.#cache.ai, ...patch.ai } : this.#cache.ai,
      notion: patch.notion ? { ...this.#cache.notion, ...patch.notion } : this.#cache.notion,
      materials: patch.materials
        ? { ...this.#cache.materials, ...patch.materials }
        : this.#cache.materials
    }

    next.timetable.periodCount = clampPeriods(
      next.timetable.periodCount,
      this.#cache.timetable.periodCount
    )
    if (!Array.isArray(next.timetable.weekdays) || next.timetable.weekdays.length !== 8) {
      next.timetable.weekdays = [...DEFAULT_WEEKDAYS]
    }
    next.notesLibraryDir = this.#resolveLibraryDir(next)

    this.#cache = next
    this.#persist()
    return this.#cache
  }

  /** 让密钥存储模块把 hasApiKey / hasToken 回填进内存态（不落盘） */
  markSecretPresence(kind: 'ai' | 'notion', present: boolean): void {
    if (kind === 'ai') this.#cache.ai.hasApiKey = present
    else this.#cache.notion.hasToken = present
  }

  /** 数据目录变化时，把默认位置的配置整体搬到新目录 */
  migrateTo(portable: boolean): AppSettings {
    const previous = this.#cache
    const defaults = buildDefaults(portable)
    const nextFile = configFile(portable)
    const next: AppSettings = {
      ...defaults,
      ...previous,
      portableMode: portable,
      // 只有当用户之前用的是「默认位置」时才跟着切换
      notesLibraryDir:
        previous.notesLibraryDir === defaultNotesLibraryDir(previous.portableMode)
          ? defaults.notesLibraryDir
          : previous.notesLibraryDir
    }
    this.#cache = next
    ensureDir(dataRoot(portable))
    this.#file = nextFile
    this.#persist()
    return this.#cache
  }

  get filePath(): string {
    return this.#file
  }
}

/** 便捷函数：把设置里的笔记库目录解析成绝对路径 */
export function resolveNotesDir(settings: AppSettings): string {
  const dir = settings.notesLibraryDir?.trim()
  if (dir && dir.length > 0) return dir
  return defaultNotesLibraryDir(settings.portableMode)
}

/** 单文件导出用：便于外部工具做「重置设置」 */
export function resetSettingsFile(portable: boolean): void {
  const file = configFile(portable)
  if (existsSync(file)) unlinkSync(file)
}

export function settingsBackupName(): string {
  return join(dataRoot(false), 'config.backup.json')
}
