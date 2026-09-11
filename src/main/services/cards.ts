import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { MAX_CARDS, MAX_CARD_LEVEL, MAX_CARD_LONG, MAX_CARD_TEXT } from '@shared/limits'
import type { CourseCard, CourseCardInput } from '@shared/types'

import { ensureDir, newId } from '../paths'

/**
 * 课程卡片存储。
 *
 * 与课表 / 门户同一套规矩：单个 JSON、原子写入、坏了就备份重建。
 *
 * 卡片是「课程」的一个侧面记录（打分、难度、掌握程度、给分标准、课程结构），
 * 它**不复制课表里的课程信息**，而是靠 `noteId` 连到一篇笔记上——
 * 同一门课在课表和卡片里各存一份名字，迟早会出现两边对不上。
 */

const CONFIG_VERSION = 1

interface CardsContent {
  version: number
  cards: CourseCard[]
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/** 打分是自由文本（"95" / "A" / "优秀" 都合法），只做长度与空白清洗 */
function score(value: unknown): string {
  return text(value, MAX_CARD_TEXT)
}

/** 难度 / 掌握程度：1–5，0 表示没填；非法值一律按没填处理 */
function level(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > MAX_CARD_LEVEL) return 0
  return n
}

function long(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_CARD_LONG)
}

function sanitizeCard(raw: unknown, index: number): CourseCard | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const id = String(input['id'] ?? '').trim()
  const courseName = text(input['courseName'], MAX_CARD_TEXT)
  if (!id || courseName.length === 0) return null

  const now = new Date().toISOString()
  return {
    id: id.slice(0, 64),
    courseName,
    teacher: text(input['teacher'], MAX_CARD_TEXT),
    score: score(input['score']),
    difficulty: level(input['difficulty']),
    mastery: level(input['mastery']),
    gradingPolicy: long(input['gradingPolicy']),
    outline: long(input['outline']),
    noteId: text(input['noteId'], 64),
    order: Number.isFinite(Number(input['order'])) ? Math.trunc(Number(input['order'])) : index,
    createdAt: String(input['createdAt'] ?? '') || now,
    updatedAt: String(input['updatedAt'] ?? '') || now
  }
}

function sanitizeContent(raw: unknown): CardsContent {
  const input = (raw ?? {}) as Record<string, unknown>
  const cards: CourseCard[] = []

  if (Array.isArray(input['cards'])) {
    for (let i = 0; i < input['cards'].length && cards.length < MAX_CARDS; i += 1) {
      const card = sanitizeCard(input['cards'][i], i)
      if (card) cards.push(card)
    }
  }
  return { version: CONFIG_VERSION, cards }
}

export class CardsStore {
  #file: string
  #content: CardsContent

  constructor(file: string) {
    this.#file = file
    ensureDir(dirname(file))
    this.#content = this.#load()
  }

  #load(): CardsContent {
    if (!existsSync(this.#file)) return { version: CONFIG_VERSION, cards: [] }
    try {
      return sanitizeContent(JSON.parse(readFileSync(this.#file, 'utf-8')))
    } catch (error) {
      console.error('[cards] 卡片文件解析失败，已备份并重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败也不能因此启动不了 */
      }
      return { version: CONFIG_VERSION, cards: [] }
    }
  }

  #persist(): void {
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#content, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  #nextOrder(): number {
    let max = -1
    for (const card of this.#content.cards) max = Math.max(max, card.order)
    return max + 1
  }

  list(): CourseCard[] {
    return structuredClone(this.#content.cards).sort((a, b) => a.order - b.order)
  }

  find(id: unknown): CourseCard | null {
    const target = String(id ?? '')
    return this.#content.cards.find((card) => card.id === target) ?? null
  }

  /**
   * 新建或更新。
   *
   * 刻意**不在这里创建笔记**：卡片与笔记的联动需要同时操作两个存储，
   * 放在 IPC 层编排更好——那里两个 store 都在手边，出错也更容易回滚。
   */
  upsert(input: CourseCardInput): CourseCard {
    const courseName = text(input?.courseName, MAX_CARD_TEXT)
    if (courseName.length === 0) throw new Error('请填写课程名称')

    const now = new Date().toISOString()
    const id = String(input?.id ?? '').trim()
    const existing = id ? this.find(id) : null

    if (existing) {
      existing.courseName = courseName
      existing.teacher = text(input?.teacher, MAX_CARD_TEXT)
      existing.score = score(input?.score)
      existing.difficulty = level(input?.difficulty)
      existing.mastery = level(input?.mastery)
      existing.gradingPolicy = long(input?.gradingPolicy)
      existing.outline = long(input?.outline)
      existing.updatedAt = now
      this.#persist()
      return structuredClone(existing)
    }

    if (this.#content.cards.length >= MAX_CARDS) {
      throw new Error(`最多只能建 ${MAX_CARDS} 张卡片`)
    }

    const card: CourseCard = {
      id: newId(),
      courseName,
      teacher: text(input?.teacher, MAX_CARD_TEXT),
      score: score(input?.score),
      difficulty: level(input?.difficulty),
      mastery: level(input?.mastery),
      gradingPolicy: long(input?.gradingPolicy),
      outline: long(input?.outline),
      noteId: '',
      order: this.#nextOrder(),
      createdAt: now,
      updatedAt: now
    }
    this.#content.cards.push(card)
    this.#persist()
    return structuredClone(card)
  }

  /** 关联笔记。由 IPC 层在「卡片创建 → 笔记创建」之后调用 */
  linkNote(id: unknown, noteId: string): void {
    const card = this.find(id)
    if (!card) return
    card.noteId = noteId
    card.updatedAt = new Date().toISOString()
    this.#persist()
  }

  remove(id: unknown): CourseCard[] {
    const target = String(id ?? '')
    const before = this.#content.cards.length
    this.#content.cards = this.#content.cards.filter((card) => card.id !== target)
    if (this.#content.cards.length !== before) this.#persist()
    return this.list()
  }

  /** 按传入的 id 顺序重排；没提到的卡片保持相对顺序排在后面 */
  reorder(ids: readonly string[]): CourseCard[] {
    const order = new Map<string, number>()
    ids.forEach((id, index) => order.set(String(id), index))

    let tail = order.size
    this.#content.cards.sort((a, b) => {
      const left = order.get(a.id)
      const right = order.get(b.id)
      if (left === undefined && right === undefined) return a.order - b.order
      if (left === undefined) return 1
      if (right === undefined) return -1
      return left - right
    })
    for (const card of this.#content.cards) {
      card.order = order.get(card.id) ?? tail++
    }

    this.#persist()
    return this.list()
  }

  /** 笔记被删掉时，把指向它的卡片解除关联，而不是留一个断掉的 noteId */
  unlinkNote(noteId: string): number {
    let changed = 0
    for (const card of this.#content.cards) {
      if (card.noteId !== noteId) continue
      card.noteId = ''
      changed += 1
    }
    if (changed > 0) this.#persist()
    return changed
  }

  get filePath(): string {
    return this.#file
  }
}
