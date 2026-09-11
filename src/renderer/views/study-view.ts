import { MAX_CARD_LEVEL } from '@shared/limits'
import type { CourseCard } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { createCardController, type CardController } from '../components/card-controller'
import { createPortalController } from '../components/portal-controller'
import { escapeHtml } from '../lib/html'
import { toast } from '../lib/ipc'
import { openModalCard } from '../lib/overlay'

/**
 * 模块二：课程与学习。
 *
 * 需求里这一块是「以卡片形式展示课程（卡片可点击翻转）」，
 * 卡片连接着一篇可编辑的笔记，正面是课程名 / 老师 / 打分 / 难度 / 掌握程度，
 * 背面是给分标准与课程结构。
 *
 * 一个刻意的取舍：**新建卡片时课程名和老师可以从课表直接带过来**
 * （需求：「如果前面的课程表是以表格方式填写则……直接从表格中自动拷贝填写」）。
 * 但不强制——课表还没填、或者想加一门课表里没有的课，也应该能建卡片。
 */

interface CardFormState {
  courseName: string
  teacher: string
  score: string
  difficulty: number
  mastery: number
  gradingPolicy: string
  outline: string
}

const FORM_HTML = `
  <div class="sb-modal__title" data-role="title"></div>

  <div class="sb-field" data-role="picker-field" hidden>
    <label for="card-picker">从课表带过来</label>
    <select class="sb-select" id="card-picker" data-field="picker"></select>
  </div>

  <div class="sb-form-pair">
    <div class="sb-field">
      <label for="card-name">课程名称</label>
      <input class="sb-input" id="card-name" data-field="courseName" type="text" maxlength="60" />
    </div>
    <div class="sb-field">
      <label for="card-teacher">授课老师</label>
      <input class="sb-input" id="card-teacher" data-field="teacher" type="text" maxlength="60" />
    </div>
  </div>

  <div class="sb-form-pair">
    <div class="sb-field">
      <label for="card-score">打分</label>
      <input class="sb-input" id="card-score" data-field="score" type="text" maxlength="60" placeholder="95 / A / 优秀" />
    </div>
    <div class="sb-field">
      <label for="card-difficulty">难度</label>
      <select class="sb-select" id="card-difficulty" data-field="difficulty"></select>
    </div>
    <div class="sb-field">
      <label for="card-mastery">掌握程度</label>
      <select class="sb-select" id="card-mastery" data-field="mastery"></select>
    </div>
  </div>

  <div class="sb-field">
    <label for="card-grading">给分标准（背面，可空）</label>
    <textarea class="sb-textarea" id="card-grading" data-field="gradingPolicy" rows="3"></textarea>
  </div>
  <div class="sb-field">
    <label for="card-outline">课程大致结构（背面，可空）</label>
    <textarea class="sb-textarea" id="card-outline" data-field="outline" rows="3"></textarea>
  </div>

  <p class="sb-hint" data-role="error" hidden></p>
  <div class="sb-modal__actions">
    <button class="sb-btn" type="button" data-role="cancel">取消</button>
    <button class="sb-btn sb-btn--primary" type="button" data-role="save">保存</button>
  </div>
`

