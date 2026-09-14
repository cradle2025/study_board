import { MAX_PERIODS, MIN_PERIODS, MAX_TIMETABLE_IMAGES, TIMETABLE_COLUMNS } from '@shared/limits'
import type { PeriodRow, TimetableData } from '@shared/types'

import { createTimetableController, type TimetableController } from '../components/timetable-controller'
import { t, tm } from '../lib/i18n'
import { escapeHtml } from '../lib/html'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import type { ViewContext, ViewInstance } from '../app-shell'

/**
 * 课程表编辑页。
 *
 * 页面自己只管「形状」：用哪种模式看、每天几节、表头叫什么、每节几点开始。
 * 「内容」（课程单元格、课表照片）全部交给共享面板，保证和概览页完全一致。
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function minutesOf(time: string): number | null {
  if (!TIME_PATTERN.test(time)) return null
  const [hour, minute] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

function timeOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(wrapped / 60)
  const minute = wrapped % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function createTimetableEditorView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.timetable'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('timetable.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="back-home">${escapeHtml(t('timetable.backHome'))}</button>
      </div>
    </div>

    <div class="sb-notice">
      ${escapeHtml(t('timetable.modeNote'))}
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('timetable.entryMode'))}</h2>
      </div>
      <div class="sb-card sb-card--pad">
        <div class="sb-radio-row">
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="table" />
            <span>${escapeHtml(t('timetable.mode.table'))}</span>
          </label>
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="image" />
            <span>${escapeHtml(t('timetable.mode.image'))}</span>
          </label>
        </div>

        <div class="sb-field sb-tt-inline-field" data-role="period-field">
          <label for="period-count">${escapeHtml(t('timetable.periodCount', { min: MIN_PERIODS, max: MAX_PERIODS }))}</label>
          <input id="period-count" class="sb-input" type="number"
                 min="${MIN_PERIODS}" max="${MAX_PERIODS}" step="1" inputmode="numeric" />
          <p class="sb-hint">${escapeHtml(t('timetable.periodHint'))}</p>
        </div>
      </div>
    </section>

    <section class="sb-section" data-role="table-extras">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('timetable.details'))}</h2>
      </div>

      <details class="sb-card sb-details">
        <summary>${escapeHtml(t('timetable.weekdayTitle', { count: TIMETABLE_COLUMNS }))}</summary>
        <div class="sb-details__body">
          <p class="sb-hint">${escapeHtml(t('timetable.weekdayHint'))}</p>
          <div class="sb-weekday-grid" data-role="weekday-inputs"></div>
          <div class="sb-toolbar">
            <button class="sb-btn sb-btn--primary" type="button" data-action="save-weekdays">${escapeHtml(t('timetable.saveWeekdays'))}</button>
            <button class="sb-btn" type="button" data-action="reset-weekdays">${escapeHtml(t('common.restoreDefault'))}</button>
          </div>
        </div>
      </details>

      <details class="sb-card sb-details">
        <summary>${escapeHtml(t('timetable.times'))}</summary>
        <div class="sb-details__body">
          <p class="sb-hint">${escapeHtml(t('timetable.timesHint'))}</p>

          <div class="sb-period-grid" data-role="period-inputs"></div>

          <div class="sb-quickfill">
            <span class="sb-quickfill__title">${escapeHtml(t('timetable.quickfill'))}</span>
            <label class="sb-quickfill__field">
              <span>${escapeHtml(t('timetable.quickfillStart'))}</span>
              <input class="sb-input" type="time" value="08:00" data-role="qf-start" />
            </label>
            <label class="sb-quickfill__field">
              <span>${escapeHtml(t('timetable.quickfillDuration'))}</span>
              <input class="sb-input" type="number" min="10" max="300" step="5" value="45" data-role="qf-length" />
            </label>
            <label class="sb-quickfill__field">
              <span>${escapeHtml(t('timetable.quickfillBreak'))}</span>
              <input class="sb-input" type="number" min="0" max="120" step="5" value="10" data-role="qf-break" />
            </label>
            <button class="sb-btn" type="button" data-action="quickfill">${escapeHtml(t('timetable.quickfillApply'))}</button>
          </div>

          <div class="sb-toolbar">
            <button class="sb-btn sb-btn--primary" type="button" data-action="save-times">${escapeHtml(t('timetable.saveTimes'))}</button>
            <button class="sb-btn" type="button" data-action="clear-times">${escapeHtml(t('timetable.clearTimes'))}</button>
          </div>
        </div>
      </details>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title" data-role="preview-title">${escapeHtml(t('timetable.preview'))}</h2>
        <span class="sb-badge" data-role="grid-meta"></span>
      </div>
      <div data-role="timetable-slot"></div>
    </section>
  `

  const modeRadios = (): NodeListOf<HTMLInputElement> =>
    element.querySelectorAll<HTMLInputElement>('input[name="tt-mode"]')
  const periodInput = element.querySelector<HTMLInputElement>('#period-count')
  const periodField = element.querySelector<HTMLElement>('[data-role="period-field"]')
  const tableExtras = element.querySelector<HTMLElement>('[data-role="table-extras"]')
  const previewTitle = element.querySelector<HTMLElement>('[data-role="preview-title"]')
  const gridMeta = element.querySelector<HTMLElement>('[data-role="grid-meta"]')
  const weekdayHost = element.querySelector<HTMLElement>('[data-role="weekday-inputs"]')
  const periodHost = element.querySelector<HTMLElement>('[data-role="period-inputs"]')
  const slot = element.querySelector<HTMLElement>('[data-role="timetable-slot"]')

  let data: TimetableData | null = null

  const controller: TimetableController = createTimetableController({
    editable: true,
    errorPrefix: t('nav.timetable'),
    onData(next) {
      data = next
      paint()
    }
  })

  slot?.appendChild(controller.panel.element)

  /* ------------------------------------------------------------ 渲染 */

  function paint(): void {
    if (!data) return
    const { mode, periodCount, weekdays, rows } = data

    modeRadios().forEach((input) => {
      input.checked = input.value === mode
    })
    if (periodInput) periodInput.value = String(periodCount)

    if (periodField) periodField.hidden = mode === 'image'
    if (tableExtras) tableExtras.hidden = mode === 'image'
    if (previewTitle) previewTitle.textContent = t(mode === 'image' ? 'timetable.photo' : 'timetable.previewTable')

    if (gridMeta) {
      gridMeta.textContent =
        mode === 'image'
          ? t('timetable.imageCount', { count: data.images.length, max: MAX_TIMETABLE_IMAGES })
          : t('timetable.gridSize', { cols: weekdays.length, rows: periodCount })
    }

    if (weekdayHost) {
      weekdayHost.innerHTML = weekdays
        .slice(1)
        .map(
          (day, index) =>
            `<label class="sb-weekday">
               <span>${escapeHtml(t('timetable.columnN', { n: index + 2 }))}</span>
               <input class="sb-input" data-weekday="${index + 1}" maxlength="12" value="${escapeHtml(day)}" />
             </label>`
        )
        .join('')
    }

    if (periodHost) {
      const rowByIndex = new Map(rows.map((row) => [row.index, row]))
      const parts: string[] = []
      for (let index = 1; index <= periodCount; index += 1) {
        const row = rowByIndex.get(index)
        parts.push(`
          <div class="sb-period">
            <span class="sb-period__label">${escapeHtml(t('timetable.periodN', { n: index }))}</span>
            <input class="sb-input" type="time" data-period="${index}" data-bound="start" value="${escapeHtml(row?.start ?? '')}" />
            <span class="sb-period__sep">–</span>
            <input class="sb-input" type="time" data-period="${index}" data-bound="end" value="${escapeHtml(row?.end ?? '')}" />
          </div>
        `)
      }
      periodHost.innerHTML = parts.join('')
    }
  }

  /* ------------------------------------------------------------ 形状保存 */

  async function saveShape(patch: {
    mode?: 'table' | 'image'
    periodCount?: number
    weekdays?: string[]
  }): Promise<void> {
    try {
      const next = await unwrap(bridge().timetable.save(patch))
      data = next
      controller.panel.render(next)
      paint()
      await ctx.reloadSettings()
    } catch (error) {
      toast(t('timetable.saveFailed', { reason: tm(formatError(error)) }), 'error')
      paint()
    }
  }

  async function saveRows(rows: PeriodRow[]): Promise<void> {
    try {
      const next = await unwrap(bridge().timetable.save({ rows }))
      data = next
      controller.panel.render(next)
      paint()
      toast(t('timetable.timesSaved'), 'success')
    } catch (error) {
      toast(t('timetable.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  }

  function collectRows(): PeriodRow[] {
    const host = periodHost
    if (!host) return []
    const rows: PeriodRow[] = []
    host.querySelectorAll<HTMLInputElement>('input[data-period]').forEach((input) => {
      const index = Number.parseInt(input.dataset['period'] ?? '', 10)
      if (!Number.isFinite(index)) return
      let row = rows.find((item) => item.index === index)
      if (!row) {
        row = { index, start: '', end: '' }
        rows.push(row)
      }
      const bound = input.dataset['bound']
      const value = TIME_PATTERN.test(input.value) ? input.value : ''
      if (bound === 'start') row.start = value
      else if (bound === 'end') row.end = value
    })
    return rows
  }

  /* ------------------------------------------------------------ 事件 */

  modeRadios().forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return
      void saveShape({ mode: input.value === 'image' ? 'image' : 'table' })
    })
  })

  periodInput?.addEventListener('change', () => {
    const raw = Number.parseInt(periodInput.value, 10)
    if (!Number.isFinite(raw)) {
      paint()
      return
    }
    const clamped = Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, raw))
    void saveShape({ periodCount: clamped })
  })

  element
    .querySelector('[data-action="back-home"]')
    ?.addEventListener('click', () => ctx.navigate('home'))

  element.querySelector('[data-action="save-weekdays"]')?.addEventListener('click', () => {
    const inputs = [...element.querySelectorAll<HTMLInputElement>('input[data-weekday]')]
    const weekdays = [...(data?.weekdays ?? [])]
    for (const input of inputs) {
      const index = Number.parseInt(input.dataset['weekday'] ?? '', 10)
      if (!Number.isFinite(index)) continue
      const value = input.value.trim().slice(0, 12)
      weekdays[index] = value || t('timetable.columnN', { n: index })
    }
    void saveShape({ weekdays })
  })

  element.querySelector('[data-action="reset-weekdays"]')?.addEventListener('click', () => {
    void saveShape({ weekdays: t('timetable.defaultWeekdays').split(',') })
  })

  element.querySelector('[data-action="save-times"]')?.addEventListener('click', () => {
    void saveRows(collectRows())
  })

  element.querySelector('[data-action="clear-times"]')?.addEventListener('click', () => {
    void saveRows([])
  })

  element.querySelector('[data-action="quickfill"]')?.addEventListener('click', () => {
    const startInput = element.querySelector<HTMLInputElement>('[data-role="qf-start"]')
    const lengthInput = element.querySelector<HTMLInputElement>('[data-role="qf-length"]')
    const breakInput = element.querySelector<HTMLInputElement>('[data-role="qf-break"]')

    const start = minutesOf(startInput?.value ?? '')
    const length = Math.trunc(Number(lengthInput?.value))
    const gap = Math.trunc(Number(breakInput?.value))

    if (start === null) {
      toast(t('timetable.needStartTime'), 'error')
      return
    }
    if (!Number.isFinite(length) || length < 10 || length > 300) {
      toast(t('timetable.needDuration'), 'error')
      return
    }
    if (!Number.isFinite(gap) || gap < 0 || gap > 120) {
      toast(t('timetable.needBreak'), 'error')
      return
    }

    const count = data?.periodCount ?? periodHost?.querySelectorAll('input[data-period]').length ?? 0
    const rows: PeriodRow[] = []
    let cursor = start
    for (let index = 1; index <= count; index += 1) {
      rows.push({ index, start: timeOf(cursor), end: timeOf(cursor + length) })
      cursor += length + gap
    }

    // 先写进界面，用户看一眼再决定要不要保存
    for (const row of rows) {
      const startEl = periodHost?.querySelector<HTMLInputElement>(
        `input[data-period="${row.index}"][data-bound="start"]`
      )
      const endEl = periodHost?.querySelector<HTMLInputElement>(
        `input[data-period="${row.index}"][data-bound="end"]`
      )
      if (startEl) startEl.value = row.start
      if (endEl) endEl.value = row.end
    }
    toast(t('timetable.quickfilled'), 'info')
  })

  return {
    element,
    async onEnter() {
      await ctx.reloadSettings()
      await controller.load()
      if (!data) paint()
    },
    dispose() {
      controller.dispose()
    }
  }
}
