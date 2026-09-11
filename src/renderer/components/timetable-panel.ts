import { MAX_TIMETABLE_IMAGES } from '@shared/limits'
import type { CourseImage, TimetableCell, TimetableData } from '@shared/types'

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
 */

const HOVER_DELAY = 170

export interface TimetablePanelOptions {
  /** 是否允许编辑（双击单元格、增删换图片） */
  editable: boolean
  /** 保存单元格，cell 传 null 表示清空 */
  onSaveCell(key: string, cell: TimetableCell | null): Promise<void>
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

export function assetUrl(bucket: string, fileName: string): string {
  return `sb-asset://${bucket}/${fileName.split('/').map(encodeURIComponent).join('/')}`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function cellSummary(cell: TimetableCell | undefined): { name: string; meta: string } {
  if (!cell) return { name: '', meta: '' }
  const metaParts = [cell.teacher, cell.location].filter((part) => part.length > 0)
  return { name: cell.courseName, meta: metaParts.join(' · ') }
}

function isBlank(cell: TimetableCell | undefined): boolean {
  if (!cell) return true
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
  const weekday = weekdays[column + 1] ?? `第 ${column + 1} 列`
  return `第 ${period} 节 · ${weekday}`
}

function cellLabel(key: string, content: TimetableCell | undefined, weekdays: readonly string[]): string {
  const summary = cellSummary(content)
  const what = isBlank(content) ? '空，双击添加课程' : summary.name || '未命名课程'
  return `${describeKey(key, weekdays)}：${what}`
}

/**
 * 单元格内容。
 *
 * 整表渲染与单格重绘都调它——只有一份模板，就不会出现
 * 「整表刷新和局部刷新长得不一样」这种迟早会发生的偏差。
 */
function cellInnerHtml(content: TimetableCell | undefined): string {
  if (isBlank(content)) {
    return '<span class="sb-timetable__add" aria-hidden="true">＋</span>'
  }
  const summary = cellSummary(content)
  const meta = summary.meta ? `<span class="sb-ttcell__meta">${escapeHtml(summary.meta)}</span>` : ''
  return `<span class="sb-ttcell__name">${escapeHtml(summary.name || '未命名课程')}</span>${meta}`
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

  function scheduleHover(cell: HTMLTableCellElement, key: string): void {
    if (!data) return
    const content = data.cells[key]
    if (isBlank(content) || !content) return

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
      handle.element.innerHTML = renderPreview(content, describeKey(key, data?.weekdays ?? []))
      closeHover = handle.close
    }, HOVER_DELAY)
  }

  function renderPreview(cell: TimetableCell, where: string): string {
    const rows: string[] = []
    const push = (label: string, value: string): void => {
      if (!value) return
      rows.push(
        `<div class="sb-tt-preview__row"><span class="sb-tt-preview__label">${escapeHtml(label)}</span><span class="sb-tt-preview__value">${escapeHtml(value)}</span></div>`
      )
    }
    push('授课老师', cell.teacher)
    push('授课位置', cell.location)
    push('持续时间', cell.duration)
    push('备注', cell.remark)

    return `
      <div class="sb-tt-preview__head">
        <span class="sb-tt-preview__where">${escapeHtml(where)}</span>
        <span class="sb-tt-preview__hint">双击编辑</span>
      </div>
      <div class="sb-tt-preview__title">${escapeHtml(cell.courseName || '未命名课程')}</div>
      ${rows.length > 0 ? `<div class="sb-tt-preview__rows">${rows.join('')}</div>` : ''}
    `
  }

  /* ------------------------------------------------------------ 编辑弹层 */

