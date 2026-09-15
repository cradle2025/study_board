import { MAX_TIMETABLE_IMAGES, MAX_WEEK_COUNT } from '@shared/limits'
import type { CourseImage, TimetableCell, TimetableData, WeekRule } from '@shared/types'

import { getLang, t } from '../lib/i18n'
import { assetUrl } from '../lib/asset'
import { escapeHtml } from '../lib/html'
import { openLightbox, showFloating } from '../lib/overlay'
import { markLimited } from '../lib/perf'

/**
 * 课程表面板：表格模式与图片模式的统一渲染器。
 *
 * 概览页与课程表编辑页共用同一个面板，区别只在于是否允许编辑——
 * 这样「打开即见课表」和「编辑课表」看到的永远是同一份东西，
 * 不会出现两处渲染逻辑各写一套、久了就不一致的经典问题。
 *
 * 交互约定（来自产品需求）：
 *  - 悬停  → 浮出预览卡，显示这一格的完整信息
 *  - 双击  → 就地编辑
 *  - 键盘  → 单元格可 Tab 聚焦，回车 / 空格同样能打开编辑
 *
 * 一格可以并存多门课（按周次区分），所以编辑器有两种形态：
 *  - **列表**：这一格已有多门课时，先列出来，每门可单独编辑 / 删除；
 *  - **表单**：编辑其中一门，或新增一门。空格子直接进表单，少一次点击。
 */

const HOVER_DELAY = 170

export interface TimetablePanelOptions {
  /** 是否允许编辑（双击单元格、增删换图片） */
  editable: boolean
  /** 保存一格里的**一门课**；传 null 表示清空整格 */
  onSaveCell(key: string, cell: TimetableCell | null): Promise<void>
  /** 按 id 删掉一格里的**某一门课**，同格其它课不动 */
  onRemoveCell(key: string, id: string): Promise<void>
  /** 把「上一节」那一格的所有课一次性复制到这一格（批量写入） */
  onCopyPrevious(key: string, source: TimetableCell[]): Promise<void>
  /** 添加课表照片（由视图层调起文件对话框） */
  onAddImages(): Promise<void>
  /** 替换某张照片 */
  onReplaceImage(id: string): Promise<void>
  /** 删除某张照片 */
  onRemoveImage(id: string): Promise<void>
}

export interface TimetablePanelHandle {
  element: HTMLElement
  /**
   * 重绘。
   *
   * `hint` 用于告诉面板「这次只有这一个格子变了」——此时只重画那一个 `<td>`，
   * 不重建整张表。保存单元格是最高频的写操作，走这条路径能省掉
   * 整表 77~140 个节点的销毁与重建。
   * 结构变化（换模式、改节数）或任何不确定的情况都穿 full 路径，保证正确性。
   */
  render(data: TimetableData, hint?: RenderHint): void
  /** 供单元测试 / 冒烟测试打点 */
  isEmpty(): boolean
  /** 解绑全局事件，路由切走时必须调用 */
  dispose(): void
}

export interface RenderHint {
  kind: 'cell'
  key: string
}

// 拼地址的实现搬去了 lib/asset（笔记里显示图片也要用同一份）。
// 这里 import 进来自己用，同时转出去，免得已有的引用全要改一遍。
export { assetUrl }

function formatBytes(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------ 周次规则 */

/**
 * 这门课在第 week 周上不上。
 *
 * `week <= 0` 表示「不按周次过滤」（看全部），此时一律算上——
 * 「全部」是一个视图状态，不是一种周次规则，所以在这里短路，
 * 而不是往 WeekRule 里再加一个 kind。
 */
export function weeksInclude(rule: WeekRule, week: number): boolean {
  if (week <= 0) return true
  switch (rule.kind) {
    case 'all':
      return true
    case 'odd':
      return week % 2 === 1
    case 'even':
      return week % 2 === 0
    case 'list':
      return rule.weeks.includes(week)
  }
}

/** 这一格里在当前查看周次下应该显示的课 */
export function visibleCourses(list: readonly TimetableCell[] | undefined, week: number): TimetableCell[] {
  if (!list) return []
  return list.filter((cell) => weeksInclude(cell.weeks, week))
}

/** 角标上的短文案。规则是「每周」时不显示角标，保持格子干净 */
function weekBadge(rule: WeekRule): string {
  switch (rule.kind) {
    case 'all':
      return ''
    case 'odd':
      return t('timetable.week.odd')
    case 'even':
      return t('timetable.week.even')
    case 'list': {
      const shown = rule.weeks.slice(0, 4).join(',')
      return rule.weeks.length > 4 ? `${shown}…` : shown
    }
  }
}

/** 角标的完整说明（悬停提示 / 无障碍名称） */
function weekTitle(rule: WeekRule): string {
  switch (rule.kind) {
    case 'all':
      return t('timetable.week.all')
    case 'odd':
      return t('timetable.week.oddFull')
    case 'even':
      return t('timetable.week.evenFull')
    case 'list':
      return t('timetable.week.listFull', { weeks: rule.weeks.join(', ') })
  }
}

/**
 * 把「1,3,5」「1-8」这类输入解析成周次数组。
 *
 * 认不出的片段直接忽略而不是报错：用户边打边看，「1,3,」这种中间态
 * 很常见，为此弹一个错误提示属于打扰。最终一个都没解析出来时，
 * 保存前会拦下来（见 collectForm）。
 */
export function parseWeekList(raw: string, weekCount: number): number[] {
  const out = new Set<number>()
  const push = (value: number): void => {
    if (Number.isInteger(value) && value >= 1 && value <= weekCount) out.add(value)
  }
  for (const part of raw.split(/[,，、\s]+/)) {
    if (part === '') continue
    const range = /^(\d+)\s*[-–~—]\s*(\d+)$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      for (let week = Math.min(a, b); week <= Math.max(a, b); week += 1) push(week)
      continue
    }
    if (/^\d+$/.test(part)) push(Number(part))
  }
  return [...out].sort((a, b) => a - b)
}

