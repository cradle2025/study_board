import {
  defaultSemesterFor,
  nextSemester,
  suggestSemester,
  type CourseStatus
} from '@shared/course'
import { MAX_CARD_LEVEL, MAX_CARD_REASON, MAX_CARD_SEMESTER } from '@shared/limits'
import type { CourseCard } from '@shared/types'

import { t } from '../lib/i18n'
import { escapeHtml } from '../lib/html'
import { openModalCard } from '../lib/overlay'

/**
 * 新建 / 修改课程卡片的表单。
 *
 * 单开一个模块而不是留在 `views/study-view.ts` 里：现在有两个页面会用到它
 * （课程与学习、已学库），留在任何一个视图里都会让另一个反向依赖它。
 *
 * 表单是「唯一的完整编辑入口」——卡片脚上的按钮只做状态流转这一件事，
 * 打分、难度、给分标准、学期这些都得双击卡片进来改。
 */

export interface CardFormState {
  courseName: string
  teacher: string
  status: CourseStatus
  semester: string
  reason: string
  score: string
  difficulty: number
  mastery: number
  gradingPolicy: string
  outline: string
}

const FORM_HTML = `
  <div class="sb-modal__title" data-role="title"></div>

  <div class="sb-field" data-role="picker-field" hidden>
    <label for="card-picker">${escapeHtml(t('cardForm.fromTimetable'))}</label>
    <select class="sb-select" id="card-picker" data-field="picker"></select>
  </div>

  <div class="sb-form-pair">
    <div class="sb-field">
      <label for="card-name">${escapeHtml(t('timetable.field.courseName'))}</label>
      <input class="sb-input" id="card-name" data-field="courseName" type="text" maxlength="60" />
    </div>
    <div class="sb-field">
      <label for="card-teacher">${escapeHtml(t('timetable.field.teacher'))}</label>
      <input class="sb-input" id="card-teacher" data-field="teacher" type="text" maxlength="60" />
    </div>
  </div>

  <div class="sb-form-pair">
    <div class="sb-field">
      <label for="card-status">${escapeHtml(t('cardForm.status'))}</label>
      <select class="sb-select" id="card-status" data-field="status">
        <option value="learning">${escapeHtml(t('study.tab.learning'))}</option>
        <option value="wish">${escapeHtml(t('cardForm.status.wish'))}</option>
        <option value="learned">${escapeHtml(t('cardForm.status.learned'))}</option>
      </select>
    </div>
    <div class="sb-field">
      <label for="card-semester" data-role="semester-label">${escapeHtml(t('cardForm.term'))}</label>
      <input class="sb-input" id="card-semester" data-field="semester" type="text"
             maxlength="${MAX_CARD_SEMESTER}" list="card-semester-options" placeholder="${escapeHtml(t('cardForm.termPlaceholder'))}" />
      <datalist id="card-semester-options"></datalist>
    </div>
  </div>

  <div class="sb-field">
    <label for="card-reason" data-role="reason-label">${escapeHtml(t('card.reasonTitle'))}</label>
    <textarea class="sb-textarea" id="card-reason" data-field="reason" rows="2"
              maxlength="${MAX_CARD_REASON}"
              placeholder="${escapeHtml(t('cardForm.reasonPlaceholder'))}"></textarea>
  </div>

  <div class="sb-form-pair">
    <div class="sb-field">
      <label for="card-score">${escapeHtml(t('cardForm.score'))}</label>
      <input class="sb-input" id="card-score" data-field="score" type="text" maxlength="60" placeholder="${escapeHtml(t('cardForm.scorePlaceholder'))}" />
    </div>
    <div class="sb-field">
      <label for="card-difficulty">${escapeHtml(t('card.difficulty'))}</label>
      <select class="sb-select" id="card-difficulty" data-field="difficulty"></select>
    </div>
    <div class="sb-field">
      <label for="card-mastery">${escapeHtml(t('cardForm.mastery'))}</label>
      <select class="sb-select" id="card-mastery" data-field="mastery"></select>
    </div>
  </div>

  <div class="sb-field">
    <label for="card-grading">${escapeHtml(t('cardForm.grading'))}</label>
    <textarea class="sb-textarea" id="card-grading" data-field="gradingPolicy" rows="3"></textarea>
  </div>
  <div class="sb-field">
    <label for="card-outline">${escapeHtml(t('cardForm.outline'))}</label>
    <textarea class="sb-textarea" id="card-outline" data-field="outline" rows="3"></textarea>
  </div>

  <p class="sb-hint" data-role="error" hidden></p>
  <div class="sb-modal__actions">
    <button class="sb-btn" type="button" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
    <button class="sb-btn sb-btn--primary" type="button" data-role="save">${escapeHtml(t('common.save'))}</button>
  </div>
`