function fillLevels(select: HTMLSelectElement | null): void {
  if (!select) return
  select.innerHTML = [
    '<option value="0">未填</option>',
    ...Array.from({ length: MAX_CARD_LEVEL }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`)
  ].join('')
}

/** 弹出新建 / 编辑表单；取消返回 null */
function openCardForm(
  existing: CourseCard | null,
  courses: readonly { courseName: string; teacher: string }[]
): Promise<CardFormState | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = FORM_HTML

    const title = modal.card.querySelector<HTMLElement>('[data-role="title"]')
    const pickerField = modal.card.querySelector<HTMLElement>('[data-role="picker-field"]')
    const picker = modal.card.querySelector<HTMLSelectElement>('[data-field="picker"]')
    const nameInput = modal.card.querySelector<HTMLInputElement>('[data-field="courseName"]')
    const teacherInput = modal.card.querySelector<HTMLInputElement>('[data-field="teacher"]')
    const scoreInput = modal.card.querySelector<HTMLInputElement>('[data-field="score"]')
    const difficulty = modal.card.querySelector<HTMLSelectElement>('[data-field="difficulty"]')
    const mastery = modal.card.querySelector<HTMLSelectElement>('[data-field="mastery"]')
    const grading = modal.card.querySelector<HTMLTextAreaElement>('[data-field="gradingPolicy"]')
    const outline = modal.card.querySelector<HTMLTextAreaElement>('[data-field="outline"]')
    const errorEl = modal.card.querySelector<HTMLElement>('[data-role="error"]')
    const cancelBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const saveBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="save"]')

    const isEdit = existing !== null
    if (title) title.textContent = isEdit ? '修改课程卡片' : '新建课程卡片'
    if (nameInput && existing) nameInput.value = existing.courseName
    if (teacherInput && existing) teacherInput.value = existing.teacher
    if (scoreInput && existing) scoreInput.value = existing.score
    if (grading && existing) grading.value = existing.gradingPolicy
    if (outline && existing) outline.value = existing.outline

    fillLevels(difficulty)
    fillLevels(mastery)
    if (difficulty) difficulty.value = String(existing?.difficulty ?? 0)
    if (mastery) mastery.value = String(existing?.mastery ?? 0)

    // 课表里有课才显示挑选器；编辑已有卡片时不显示（避免误改成一门别的课）
    const canPick = !isEdit && courses.length > 0
    if (pickerField && picker && canPick) {
      pickerField.hidden = false
      picker.innerHTML = [
        '<option value="">— 手动填写 —</option>',
        ...courses.map(
          (course, index) =>
            `<option value="${index}">${escapeHtml(
              course.teacher ? `${course.courseName} · ${course.teacher}` : course.courseName
            )}</option>`
        )
      ].join('')
      picker.addEventListener('change', () => {
        const index = Number(picker.value)
        const picked = courses[index]
        if (!picked) return
        if (nameInput) nameInput.value = picked.courseName
        if (teacherInput) teacherInput.value = picked.teacher
      })
    }

    let settled = false
    const done = (value: CardFormState | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeyDown, true)
      modal.close()
      resolve(value)
    }

    function showError(message: string): void {
      if (!errorEl) return
      errorEl.textContent = message
      errorEl.hidden = false
    }

    function submit(): void {
      const courseName = (nameInput?.value ?? '').replace(/\s+/g, ' ').trim()
      if (courseName.length === 0) {
        showError('请填写课程名称')
        nameInput?.focus()
        return
      }
      done({
        courseName,
        teacher: (teacherInput?.value ?? '').replace(/\s+/g, ' ').trim(),
        score: (scoreInput?.value ?? '').replace(/\s+/g, ' ').trim(),
        difficulty: Number(difficulty?.value ?? 0),
        mastery: Number(mastery?.value ?? 0),
        gradingPolicy: grading?.value.trim() ?? '',
        outline: outline?.value.trim() ?? ''
      })
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter') return
      // 多行文本框里回车是换行，不能当提交
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement) return
      if (active instanceof HTMLSelectElement) return
      event.preventDefault()
      submit()
    }

    cancelBtn?.addEventListener('click', () => done(null))
    saveBtn?.addEventListener('click', submit)
    document.addEventListener('keydown', onKeyDown, true)

    nameInput?.focus()
    if (nameInput && existing) nameInput.select()
  })
}

export function createStudyView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">课程与学习</h1>
        <p class="sb-view__desc">每门课一张卡片，点一下翻到背面看给分标准和课程结构，双击修改。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="to-notes">全部笔记</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="add">新建卡片</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">课程卡片</h2>
        <span class="sb-badge" data-role="meta">模块二</span>
      </div>
      <div data-role="cards"></div>
      <p class="sb-hint">
        新建卡片时会自动在笔记库里建一篇同名笔记（标题为「课程名_老师」），
        之后在卡片下方点「记笔记」就能直接跳过去。
      </p>
    </section>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">网站门户</h2>
        <div class="sb-toolbar">
          <button class="sb-btn" type="button" data-action="to-portal">管理站点</button>
        </div>
      </div>
      <div data-role="portal"></div>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="cards"]')
  const meta = element.querySelector<HTMLElement>('[data-role="meta"]')

  const controller: CardController = createCardController({
    editable: true,
    onData(cards) {
      if (!meta) return
      const linked = cards.filter((card) => card.noteId.length > 0).length
      meta.textContent =
        cards.length === 0 ? '还没有卡片' : `${cards.length} 张 · ${linked} 张已连笔记`
    },
    onEdit(card) {
      void openCardForm(card, controller.courses()).then(async (result) => {
        if (!result) return
        try {
          await controller.upsert({ id: card.id, ...result })
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    },
    onOpenNote(card) {
      if (card.noteId.length === 0) {
        toast('这门课还没有笔记，去笔记页新建一篇', 'info')
        ctx.navigate('notes')
        return
      }
      ctx.openNote(card.noteId)
    }
  })

  slot?.appendChild(controller.grid.element)

  // 门户在这里只做快捷启动，管理动作在「网站门户」页——同一个渲染器，两种 editable
  const portal = createPortalController({ editable: false })
  element.querySelector<HTMLElement>('[data-role="portal"]')?.appendChild(portal.grid.element)

  element.querySelector('[data-action="add"]')?.addEventListener('click', () => {
    void openCardForm(null, controller.courses()).then(async (result) => {
      if (!result) return
      try {
        await controller.upsert(result)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  })

  element.querySelector('[data-action="to-notes"]')?.addEventListener('click', () => ctx.navigate('notes'))
  element.querySelector('[data-action="to-portal"]')?.addEventListener('click', () => ctx.navigate('portal'))

  return {
    element,
    async onEnter() {
      await controller.load()
      await portal.load()
    },
    dispose() {
      controller.dispose()
      portal.dispose()
    }
  }
}