/* ------------------------------------------------------------ 单元格渲染 */

function cellSummary(cell: TimetableCell): { name: string; meta: string } {
  const metaParts = [cell.teacher, cell.location].filter((part) => part.length > 0)
  return { name: cell.courseName, meta: metaParts.join(' · ') }
}

function isBlankCell(cell: TimetableCell): boolean {
  return (
    cell.courseName === '' &&
    cell.teacher === '' &&
    cell.location === '' &&
    cell.duration === '' &&
    cell.remark === ''
  )
}

/** 单元格坐标 key → 人类可读的位置描述 */
function describeKey(key: string, weekdays: readonly string[]): string {
  const [periodRaw, columnRaw] = key.split(':')
  const period = Number(periodRaw)
  const column = Number(columnRaw)
  const weekday = weekdays[column + 1] ?? t('timetable.columnN', { n: column + 1 })
  return t('timetable.cellLabel', { period, weekday })
}

/**
 * 已录入过的课程，按课程名去重。
 *
 * 用途是**连堂**：同一门课连着上两节（甚至三节），后面那几格不该再手打
 * 一遍。老师/地点取第一次出现的那份 —— 同一门课在不同格子里老师一般
 * 不会变；真变了用户手改一下就行，比要求他重复输入二十遍强。
 *
 * 排序按当前语言：英文界面里用中文的排序规则排英文课名会很怪。
 */
function knownCourses(cells: Record<string, TimetableCell[]>): TimetableCell[] {
  const seen = new Map<string, TimetableCell>()
  for (const list of Object.values(cells)) {
    for (const cell of list) {
      const name = cell.courseName.trim()
      if (name === '' || seen.has(name)) continue
      seen.set(name, cell)
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.courseName.localeCompare(b.courseName, getLang())
  )
}

/** 下拉里那一行：「高等数学 A · 王海 · 三教 201」——空的部分不占位 */
function courseOptionLabel(course: TimetableCell): string {
  return [course.courseName, course.teacher, course.location]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' · ')
}

function cellLabel(
  key: string,
  courses: readonly TimetableCell[],
  weekdays: readonly string[]
): string {
  const where = describeKey(key, weekdays)
  if (courses.length === 0) return `${where}：${t('timetable.cellEmpty')}`
  if (courses.length === 1) {
    const summary = cellSummary(courses[0] as TimetableCell)
    return `${where}：${summary.name || t('timetable.unnamedCourse')}`
  }
  return `${where}：${t('timetable.cellCourseCount', { count: courses.length })}`
}

/**
 * 单元格内容。
 *
 * 整表渲染与单格重绘都调它——只有一份模板，就不会出现
 * 「整表刷新和局部刷新长得不一样」这种迟早会发生的偏差。
 * 一格多门课时按顺序堆叠，每门带自己的周次角标。
 */
function cellInnerHtml(courses: readonly TimetableCell[]): string {
  if (courses.length === 0) {
    return '<span class="sb-timetable__add" aria-hidden="true">＋</span>'
  }
  return courses
    .map((cell) => {
      const summary = cellSummary(cell)
      const meta = summary.meta
        ? `<span class="sb-ttcell__meta">${escapeHtml(summary.meta)}</span>`
        : ''
      const badge = weekBadge(cell.weeks)
      const badgeHtml = badge
        ? `<span class="sb-ttcell__week" title="${escapeHtml(weekTitle(cell.weeks))}">${escapeHtml(badge)}</span>`
        : ''
      return `<span class="sb-ttcell">${badgeHtml}<span class="sb-ttcell__name">${escapeHtml(
        summary.name || t('timetable.unnamedCourse')
      )}</span>${meta}</span>`
    })
    .join('')
}

