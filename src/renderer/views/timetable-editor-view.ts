import { MAX_PERIODS, MIN_PERIODS, MAX_TIMETABLE_IMAGES, TIMETABLE_COLUMNS } from '@shared/limits'
import type { PeriodRow, TimetableData } from '@shared/types'

import { createTimetableController, type TimetableController } from '../components/timetable-controller'
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
        <h1 class="sb-view__title">课程表</h1>
        <p class="sb-view__desc">表格模式与图片模式互为补充，随时可切换，两种内容都会保留。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="back-home">回到概览</button>
      </div>
    </div>

    <div class="sb-notice">
      切换模式只影响展示方式，不会删除另一种模式已经录入的内容。
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">录入方式</h2>
      </div>
      <div class="sb-card sb-card--pad">
        <div class="sb-radio-row">
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="table" />
            <span>表格模式</span>
          </label>
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="image" />
            <span>图片模式</span>
          </label>
        </div>

        <div class="sb-field sb-tt-inline-field" data-role="period-field">
          <label for="period-count">每天节数（${MIN_PERIODS}–${MAX_PERIODS}）</label>
          <input id="period-count" class="sb-input" type="number"
                 min="${MIN_PERIODS}" max="${MAX_PERIODS}" step="1" inputmode="numeric" />
          <p class="sb-hint">调整节数不会删除已填写的课程；把节数调回来就能看到。</p>
        </div>
      </div>
    </section>

    <section class="sb-section" data-role="table-extras">
      <div class="sb-section__head">
        <h2 class="sb-section__title">表格细节</h2>
      </div>

      <details class="sb-card sb-details">
        <summary>表头名称（${TIMETABLE_COLUMNS} 列）</summary>
        <div class="sb-details__body">
          <p class="sb-hint">第一列固定用于显示节数，可改的是一周七天。</p>
          <div class="sb-weekday-grid" data-role="weekday-inputs"></div>
          <div class="sb-toolbar">
            <button class="sb-btn sb-btn--primary" type="button" data-action="save-weekdays">保存表头</button>
            <button class="sb-btn" type="button" data-action="reset-weekdays">恢复默认</button>
          </div>
        </div>
      </details>

      <details class="sb-card sb-details">
        <summary>每节课的时间</summary>
        <div class="sb-details__body">
          <p class="sb-hint">填好之后左侧会在节数下面显示时间，悬停预览与导出的表格都会带上。</p>

          <div class="sb-period-grid" data-role="period-inputs"></div>

          <div class="sb-quickfill">
            <span class="sb-quickfill__title">按规律生成</span>
            <label class="sb-quickfill__field">
              <span>第一节开始</span>
              <input class="sb-input" type="time" value="08:00" data-role="qf-start" />
            </label>
            <label class="sb-quickfill__field">
              <span>单节时长（分）</span>
              <input class="sb-input" type="number" min="10" max="300" step="5" value="45" data-role="qf-length" />
            </label>
            <label class="sb-quickfill__field">
              <span>课间休息（分）</span>
              <input class="sb-input" type="number" min="0" max="120" step="5" value="10" data-role="qf-break" />
            </label>
            <button class="sb-btn" type="button" data-action="quickfill">生成到上面</button>
          </div>

          <div class="sb-toolbar">
            <button class="sb-btn sb-btn--primary" type="button" data-action="save-times">保存时间</button>
            <button class="sb-btn" type="button" data-action="clear-times">清空时间</button>
          </div>
        </div>
      </details>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title" data-role="preview-title">课表</h2>
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
    errorPrefix: '课表',
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
    if (previewTitle) previewTitle.textContent = mode === 'image' ? '课表照片' : '课表预览'

    if (gridMeta) {
      gridMeta.textContent =
        mode === 'image'
          ? `${data.images.length} / ${MAX_TIMETABLE_IMAGES} 张`
          : `${weekdays.length} 列 × ${periodCount} 行`
    }

    if (weekdayHost) {
      weekdayHost.innerHTML = weekdays
        .slice(1)
        .map(
          (day, index) =>
            `<label class="sb-weekday">
               <span>第 ${index + 2} 列</span>
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
            <span class="sb-period__label">第 ${index} 节</span>
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
      toast(`保存失败：${formatError(error)}`, 'error')
      paint()
    }
  }

  async function saveRows(rows: PeriodRow[]): Promise<void> {
    try {
      const next = await unwrap(bridge().timetable.save({ rows }))
      data = next
      controller.panel.render(next)
      paint()
      toast('时间已保存', 'success')
    } catch (error) {
      toast(`保存失败：${formatError(error)}`, 'error')
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
      weekdays[index] = value || `第${index}列`
    }
    void saveShape({ weekdays })
  })

  element.querySelector('[data-action="reset-weekdays"]')?.addEventListener('click', () => {
    void saveShape({ weekdays: ['节数', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] })
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
      toast('请先在「第一节开始」里填一个有效时间', 'error')
      return
    }
    if (!Number.isFinite(length) || length < 10 || length > 300) {
      toast('单节时长请填 10–300 分钟', 'error')
      return
    }
    if (!Number.isFinite(gap) || gap < 0 || gap > 120) {
      toast('课间休息请填 0–120 分钟', 'error')
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
    toast('已生成，确认无误后点「保存时间」', 'info')
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