function fillLevels(select: HTMLSelectElement | null): void {
  if (!select) return
  select.innerHTML = [
    `<option value="0">${escapeHtml(t('card.unset'))}</option>`,
    ...Array.from({ length: MAX_CARD_LEVEL }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`)
  ].join('')
}

/**
 * 学期候选。从一年前那个学期起往后连排四个，刚好覆盖「刚过去的 / 当前的 / 两个未来的」。
 *
 * 用 `nextSemester` 连推而不再写一套倒推逻辑：学期只有一种写法，
 * 认它、写它、推它的规则都该在同一处（`shared/course.ts`）。
 */
function semesterOptions(): string[] {
  const now = new Date()
  const base = suggestSemester(new Date(now.getFullYear() - 1, now.getMonth(), 1))
  const options = [base]
  for (let i = 0; i < 3; i += 1) options.push(nextSemester(options[options.length - 1] as string))
  return options
}

/** 弹出新建 / 编辑表单；取消返回 null */
export function openCardForm(
  existing: CourseCard | null,
  courses: readonly { courseName: string; teacher: string }[],
  defaultStatus: CourseStatus
): Promise<CardFormState | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = FORM_HTML

    const title = modal.card.querySelector<HTMLElement>('[data-role="title"]')
    const pickerField = modal.card.querySelector<HTMLElement>('[data-role="picker-field"]')
    const picker = modal.card.querySelector<HTMLSelectElement>('[data-field="picker"]')
    const nameInput = modal.card.querySelector<HTMLInputElement>('[data-field="courseName"]')
    const teacherInput = modal.card.querySelector<HTMLInputElement>('[data-field="teacher"]')
    const statusSelect = modal.card.querySelector<HTMLSelectElement>('[data-field="status"]')
    const semesterInput = modal.card.querySelector<HTMLInputElement>('[data-field="semester"]')
    const semesterLabel = modal.card.querySelector<HTMLElement>('[data-role="semester-label"]')
    const semesterList = modal.card.querySelector<HTMLDataListElement>('#card-semester-options')
    const reasonInput = modal.card.querySelector<HTMLTextAreaElement>('[data-field="reason"]')
    const reasonLabel = modal.card.querySelector<HTMLElement>('[data-role="reason-label"]')
    const scoreInput = modal.card.querySelector<HTMLInputElement>('[data-field="score"]')
    const difficulty = modal.card.querySelector<HTMLSelectElement>('[data-field="difficulty"]')
    const mastery = modal.card.querySelector<HTMLSelectElement>('[data-field="mastery"]')
    const grading = modal.card.querySelector<HTMLTextAreaElement>('[data-field="gradingPolicy"]')
    const outline = modal.card.querySelector<HTMLTextAreaElement>('[data-field="outline"]')
    const errorEl = modal.card.querySelector<HTMLElement>('[data-role="error"]')
    const cancelBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const saveBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="save"]')

    if (semesterList) {
      semesterList.innerHTML = semesterOptions()
        .map((value) => `<option value="${value}"></option>`)
        .join('')
    }

    const isEdit = existing !== null
    if (title) title.textContent = t(isEdit ? 'cardForm.editTitle' : 'cardForm.createTitle')
    if (nameInput && existing) nameInput.value = existing.courseName
    if (teacherInput && existing) teacherInput.value = existing.teacher
    if (scoreInput && existing) scoreInput.value = existing.score
    if (grading && existing) grading.value = existing.gradingPolicy
    if (outline && existing) outline.value = existing.outline
    if (reasonInput && existing) reasonInput.value = existing.reason

    fillLevels(difficulty)
    fillLevels(mastery)
    if (difficulty) difficulty.value = String(existing?.difficulty ?? 0)
    if (mastery) mastery.value = String(existing?.mastery ?? 0)

    // —— 状态 / 学期 / 想修理由 这三者联动
    //
    // 学期给一个默认值，但**只在这个框里还是我们填的那个值**时跟着状态走。
    // 用户自己敲过之后就不再动它——不然「改成想学」会把他写好的学期冲掉
    let currentStatus: CourseStatus = existing?.status ?? defaultStatus
    let autoSemester = defaultSemesterFor(currentStatus)
    let semesterTouched = (existing?.semester.trim().length ?? 0) > 0
    if (statusSelect) statusSelect.value = currentStatus
    if (semesterInput) semesterInput.value = existing?.semester.trim() || autoSemester

    function syncStatusFields(): void {
      if (statusSelect) currentStatus = statusSelect.value as CourseStatus
      const next = defaultSemesterFor(currentStatus)
      if (semesterInput && (!semesterTouched || semesterInput.value.trim() === autoSemester)) {
        semesterInput.value = next
      }
      autoSemester = next

      // 同一句「理由」在两个阶段问的其实是同一件事，标签就换一种说法
      if (semesterLabel) semesterLabel.textContent = t(currentStatus === 'wish' ? 'cardForm.plannedTerm' : 'cardForm.term')
      if (reasonLabel) reasonLabel.textContent = t(currentStatus === 'wish' ? 'card.reasonTitle' : 'cardForm.reasonPast')
    }
    syncStatusFields()

    semesterInput?.addEventListener('input', () => {
      semesterTouched = true
    })
    statusSelect?.addEventListener('change', syncStatusFields)

    // 课表里有课才显示挑选器；编辑已有卡片时不显示（避免误改成一门别的课）
    const canPick = !isEdit && courses.length > 0
    if (pickerField && picker && canPick) {
      pickerField.hidden = false
      picker.innerHTML = [
        `<option value="">${escapeHtml(t('cardForm.manual'))}</option>`,
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
        showError(t('cardForm.nameRequired'))
        nameInput?.focus()
        return
      }
      done({
        courseName,
        teacher: (teacherInput?.value ?? '').replace(/\s+/g, ' ').trim(),
        status: (statusSelect?.value ?? defaultStatus) as CourseStatus,
        semester: (semesterInput?.value ?? '').replace(/\s+/g, ' ').trim(),
        reason: reasonInput?.value.trim() ?? '',
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