  function openEditor(cell: HTMLTableCellElement, key: string): void {
    if (!options.editable || !data) return
    hideHover()
    closeEditor?.()

    const current: TimetableCell = data.cells[key] ?? {
      courseName: '',
      teacher: '',
      location: '',
      duration: '',
      remark: ''
    }

    const handle = showFloating({
      className: 'sb-tt-editor',
      anchor: cell.getBoundingClientRect(),
      closeOnOutsideClick: false,
      closeOnEscape: false
    })

    handle.element.innerHTML = `
      <div class="sb-tt-editor__head">
        <span>${escapeHtml(describeKey(key, data.weekdays))}</span>
        <button class="sb-tt-editor__close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="sb-tt-editor__body">
        <label class="sb-field">
          <span>课程名称</span>
          <input class="sb-input" data-field="courseName" maxlength="60" autocomplete="off" />
        </label>
        <div class="sb-tt-editor__pair">
          <label class="sb-field">
            <span>授课老师</span>
            <input class="sb-input" data-field="teacher" maxlength="40" autocomplete="off" />
          </label>
          <label class="sb-field">
            <span>授课位置</span>
            <input class="sb-input" data-field="location" maxlength="60" autocomplete="off" />
          </label>
        </div>
        <label class="sb-field">
          <span>持续时间</span>
          <input class="sb-input" data-field="duration" maxlength="40" autocomplete="off"
                 placeholder="如 45 分钟 / 1-2 节连上" />
        </label>
        <label class="sb-field">
          <span>备注</span>
          <textarea class="sb-textarea" data-field="remark" rows="2" maxlength="300"></textarea>
        </label>
      </div>
      <div class="sb-tt-editor__actions">
        <button class="sb-btn sb-btn--ghost" type="button" data-role="clear">清空</button>
        <span class="sb-tt-editor__spacer"></span>
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="save">保存</button>
      </div>
      <div class="sb-tt-editor__note">Ctrl / ⌘ + Enter 保存 · Esc 取消</div>
    `

    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>()
    handle.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]').forEach((input) => {
      const field = input.dataset['field']
      if (!field) return
      inputs.set(field, input)
      const value = current[field as keyof TimetableCell]
      input.value = typeof value === 'string' ? value : ''
    })

    let busy = false
    const collect = (): TimetableCell => ({
      courseName: inputs.get('courseName')?.value.trim() ?? '',
      teacher: inputs.get('teacher')?.value.trim() ?? '',
      location: inputs.get('location')?.value.trim() ?? '',
      duration: inputs.get('duration')?.value.trim() ?? '',
      remark: inputs.get('remark')?.value.trim() ?? ''
    })

    const submit = async (value: TimetableCell | null): Promise<void> => {
      if (busy) return
      busy = true
      closeEditor = null
      handle.close()
      try {
        await options.onSaveCell(key, value)
      } finally {
        busy = false
      }
    }

    handle.element.querySelector('[data-role="save"]')?.addEventListener('click', () => {
      void submit(collect())
    })
    handle.element.querySelector('[data-role="clear"]')?.addEventListener('click', () => {
      void submit(null)
    })
    handle.element.querySelector('[data-role="cancel"]')?.addEventListener('click', () => {
      closeEditor = null
      handle.close()
    })
    handle.element.querySelector('.sb-tt-editor__close')?.addEventListener('click', () => {
      closeEditor = null
      handle.close()
    })

    handle.element.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent
      if (keyboard.key === 'Enter' && (keyboard.ctrlKey || keyboard.metaKey)) {
        keyboard.preventDefault()
        void submit(collect())
      } else if (keyboard.key === 'Escape') {
        keyboard.preventDefault()
        closeEditor = null
        handle.close()
      } else if (keyboard.key === 'Enter' && !keyboard.shiftKey) {
        // 单行输入里回车直接保存，符合表格编辑的直觉
        const target = keyboard.target as HTMLElement | null
        if (target && target.tagName === 'INPUT') {
          keyboard.preventDefault()
          void submit(collect())
        }
      }
    })

    closeEditor = handle.close
    const first = inputs.get('courseName')
    first?.focus()
    first?.select()
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
        const content = current.cells[key]
        cells.push(
          `<td class="sb-timetable__cell${isBlank(content) ? ' sb-timetable__cell--empty' : ''}"
               data-key="${key}"
               tabindex="${options.editable ? '0' : '-1'}"
               ${options.editable ? 'role="button"' : ''}
               aria-label="${escapeHtml(cellLabel(key, content, weekdays))}">${cellInnerHtml(content)}</td>`
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

    const content = current.cells[key]
    cell.classList.toggle('sb-timetable__cell--empty', isBlank(content))
    cell.setAttribute('aria-label', cellLabel(key, content, current.weekdays))
    cell.innerHTML = cellInnerHtml(content)
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
           <span>添加课表照片</span>
           <span class="sb-hint">支持 JPEG / PNG / HEIF，最多 ${MAX_TIMETABLE_IMAGES} 张</span>
         </button>`
      : ''

    const empty =
      current.images.length === 0
        ? `<p class="sb-hint sb-ttpanel__hint">还没有导入课表照片。图片模式适合直接用教务系统截图或拍纸质课表。</p>`
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
        <button class="sb-ttshot__view" type="button" data-role="view" aria-label="查看第 ${index + 1} 张课表照片">
          <img src="${escapeHtml(assetUrl('timetable', image.fileName))}" alt="${escapeHtml(image.sourceName)}"${intrinsic} loading="lazy" decoding="async" />
        </button>
        <figcaption class="sb-ttshot__caption">
          <span class="sb-ttshot__name" title="${escapeHtml(image.sourceName)}">${escapeHtml(image.sourceName)}</span>
          ${meta ? `<span class="sb-ttshot__meta">${escapeHtml(meta)}</span>` : ''}
        </figcaption>
        ${
          options.editable
            ? `<div class="sb-ttshot__actions">
                 <button class="sb-btn sb-btn--ghost" type="button" data-role="replace">替换</button>
                 <button class="sb-btn sb-btn--ghost" type="button" data-role="remove">删除</button>
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
      // 单格重绘的前提：表结构没变，而且目标格子确实还在
      if (
        hint?.kind === 'cell' &&
        next.mode === 'table' &&
        data?.mode === 'table' &&
        data.periodCount === next.periodCount &&
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
