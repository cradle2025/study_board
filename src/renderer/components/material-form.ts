import { MATERIAL_KIND_LABEL, isImageExtension, isMaterialExtension } from '@shared/materials'
import type { MaterialInboxCandidate, MaterialItem } from '@shared/types'

import { escapeHtml } from '../lib/html'
import { openModalCard } from '../lib/overlay'

/**
 * 课程资料的三个对话框：导入（拖拽 / 按钮 / 收件箱共用一套归属选择）、
 * 重命名、改归属。
 *
 * 表单类 UI 抽成独立模块：资料页、课程与学习页、全局拖拽都要用，
 * 留在任何一个视图里都会让别的视图反向依赖它。
 */

export interface MaterialImportDialogResult {
  courseCardId: string
  /** 单文件时允许用户给一个名字；多文件时为空（各自用原文件名） */
  title: string
}

export interface MaterialCourseCard {
  id: string
  courseName: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function courseOptionsHtml(cards: readonly MaterialCourseCard[]): string {
  return [
    '<option value="">未归类（以后再整理）</option>',
    ...cards.map(
      (card) => `<option value="${escapeHtml(card.id)}">${escapeHtml(card.courseName)}</option>`
    )
  ].join('')
}

function bindDialog(
  modal: { card: HTMLElement; close(): void },
  onSubmit: () => void
): void {
  const cancel = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
  const save = modal.card.querySelector<HTMLButtonElement>('[data-role="save"]')
  cancel?.addEventListener('click', () => modal.close())
  save?.addEventListener('click', onSubmit)
  modal.card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (document.activeElement instanceof HTMLTextAreaElement) return
    if (document.activeElement instanceof HTMLSelectElement) return
    event.preventDefault()
    onSubmit()
  })
}

/**
 * 导入归属对话框。
 *
 * `mode: 'inbox'` 时文件来自收件箱（文件名列表），`'paths'` 时来自拖拽 / 对话框
 * （带绝对路径，渲染层只负责展示名字，路径原样传回主进程）。
 * 取消返回 null。
 */
export function openMaterialImportDialog(
  entries: readonly { name: string; bytes: number; path?: string }[],
  cards: readonly MaterialCourseCard[]
): Promise<MaterialImportDialogResult | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = `
      <div class="sb-modal__title">导入课程资料</div>
      <p class="sb-hint">这些文件会**复制**进资料库并按课程命名；${
        '下载目录里的原件保持不动。'
      }</p>
      <ul class="sb-material-pick">
        ${entries
          .map((entry) => {
            const dot = entry.name.lastIndexOf('.')
            const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : ''
            const ok = isMaterialExtension(ext)
            return `
              <li class="sb-material-pick__item${ok ? '' : ' sb-material-pick__item--bad'}">
                <span class="sb-material-pick__name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
                <span class="sb-material-pick__meta">
                  ${ok ? escapeHtml(MATERIAL_KIND_LABEL[ext as keyof typeof MATERIAL_KIND_LABEL]) : '不支持的类型'}
                  · ${formatBytes(entry.bytes)}
                </span>
              </li>
            `
          })
          .join('')}
      </ul>
      <div class="sb-field">
        <label for="material-course">归属课程</label>
        <select class="sb-select" id="material-course" data-field="course"></select>
      </div>
      ${
        entries.length === 1
          ? `<div class="sb-field">
               <label for="material-title">资料名（选填，默认用原文件名）</label>
               <input class="sb-input" id="material-title" data-field="title" type="text" maxlength="80" />
             </div>`
          : ''
      }
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="save">导入</button>
      </div>
    `

    const course = modal.card.querySelector<HTMLSelectElement>('[data-field="course"]')
    const title = modal.card.querySelector<HTMLInputElement>('[data-field="title"]')
    if (course) course.innerHTML = courseOptionsHtml(cards)

    let settled = false
    const done = (value: MaterialImportDialogResult | null): void => {
      if (settled) return
      settled = true
      modal.close()
      resolve(value)
    }

    bindDialog(modal, () => {
      // 全部文件都不支持类型时不让白点一次
      const anyOk = entries.some((entry) => {
        const dot = entry.name.lastIndexOf('.')
        return isMaterialExtension(dot >= 0 ? entry.name.slice(dot + 1) : '')
      })
      if (!anyOk) return
      done({
        courseCardId: course?.value ?? '',
        title: title?.value.trim() ?? ''
      })
    })
  })
}

