import { MAX_PERIODS, MIN_PERIODS } from '@shared/limits'

import type { ViewContext, ViewInstance } from '../app-shell'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'

/**
 * 课程表编辑页。
 * 当前已接通：模式切换（表格 / 图片）、节数增减（1–20）。
 * 待接通：单元格编辑、图片上传与 HEIF 转码、持久化。
 */
export function createTimetableEditorView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">课程表</h1>
        <p class="sb-view__desc">表格模式与图片模式互为补充，可随时切换，两种内容都会保留。</p>
      </div>
    </div>

    <div class="sb-notice">
      两种模式的数据会同时保存在本地：切换只影响展示，不会删除另一种模式已经录入的内容。
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">录入方式</h2>
      </div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-radio-row" data-role="mode-row">
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="table" />
            <span>表格模式</span>
          </label>
          <label class="sb-radio">
            <input type="radio" name="tt-mode" value="image" />
            <span>图片模式</span>
          </label>
        </div>

        <div class="sb-field" data-role="period-field" style="max-width:280px;margin-top:14px">
          <label for="period-count">每天节数（${MIN_PERIODS}–${MAX_PERIODS}）</label>
          <input id="period-count" class="sb-input" type="number" min="${MIN_PERIODS}" max="${MAX_PERIODS}" step="1" />
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">表格预览</h2>
        <span class="sb-badge" data-role="grid-meta"></span>
      </div>
      <div class="sb-card" style="overflow:auto">
        <table class="sb-timetable" data-role="grid"></table>
      </div>
    </section>
  `

  const modeRow = element.querySelector<HTMLElement>('[data-role="mode-row"]')
  const periodInput = element.querySelector<HTMLInputElement>('#period-count')
  const grid = element.querySelector<HTMLTableElement>('[data-role="grid"]')
  const gridMeta = element.querySelector<HTMLElement>('[data-role="grid-meta"]')

  function syncFromSettings(): void {
    const settings = ctx.getSettings()
    element.querySelectorAll<HTMLInputElement>('input[name="tt-mode"]').forEach((input) => {
      input.checked = input.value === settings.timetable.mode
    })
    if (periodInput) periodInput.value = String(settings.timetable.periodCount)
    renderGrid(settings.timetable.weekdays, settings.timetable.periodCount)
  }

  function renderGrid(weekdays: readonly string[], periodCount: number): void {
    if (!grid) return
    const head = weekdays
      .map((d, i) => `<th scope="col"${i === 0 ? ' class="sb-timetable__index"' : ''}>${escape(d)}</th>`)
      .join('')

    const rows: string[] = []
    for (let i = 1; i <= periodCount; i += 1) {
      const cells: string[] = [`<th scope="row" class="sb-timetable__index">${i}</th>`]
      for (let d = 1; d < weekdays.length; d += 1) {
        cells.push('<td class="sb-timetable__cell"></td>')
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
    }

    grid.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody>`
    if (gridMeta) gridMeta.textContent = `${weekdays.length} 列 × ${periodCount} 行`
  }

  async function patchTimetable(patch: {
    mode?: 'table' | 'image'
    periodCount?: number
  }): Promise<void> {
    try {
      await unwrap(bridge().settings.patch({ timetable: patch }))
      await ctx.reloadSettings()
      syncFromSettings()
    } catch (error) {
      toast(`保存失败：${formatError(error)}`, 'error')
    }
  }

  modeRow?.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement
    if (target.name !== 'tt-mode') return
    void patchTimetable({ mode: target.value === 'image' ? 'image' : 'table' })
  })

  periodInput?.addEventListener('change', () => {
    const raw = Number.parseInt(periodInput.value, 10)
    if (!Number.isFinite(raw)) {
      syncFromSettings()
      return
    }
    const clamped = Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, raw))
    void patchTimetable({ periodCount: clamped })
  })

  syncFromSettings()

  return {
    element,
    onEnter: async () => {
      await ctx.reloadSettings()
      syncFromSettings()
    }
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}
