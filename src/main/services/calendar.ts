import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isIsoDate, isTime } from '@shared/calendar'
import {
  MAX_CALENDAR_EVENTS,
  MAX_EVENT_LOCATION,
  MAX_EVENT_NOTE,
  MAX_EVENT_TITLE,
  MAX_REMIND_MINUTES
} from '@shared/limits'
import type { CalendarEvent, CalendarRepeat } from '@shared/types'

import { ensureDir, newId } from '../paths'

/**
 * 日历 / 日程存储。
 *
 * 落盘格式：单个 `calendar.json`，原子写入（先写 .tmp 再 rename）——
 * 与课表、门户、卡片同一套做法，理由也一样：内容量小，纯 JSON
 * 更好人工查看、更好进 Git。
 *
 * **这是一个纯新增的文件**，没有动任何既有存储的读写格式，所以
 * `DATA_SCHEMA` 不需要递增（判据见 `dataVersion.ts` 顶部那段）。
 * 但必须在 `LEGACY_DATA_ENTRIES` 里登记，否则 `hasUserData()` 认不出
 * 「只有日程、没有其它文件」的老数据目录，会把老用户当全新安装——
 * 表现就是每次启动都少一次备份，而这个坑项目里踩过（见 HANDOFF 坑位区）。
 */

const CONFIG_VERSION = 1

const REPEATS: readonly CalendarRepeat[] = ['once', 'weekly', 'monthly']

export interface CalendarContent {
  version: number
  semesterStart: string
  events: CalendarEvent[]
}

function emptyContent(): CalendarContent {
  return { version: CONFIG_VERSION, semesterStart: '', events: [] }
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function sanitizeRepeat(value: unknown): CalendarRepeat {
  return REPEATS.includes(value as CalendarRepeat) ? (value as CalendarRepeat) : 'once'
}

/**
 * 提前量收敛到 -1 或 0–MAX_REMIND_MINUTES。
 *
 * 认不出来时回落 `-1`（不提醒）而不是 `0`（到点提醒）：凭空多出来的
 * 提醒会打扰用户，而少一条提醒只是没帮忙——两者都不理想，但前者
 * 是「程序主动做错事」，后者只是「没做」。
 */
function clampRemind(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return -1
  return Math.min(MAX_REMIND_MINUTES, n)
}

/**
 * 读磁盘路径的校验。
 *
 * 日期非法 / 没有 id 一律丢弃：日期是所有「这条日程哪天出现」的
 * 全部依据，id 是增删改的依据，缺了它们这条记录就没法被正确对待。
 * 宁可不显示，也不要猜一个日期猜错了把日程摆到错误的那天。
 */
function sanitizeEvent(raw: unknown): CalendarEvent | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = String(input['id'] ?? '').trim().slice(0, 64)
  if (id === '') return null

  const date = String(input['date'] ?? '').trim()
  if (!isIsoDate(date)) return null

  const createdAt = String(input['createdAt'] ?? '') || new Date().toISOString()
  return {
    id,
    title: text(input['title'], MAX_EVENT_TITLE),
    date,
    start: isTime(input['start']) ? String(input['start']) : '',
    end: isTime(input['end']) ? String(input['end']) : '',
    location: text(input['location'], MAX_EVENT_LOCATION),
    note: text(input['note'], MAX_EVENT_NOTE),
    repeat: sanitizeRepeat(input['repeat']),
    remindBefore: clampRemind(input['remindBefore']),
    createdAt,
    updatedAt: String(input['updatedAt'] ?? '') || createdAt
  }
}

function sanitizeContent(raw: unknown): CalendarContent {
  const input = (raw ?? {}) as Record<string, unknown>
  const result = emptyContent()

  const semesterStart = String(input['semesterStart'] ?? '').trim()
  result.semesterStart = isIsoDate(semesterStart) ? semesterStart : ''

  if (Array.isArray(input['events'])) {
    for (const item of input['events']) {
      const event = sanitizeEvent(item)
      if (event) result.events.push(event)
      if (result.events.length >= MAX_CALENDAR_EVENTS) break
    }
  }

  return result
}