/** 重命名对话框。取消返回 null */
export function openMaterialRenameDialog(item: MaterialItem): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = `
      <div class="sb-modal__title">重命名资料</div>
      <div class="sb-field">
        <label for="material-rename">资料名</label>
        <input class="sb-input" id="material-rename" data-field="title" type="text" maxlength="80" />
        <p class="sb-hint">文件名会跟着改（保留扩展名与课程前缀）。</p>
      </div>
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="save">保存</button>
      </div>
    `
    const input = modal.card.querySelector<HTMLInputElement>('[data-field="title"]')
    if (input) {
      input.value = item.title
      input.select()
    }

    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      modal.close()
      resolve(value)
    }

    bindDialog(modal, () => {
      const value = input?.value.trim() ?? ''
      if (value.length === 0) return
      done(value)
    })
  })
}

/** 改归属对话框。取消返回 null（注意：选「未归类」返回空串，不是 null） */
export function openMaterialCourseDialog(
  item: MaterialItem,
  cards: readonly MaterialCourseCard[]
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = `
      <div class="sb-modal__title">改归属课程</div>
      <p class="sb-hint">「${escapeHtml(item.title)}」归属到哪门课？</p>
      <div class="sb-field">
        <label for="material-course-move">课程</label>
        <select class="sb-select" id="material-course-move" data-field="course"></select>
      </div>
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="save">保存</button>
      </div>
    `
    const course = modal.card.querySelector<HTMLSelectElement>('[data-field="course"]')
    if (course) {
      course.innerHTML = courseOptionsHtml(cards)
      course.value = item.courseCardId
    }

    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      modal.close()
      resolve(value)
    }

    bindDialog(modal, () => done(course?.value ?? ''))
  })
}

/** 资料选择对话框（笔记里插引用用）。取消返回 null */
export function openMaterialPickDialog(
  items: readonly MaterialItem[],
  preselectCardId: string,
  options: { imagesOnly?: boolean } = {}
): Promise<MaterialItem | null> {
  return new Promise((resolve) => {
    // 只挑图片时先把非图片滤掉。留在列表里再灰掉会更「完整」，
    // 但用户的意图已经很明确了（点的是「插入图片」），
    // 让他从一堆 PDF 里往下翻找那两张图是纯粹的浪费
    const pool = options.imagesOnly
      ? items.filter((item) => isImageExtension(item.ext))
      : items
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = `
      <div class="sb-modal__title">${options.imagesOnly ? '插入图片' : '插入资料引用'}</div>
      <p class="sb-hint">${
        options.imagesOnly
          ? '图片以 Markdown 语法插入，在编辑器和导出的文档里都会直接显示。'
          : '引用以 Obsidian 语法插入，Obsidian 里能直接预览 PDF 和图片。'
      }</p>
      <div class="sb-field">
        <label for="material-pick">选择资料</label>
        <select class="sb-select" id="material-pick" data-field="pick"></select>
      </div>
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="save">插入</button>
      </div>
    `
    const pick = modal.card.querySelector<HTMLSelectElement>('[data-field="pick"]')
    if (pick) {
      const preferred = pool.filter((item) => item.courseCardId === preselectCardId)
      const rest = pool.filter((item) => item.courseCardId !== preselectCardId && !item.missing)
      const option = (item: MaterialItem): string =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.fileName)}</option>`
      pick.innerHTML = [
        ...(preferred.length > 0
          ? ['<optgroup label="本课资料">', ...preferred.map(option), '</optgroup>']
          : []),
        ...(rest.length > 0
          ? ['<optgroup label="全部资料">', ...rest.map(option), '</optgroup>']
          : [])
      ].join('')
      if (pick.options.length === 0) {
        modal.close()
        resolve(null)
        return
      }
    }

    let settled = false
    const done = (value: MaterialItem | null): void => {
      if (settled) return
      settled = true
      modal.close()
      resolve(value)
    }

    bindDialog(modal, () => {
      const chosen = pool.find((item) => item.id === pick?.value)
      done(chosen ?? null)
    })
  })
}

/** 收件箱候选的展示名去掉了扩展名前的目录部分（主进程只给文件名） */
export function inboxCandidateEntries(
  candidates: readonly MaterialInboxCandidate[]
): { name: string; bytes: number }[] {
  return candidates.map((candidate) => ({ name: candidate.fileName, bytes: candidate.bytes }))
}