export function createTimetablePanel(options: TimetablePanelOptions): TimetablePanelHandle {
  const element = document.createElement('div')
  element.className = 'sb-ttpanel'
  const body = document.createElement('div')
  body.className = 'sb-ttpanel__body'
  element.appendChild(body)

  let data: TimetableData | null = null
  let hoverTimer = 0
  let closeHover: (() => void) | null = null
  let closeEditor: (() => void) | null = null

  /* ------------------------------------------------------------ 悬停预览 */

  function cancelHover(): void {
    if (hoverTimer) {
      window.clearTimeout(hoverTimer)
      hoverTimer = 0
    }
  }

  function hideHover(): void {
    cancelHover()
    closeHover?.()
    closeHover = null
  }

  /** 这一格在当前查看周次下可见的课 */
  function shownAt(key: string, current: TimetableData): TimetableCell[] {
    return visibleCourses(current.cells[key], current.currentWeek)
  }

  function scheduleHover(cell: HTMLTableCellElement, key: string): void {
    if (!data) return
    const courses = shownAt(key, data)
    if (courses.length === 0) return

    cancelHover()
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0
      // 位置留到真正要显示时才测：鼠标扫过一排空格子时不会每次都触发
      // 一次强制布局，拿到的手也永远是最新的（滚动中不会偏）
      if (!cell.isConnected) return
      closeHover?.()
      const handle = showFloating({
        className: 'sb-tt-preview',
        anchor: cell.getBoundingClientRect(),
        closeOnOutsideClick: false,
        closeOnEscape: false
      })
      handle.element.innerHTML = renderPreview(courses, describeKey(key, data?.weekdays ?? []))
      closeHover = handle.close
    }, HOVER_DELAY)
  }

  function renderPreview(courses: readonly TimetableCell[], where: string): string {
    const blocks = courses.map((cell) => {
      const rows: string[] = []
      const push = (label: string, value: string): void => {
        if (!value) return
        rows.push(
          `<div class="sb-tt-preview__row"><span class="sb-tt-preview__label">${escapeHtml(label)}</span><span class="sb-tt-preview__value">${escapeHtml(value)}</span></div>`
        )
      }
      push(t('timetable.field.teacher'), cell.teacher)
      push(t('timetable.field.location'), cell.location)
      push(t('timetable.field.duration'), cell.duration)
      push(t('timetable.field.remark'), cell.remark)
      push(t('timetable.field.weeks'), weekTitle(cell.weeks))

      return `
        <div class="sb-tt-preview__course">
          <div class="sb-tt-preview__title">${escapeHtml(cell.courseName || t('timetable.unnamedCourse'))}</div>
          ${rows.length > 0 ? `<div class="sb-tt-preview__rows">${rows.join('')}</div>` : ''}
        </div>
      `
    })

    return `
      <div class="sb-tt-preview__head">
        <span class="sb-tt-preview__where">${escapeHtml(where)}</span>
        <span class="sb-tt-preview__hint">${escapeHtml(t('timetable.dblclickEdit'))}</span>
      </div>
      ${blocks.join('')}
    `
  }

  /* ------------------------------------------------------------ 编辑弹层 */

  function emptyCell(): TimetableCell {
    return {
      id: '',
      courseName: '',
      teacher: '',
      location: '',
      duration: '',
      remark: '',
      weeks: { kind: 'all' }
    }
  }

  function openEditor(cell: HTMLTableCellElement, key: string): void {
    if (!options.editable || !data) return
    hideHover()
    closeEditor?.()

    const handle = showFloating({
      className: 'sb-tt-editor',
      anchor: cell.getBoundingClientRect(),
      closeOnOutsideClick: false,
      closeOnEscape: false
    })

    const current = (): TimetableCell[] => data?.cells[key] ?? []

    const close = (): void => {
      closeEditor = null
      handle.close()
    }

    /**
     * 这一格里「上一节」的课（同一天、上一节）。连堂就长这样：
     * 表格里是上下相邻的两格。
     */
    const previousCourses = (): TimetableCell[] => {
      const [periodRaw, columnRaw] = key.split(':')
      const previousKey = `${Number(periodRaw) - 1}:${columnRaw}`
      return (data?.cells[previousKey] ?? []).filter((item) => !isBlankCell(item))
    }

    /* ---------------------------------------------------------- 列表形态 */

    function renderList(): void {
      const courses = current()
      if (courses.length === 0) {
        renderForm(emptyCell())
        return
      }

      const previous = previousCourses()
      handle.element.dataset['mode'] = 'list'
      handle.element.innerHTML = `
        <div class="sb-tt-editor__head">
          <span>${escapeHtml(describeKey(key, data?.weekdays ?? []))}</span>
          <button class="sb-tt-editor__close" type="button" aria-label="${escapeHtml(t('common.close'))}">✕</button>
        </div>
        <div class="sb-tt-editor__body">
          <ul class="sb-tt-editor__list">
            ${courses
              .map(
                (course) => `
              <li class="sb-tt-course" data-id="${escapeHtml(course.id)}">
                <div class="sb-tt-course__main">
                  ${weekBadge(course.weeks) ? `<span class="sb-ttcell__week">${escapeHtml(weekBadge(course.weeks))}</span>` : ''}
                  <span class="sb-tt-course__name">${escapeHtml(course.courseName || t('timetable.unnamedCourse'))}</span>
                  <span class="sb-tt-course__meta">${escapeHtml(courseOptionLabel(course))}</span>
                </div>
                <div class="sb-tt-course__actions">
                  <button class="sb-btn sb-btn--ghost" type="button" data-role="edit-course" data-id="${escapeHtml(course.id)}">${escapeHtml(t('common.edit'))}</button>
                  <button class="sb-btn sb-btn--ghost" type="button" data-role="remove-course" data-id="${escapeHtml(course.id)}">${escapeHtml(t('common.delete'))}</button>
                </div>
              </li>`
              )
              .join('')}
          </ul>
        </div>
        <div class="sb-tt-editor__actions">
          <button class="sb-btn sb-btn--ghost" type="button" data-role="add-course">${escapeHtml(t('timetable.addAnother'))}</button>
          ${
            previous.length > 0
              ? `<button class="sb-btn sb-btn--ghost" type="button" data-role="copy-prev-all"
                         title="${escapeHtml(t('timetable.copyPrevAllHint', { count: previous.length }))}">${escapeHtml(t('timetable.copyPrev'))}</button>`
              : ''
          }
          <span class="sb-tt-editor__spacer"></span>
          <button class="sb-btn" type="button" data-role="close">${escapeHtml(t('common.close'))}</button>
        </div>
        <div class="sb-tt-editor__note">${escapeHtml(t('timetable.listNote'))}</div>
      `

      handle.element.querySelector('.sb-tt-editor__close')?.addEventListener('click', close)
      handle.element.querySelector('[data-role="close"]')?.addEventListener('click', close)
      handle.element.querySelector('[data-role="add-course"]')?.addEventListener('click', () => {
        renderForm(emptyCell())
      })

      handle.element.querySelectorAll<HTMLElement>('[data-role="edit-course"]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset['id'] ?? ''
          const found = current().find((course) => course.id === id)
          if (found) renderForm(found)
        })
      })

      handle.element.querySelectorAll<HTMLElement>('[data-role="remove-course"]').forEach((button) => {
        button.addEventListener('click', () => {
          void (async () => {
            const id = button.dataset['id'] ?? ''
            if (id === '') return
            await options.onRemoveCell(key, id)
            renderList()
          })()
        })
      })

      handle.element.querySelector('[data-role="copy-prev-all"]')?.addEventListener('click', () => {
        void (async () => {
          const source = previousCourses()
          if (source.length === 0) return
          await options.onCopyPrevious(key, source)
          renderList()
        })()
      })
    }

    /* ---------------------------------------------------------- 表单形态 */

    function renderForm(draft: TimetableCell): void {
      const courses = knownCourses(data?.cells ?? {})
      const editing = draft.id !== ''
      const weekCount = data?.weekCount ?? MAX_WEEK_COUNT

      handle.element.dataset['mode'] = 'form'
      handle.element.dataset['courseId'] = draft.id
      handle.element.innerHTML = `
        <div class="sb-tt-editor__head">
          <span>${escapeHtml(
            editing
              ? t('timetable.editingAt', { where: describeKey(key, data?.weekdays ?? []) })
              : t('timetable.addingAt', { where: describeKey(key, data?.weekdays ?? []) })
          )}</span>
          <button class="sb-tt-editor__close" type="button" aria-label="${escapeHtml(t('common.close'))}">✕</button>
        </div>
        <div class="sb-tt-editor__body">
          <label class="sb-field">
            <span>${escapeHtml(t('timetable.field.courseName'))}</span>
            <input class="sb-input" data-field="courseName" maxlength="60" autocomplete="off"
                   list="sb-tt-known-courses" />
          </label>
          ${
            courses.length === 0
              ? ''
              : `
          <label class="sb-field">
            <span>${escapeHtml(t('timetable.reuse'))}</span>
            <select class="sb-select" data-role="reuse">
              <option value="">${escapeHtml(t('timetable.reusePick'))}</option>
              ${courses
                .map(
                  (course, index) =>
                    `<option value="${index}">${escapeHtml(courseOptionLabel(course))}</option>`
                )
                .join('')}
            </select>
          </label>`
          }
          <div class="sb-tt-editor__pair">
            <label class="sb-field">
              <span>${escapeHtml(t('timetable.field.teacher'))}</span>
              <input class="sb-input" data-field="teacher" maxlength="40" autocomplete="off" />
            </label>
            <label class="sb-field">
              <span>${escapeHtml(t('timetable.field.location'))}</span>
              <input class="sb-input" data-field="location" maxlength="60" autocomplete="off" />
            </label>
          </div>
          <label class="sb-field">
            <span>${escapeHtml(t('timetable.field.duration'))}</span>
            <input class="sb-input" data-field="duration" maxlength="40" autocomplete="off"
                   placeholder="${escapeHtml(t('timetable.durationPlaceholder'))}" />
          </label>
          <label class="sb-field">
            <span>${escapeHtml(t('timetable.field.remark'))}</span>
            <textarea class="sb-textarea" data-field="remark" rows="2" maxlength="300"></textarea>
          </label>
          <div class="sb-field">
            <span>${escapeHtml(t('timetable.field.weeks'))}</span>
            <div class="sb-radio-row sb-tt-editor__weeks">
              <label class="sb-radio">
                <input type="radio" name="sb-tt-week" value="all" />
                <span>${escapeHtml(t('timetable.week.all'))}</span>
              </label>
              <label class="sb-radio">
                <input type="radio" name="sb-tt-week" value="odd" />
                <span>${escapeHtml(t('timetable.week.odd'))}</span>
              </label>
              <label class="sb-radio">
                <input type="radio" name="sb-tt-week" value="even" />
                <span>${escapeHtml(t('timetable.week.even'))}</span>
              </label>
              <label class="sb-radio">
                <input type="radio" name="sb-tt-week" value="list" />
                <span>${escapeHtml(t('timetable.week.list'))}</span>
              </label>
            </div>
            <input class="sb-input" data-role="week-list" autocomplete="off"
                   placeholder="${escapeHtml(t('timetable.week.listPlaceholder', { max: weekCount }))}" />
            <p class="sb-hint">${escapeHtml(t('timetable.week.listHint'))}</p>
          </div>
        </div>
        <datalist id="sb-tt-known-courses">
          ${courses.map((course) => `<option value="${escapeHtml(course.courseName)}"></option>`).join('')}
        </datalist>
        <div class="sb-tt-editor__actions">
          <button class="sb-btn sb-btn--ghost" type="button" data-role="clear">${escapeHtml(t('common.clear'))}</button>
          ${
            previousCourses().length > 0
              ? `<button class="sb-btn sb-btn--ghost" type="button" data-role="copy-prev"
                         title="${escapeHtml(t('timetable.copyPrevHint'))}">${escapeHtml(t('timetable.copyPrev'))}</button>`
              : ''
          }
          <span class="sb-tt-editor__spacer"></span>
          <button class="sb-btn" type="button" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
          <button class="sb-btn sb-btn--primary" type="button" data-role="save">${escapeHtml(t('common.save'))}</button>
        </div>
        <div class="sb-tt-editor__note">${escapeHtml(t('timetable.editorNote'))}</div>
      `

      const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>()
      handle.element
        .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]')
        .forEach((input) => {
          const field = input.dataset['field']
          if (!field) return
          inputs.set(field, input)
          const value = draft[field as keyof TimetableCell]
          input.value = typeof value === 'string' ? value : ''
        })

      const weekRadios = [
        ...handle.element.querySelectorAll<HTMLInputElement>('input[name="sb-tt-week"]')
      ]
      const weekListInput = handle.element.querySelector<HTMLInputElement>('[data-role="week-list"]')

      const paintWeeks = (rule: WeekRule): void => {
        for (const radio of weekRadios) radio.checked = radio.value === rule.kind
        if (weekListInput) {
          weekListInput.value = rule.kind === 'list' ? rule.weeks.join(',') : ''
          weekListInput.disabled = rule.kind !== 'list'
        }
      }
      paintWeeks(draft.weeks)

      for (const radio of weekRadios) {
        radio.addEventListener('change', () => {
          if (!radio.checked || !weekListInput) return
          weekListInput.disabled = radio.value !== 'list'
          if (radio.value === 'list') weekListInput.focus()
        })
      }

      /**
       * 把某个格子的内容填进表单。
       *
       * `fields` 决定填哪些：
       *  - 从课程下拉里选：填「课程身份」——名称/老师/地点/时长。
       *    **不填备注**，因为备注往往是这一格特有的（「小测」「调课」）。
       *  - 复制上一节：**全填**。用户点的是「复制」，那就该是整格复制。
       */
      const fill = (source: TimetableCell, fields: readonly (keyof TimetableCell)[]): void => {
        for (const field of fields) {
          const input = inputs.get(field)
          if (input) input.value = source[field] as string
        }
        if (fields.includes('weeks')) paintWeeks(source.weeks)
        inputs.get('courseName')?.focus()
      }

      const REUSE_FIELDS = ['courseName', 'teacher', 'location', 'duration'] as const
      const COPY_FIELDS = ['courseName', 'teacher', 'location', 'duration', 'remark', 'weeks'] as const

      handle.element
        .querySelector<HTMLSelectElement>('[data-role="reuse"]')
        ?.addEventListener('change', (event) => {
          const select = event.target as HTMLSelectElement
          const picked = courses[Number(select.value)]
          if (picked) fill(picked, REUSE_FIELDS)
          // 复位：不然再选同一个不会触发 change，用户会以为没反应
          select.value = ''
        })

      handle.element.querySelector('[data-role="copy-prev"]')?.addEventListener('click', () => {
        const previous = previousCourses()[0]
        if (previous) fill(previous, COPY_FIELDS)
      })

      /** 表单 → 课程对象。周次认不出来时返回 null，由调用方给出提示 */
      const collect = (): TimetableCell | null => {
        const kind = weekRadios.find((radio) => radio.checked)?.value ?? 'all'
        let weeks: WeekRule
        if (kind === 'odd') weeks = { kind: 'odd' }
        else if (kind === 'even') weeks = { kind: 'even' }
        else if (kind === 'list') {
          const weeks_ = parseWeekList(weekListInput?.value ?? '', weekCount)
          if (weeks_.length === 0) return null
          weeks = { kind: 'list', weeks: weeks_ }
        } else weeks = { kind: 'all' }

        return {
          id: draft.id,
          courseName: inputs.get('courseName')?.value.trim() ?? '',
          teacher: inputs.get('teacher')?.value.trim() ?? '',
          location: inputs.get('location')?.value.trim() ?? '',
          duration: inputs.get('duration')?.value.trim() ?? '',
          remark: inputs.get('remark')?.value.trim() ?? '',
          weeks
        }
      }

      let busy = false

      /**
       * 存完之后去哪儿。
       *
       * 保存一门课回**列表**（这一格可能还有别的课要改）；清空整格直接**关闭**
       * —— 格子都空了，再给用户看一个「添加课程」的空表单没有意义。
       */
      const run = async (
        action: () => Promise<void>,
        after: 'list' | 'close'
      ): Promise<void> => {
        if (busy) return
        busy = true
        try {
          await action()
        } finally {
          busy = false
        }
        if (after === 'close') close()
        else renderList()
      }

      const save = (): void => {
        const value = collect()
        if (!value) {
          // 「指定周」但一周都没解析出来：拦下来，否则用户会以为存上了
          weekListInput?.focus()
          return
        }
        void run(() => options.onSaveCell(key, value), 'list')
      }

      /** 从表单退回上一层：这一格还有课就回列表，没有就直接关掉 */
      const back = (): void => {
        if (current().length === 0) close()
        else renderList()
      }

      handle.element.querySelector('[data-role="save"]')?.addEventListener('click', save)
      handle.element.querySelector('[data-role="clear"]')?.addEventListener('click', () => {
        void run(() => options.onSaveCell(key, null), 'close')
      })
      handle.element.querySelector('[data-role="cancel"]')?.addEventListener('click', back)
      handle.element.querySelector('.sb-tt-editor__close')?.addEventListener('click', close)

      handle.element.addEventListener('keydown', (event) => {
        const keyboard = event as KeyboardEvent
        if (keyboard.key === 'Enter' && (keyboard.ctrlKey || keyboard.metaKey)) {
          keyboard.preventDefault()
          save()
        } else if (keyboard.key === 'Escape') {
          keyboard.preventDefault()
          back()
        } else if (keyboard.key === 'Enter' && !keyboard.shiftKey) {
          // 单行输入里回车直接保存，符合表格编辑的直觉
          const target = keyboard.target as HTMLElement | null
          if (target && target.tagName === 'INPUT' && target !== weekListInput) {
            keyboard.preventDefault()
            save()
          }
        }
      })

      const first = inputs.get('courseName')
      first?.focus()
      first?.select()
    }

    closeEditor = close

    // 空格子直接进表单：最常见的情况是「往空格里加一门课」，
    // 让用户先看一个空列表再点「添加」是白加一步
    if (current().length === 0) renderForm(emptyCell())
    else renderList()
  }

  /* ------------------------------------------------------------ 表格渲染 */

  function renderTable(current: TimetableData): void {
    const { weekdays, periodCount, rows } = current
    const rowByIndex = new Map(rows.map((row) => [row.index, row]))

    const head = weekdays
      .map(
        (day, index) =>
          `<th scope="col"${index === 0 ? ' class="sb-timetable__index"' : ''}>${escapeHtml(day)}</th>`
      )
      .join('')

    const bodyRows: string[] = []
    for (let period = 1; period <= periodCount; period += 1) {
      const row = rowByIndex.get(period)
      const time =
        row && (row.start || row.end)
          ? `<span class="sb-timetable__time">${escapeHtml(row.start || '--:--')}<br />${escapeHtml(row.end || '--:--')}</span>`
          : ''

      const cells: string[] = [
        `<th scope="row" class="sb-timetable__index"><span class="sb-timetable__period">${period}</span>${time}</th>`
      ]

      for (let column = 1; column < weekdays.length; column += 1) {
        const key = `${period}:${column - 1}`
        const courses = shownAt(key, current)
        cells.push(
          `<td class="sb-timetable__cell${courses.length === 0 ? ' sb-timetable__cell--empty' : ''}"
               data-key="${key}"
               tabindex="${options.editable ? '0' : '-1'}"
               ${options.editable ? 'role="button"' : ''}
               aria-label="${escapeHtml(cellLabel(key, courses, weekdays))}">${cellInnerHtml(courses)}</td>`
        )
      }
      bodyRows.push(`<tr>${cells.join('')}</tr>`)
    }

    markLimited('sb:tt:render:build')
    body.innerHTML = `<div class="sb-ttpanel__scroll"><table class="sb-timetable">
      <thead><tr>${head}</tr></thead>
      <tbody>${bodyRows.join('')}</tbody>
    </table></div>`
    markLimited('sb:tt:render:dom')
  }

  /**
   * 只重画一个格子。
   * 找不到对应的 `<td>`（例如表结构刚好变了）就返回 false，
   * 交给调用方退回整表渲染——宁可多画一次，也不能画错。
   */
  function paintCell(key: string, current: TimetableData): boolean {
    const cell = body.querySelector<HTMLTableCellElement>(`td.sb-timetable__cell[data-key="${key}"]`)
    if (!cell) return false

    const courses = shownAt(key, current)
    cell.classList.toggle('sb-timetable__cell--empty', courses.length === 0)
    cell.setAttribute('aria-label', cellLabel(key, courses, current.weekdays))
    cell.innerHTML = cellInnerHtml(courses)
    markLimited('sb:tt:render:cell')
    return true
  }

  /* ------------------------------------------------------------ 图片渲染 */

  function renderImages(current: TimetableData): void {
    const slots: string = current.images.map((image, index) => renderShot(image, index)).join('')

    const canAdd = options.editable && current.images.length < MAX_TIMETABLE_IMAGES
    const addButton = canAdd
      ? `<button class="sb-ttshot sb-ttshot--add" type="button" data-role="add">
           <span class="sb-ttshot__plus" aria-hidden="true">＋</span>
           <span>${escapeHtml(t('timetable.addPhoto'))}</span>
           <span class="sb-hint">${escapeHtml(t('timetable.photoHint', { max: MAX_TIMETABLE_IMAGES }))}</span>
         </button>`
      : ''

    const empty =
      current.images.length === 0
        ? `<p class="sb-hint sb-ttpanel__hint">${escapeHtml(t('timetable.photoEmpty'))}</p>`
        : ''

    body.innerHTML = `<div class="sb-ttshots">${slots}${addButton}</div>${empty}`
  }

  function renderShot(image: CourseImage, index: number): string {
    const dimensions = image.width > 0 ? `${image.width}×${image.height}` : ''
    const size = formatBytes(image.bytes)
    const meta = [dimensions, size].filter(Boolean).join(' · ')
    // 带上真实宽高：浏览器能在图片解码完成前就把位置留出来，
    // 避免图片加载完成后整块区域跳一下，也少一次布局重算
    const intrinsic =
      image.width > 0 && image.height > 0
        ? ` width="${image.width}" height="${image.height}"`
        : ''

    return `
      <figure class="sb-ttshot" data-id="${escapeHtml(image.id)}">
        <button class="sb-ttshot__view" type="button" data-role="view" aria-label="${escapeHtml(t('timetable.viewPhoto', { n: index + 1 }))}">
          <img src="${escapeHtml(assetUrl('timetable', image.fileName))}" alt="${escapeHtml(image.sourceName)}"${intrinsic} loading="lazy" decoding="async" />
        </button>
        <figcaption class="sb-ttshot__caption">
          <span class="sb-ttshot__name" title="${escapeHtml(image.sourceName)}">${escapeHtml(image.sourceName)}</span>
          ${meta ? `<span class="sb-ttshot__meta">${escapeHtml(meta)}</span>` : ''}
        </figcaption>
        ${
          options.editable
            ? `<div class="sb-ttshot__actions">
                 <button class="sb-btn sb-btn--ghost" type="button" data-role="replace">${escapeHtml(t('timetable.replace'))}</button>
                 <button class="sb-btn sb-btn--ghost" type="button" data-role="remove">${escapeHtml(t('common.delete'))}</button>
               </div>`
            : ''
        }
      </figure>
    `
  }

  /* ------------------------------------------------------------ 事件绑定 */

  body.addEventListener('mouseover', (event) => {
    const cell = (event.target as HTMLElement | null)?.closest<HTMLTableCellElement>(
      'td.sb-timetable__cell'
    )
    if (!cell) return
    const key = cell.dataset['key']
    if (!key) return
    // 编辑弹层打开时不再弹预览，否则两个浮层会叠在一起
    if (closeEditor) return
    if (closeHover) return
    scheduleHover(cell, key)
  })

  body.addEventListener('mouseout', (event) => {
    const cell = (event.target as HTMLElement | null)?.closest<HTMLTableCellElement>(
      'td.sb-timetable__cell'
    )
    if (!cell) return
    const related = (event as MouseEvent).relatedTarget as Node | null
    if (related && cell.contains(related)) return
    hideHover()
  })

  body.addEventListener('dblclick', (event) => {
    const cell = (event.target as HTMLElement | null)?.closest<HTMLTableCellElement>(
      'td.sb-timetable__cell'
    )
    if (!cell) return
    const key = cell.dataset['key']
    if (!key) return
    event.preventDefault()
    openEditor(cell, key)
  })

  body.addEventListener('keydown', (event) => {
    const keyboard = event as KeyboardEvent
    const cell = (keyboard.target as HTMLElement | null)?.closest<HTMLTableCellElement>(
      'td.sb-timetable__cell'
    )
    if (!cell) return
    const key = cell.dataset['key']
    if (!key) return
    if (keyboard.key === 'Enter' || keyboard.key === ' ') {
      keyboard.preventDefault()
      openEditor(cell, key)
    }
  })

  body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const actionEl = target?.closest<HTMLElement>('[data-role]')
    const action = actionEl?.dataset['role']
    if (!action) return

    if (action === 'add') {
      void options.onAddImages()
      return
    }

    const shot = target?.closest<HTMLElement>('.sb-ttshot')
    const id = shot?.dataset['id']
    if (!id) return

    if (action === 'view') {
      const images = (data?.images ?? []).map((image) => ({
        src: assetUrl('timetable', image.fileName),
        caption: image.sourceName
      }))
      const index = (data?.images ?? []).findIndex((image) => image.id === id)
      openLightbox(images, index < 0 ? 0 : index)
    } else if (action === 'remove') {
      void options.onRemoveImage(id)
    } else if (action === 'replace') {
      void options.onReplaceImage(id)
    }
  })

  // 滚动 / 缩放时浮层位置会失准，直接收起来最省事也最不容易出错
  const onViewportChange = (): void => hideHover()
  window.addEventListener('scroll', onViewportChange, true)

  return {
    element,
    render(next: TimetableData, hint?: RenderHint) {
      // 单格重绘的前提：表结构没变，而且目标格子确实还在。
      // 查看周次变了要穿整表路径——过滤会同时影响所有格子
      if (
        hint?.kind === 'cell' &&
        next.mode === 'table' &&
        data?.mode === 'table' &&
        data.periodCount === next.periodCount &&
        data.currentWeek === next.currentWeek &&
        data.weekdays.length === next.weekdays.length &&
        paintCell(hint.key, next)
      ) {
        data = next
        hideHover()
        return
      }

      data = next
      hideHover()
      closeEditor?.()
      closeEditor = null
      if (next.mode === 'image') renderImages(next)
      else renderTable(next)
    },
    isEmpty() {
      if (!data) return true
      return Object.keys(data.cells).length === 0 && data.images.length === 0
    },
    dispose() {
      cancelHover()
      closeHover?.()
      closeHover = null
      closeEditor?.()
      closeEditor = null
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }
}