/** 写入路径的读取。与读磁盘分开：写的时候允许没有 id（那是「新增一条」） */
function readEventInput(raw: unknown): Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> & {
  id: string
} {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    id: String(input['id'] ?? '').trim().slice(0, 64),
    title: text(input['title'], MAX_EVENT_TITLE),
    date: String(input['date'] ?? '').trim(),
    start: isTime(input['start']) ? String(input['start']) : '',
    end: isTime(input['end']) ? String(input['end']) : '',
    location: text(input['location'], MAX_EVENT_LOCATION),
    note: text(input['note'], MAX_EVENT_NOTE),
    repeat: sanitizeRepeat(input['repeat']),
    remindBefore: clampRemind(input['remindBefore'])
  }
}

function sameEvent(left: CalendarEvent, right: ReturnType<typeof readEventInput>): boolean {
  return (
    left.title === right.title &&
    left.date === right.date &&
    left.start === right.start &&
    left.end === right.end &&
    left.location === right.location &&
    left.note === right.note &&
    left.repeat === right.repeat &&
    left.remindBefore === right.remindBefore
  )
}

export class CalendarStore {
  #file: string
  #content: CalendarContent

  constructor(file: string) {
    this.#file = file
    ensureDir(dirname(file))
    this.#content = this.#load()
  }

  #load(): CalendarContent {
    if (!existsSync(this.#file)) return emptyContent()
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf-8'))
      return sanitizeContent(parsed)
    } catch (error) {
      // 与课表一致：损坏时不阻塞启动，备份现场后用空内容继续
      console.error('[calendar] 日程文件解析失败，已备份并重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败就算了，不能因此启动不了 */
      }
      return emptyContent()
    }
  }

  #persist(): void {
    const payload = JSON.stringify(this.#content, null, 2)
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  /** 只读快照（深拷贝，避免调用方改到内部状态） */
  get(): CalendarContent {
    return structuredClone(this.#content)
  }

  /**
   * 学期开学日。
   *
   * 传空串表示清除。非法日期**抛错**而不是静默忽略：开学日直接决定
   * 每一门课落在日历的哪一天，静默忽略会让用户以为「保存成功了」，
   * 而日历上什么都没有。
   */
  setSemesterStart(value: unknown): void {
    const raw = String(value ?? '').trim()
    if (raw === '') {
      if (this.#content.semesterStart === '') return
      this.#content.semesterStart = ''
      this.#persist()
      return
    }
    if (!isIsoDate(raw)) throw new Error('开学日必须是 YYYY-MM-DD 格式的合法日期')
    if (this.#content.semesterStart === raw) return
    this.#content.semesterStart = raw
    this.#persist()
  }

  /**
   * 新增或修改一条日程。
   *
   * 带 `id` 且找得到 → 替换那一条；找不到或没带 → 新增。
   * 标题为空时**拒绝**：日历格子里只显示得下标题，没有标题的日程
   * 在界面上就是一个点不开也认不出的方块。
   */
  upsertEvent(raw: unknown): void {
    const input = readEventInput(raw)
    if (input.title === '') throw new Error('日程标题不能为空')
    if (!isIsoDate(input.date)) throw new Error('日程日期必须是 YYYY-MM-DD 格式的合法日期')

    const now = new Date().toISOString()
    const index = input.id === '' ? -1 : this.#content.events.findIndex((e) => e.id === input.id)

    if (index >= 0) {
      const current = this.#content.events[index] as CalendarEvent
      if (sameEvent(current, input)) return
      this.#content.events[index] = {
        ...input,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: now
      }
      this.#persist()
      return
    }

    if (this.#content.events.length >= MAX_CALENDAR_EVENTS) {
      throw new Error(`日程最多 ${MAX_CALENDAR_EVENTS} 条`)
    }
    this.#content.events.push({
      ...input,
      id: input.id || newId(),
      createdAt: now,
      updatedAt: now
    })
    this.#persist()
  }

  removeEvent(id: unknown): void {
    const target = String(id ?? '').trim()
    if (target === '') throw new Error('缺少日程 id')
    const index = this.#content.events.findIndex((event) => event.id === target)
    if (index < 0) return
    this.#content.events.splice(index, 1)
    this.#persist()
  }

  get filePath(): string {
    return this.#file
  }
}
