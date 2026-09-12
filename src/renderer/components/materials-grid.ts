import { MATERIAL_KIND_LABEL } from '@shared/materials'
import type { MaterialItem } from '@shared/types'

import { escapeHtml } from '../lib/html'

/**
 * 课程资料网格：按课程分组展示，新的导入排前面。
 *
 * 与课程卡片网格同一套「纯渲染」约定——只认数据和回调，不认识 IPC。
 * 分组在这里做而不是控制器：控制器管数据，「同一门课的资料摆在一起」是长相问题。
 */

export interface MaterialGridOptions {
  onOpen?(item: MaterialItem): void
  onRename?(item: MaterialItem): void
  onRemove?(item: MaterialItem): void
  onSetCard?(item: MaterialItem): void
  /** 课程卡片 id → 课程名（未归类 / 卡片已删返回空串） */
  courseNameOf(cardId: string): string
}

export interface MaterialGridHandle {
  element: HTMLElement
  render(items: readonly MaterialItem[]): void
  count(): number
  dispose(): void
}

/** 人话大小：KB / MB，够用就好 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const UNKNOWN_COURSE = '未归类'

function rowHtml(item: MaterialItem): string {
  const lost = item.missing
  const kind = MATERIAL_KIND_LABEL[item.ext]
  return `
    <div class="sb-material${lost ? ' sb-material--lost' : ''}" data-id="${escapeHtml(item.id)}">
      <span class="sb-material__kind" title="${escapeHtml(kind)}">${escapeHtml(item.ext.toUpperCase())}</span>
      <span class="sb-material__main">
        <span class="sb-material__title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
        <span class="sb-material__meta">
          ${escapeHtml(kind)} · ${formatBytes(item.bytes)}
          ${lost ? ' · <b>文件丢失</b>（可能被移动或删除）' : ''}
        </span>
      </span>
      <span class="sb-material__actions">
        ${
          lost
            ? ''
            : `<button class="sb-btn sb-btn--sm" type="button" data-act="open" title="用系统默认程序打开">打开</button>`
        }
        <button class="sb-iconbtn" type="button" data-act="rename" title="重命名" aria-label="重命名 ${escapeHtml(item.title)}">✎</button>
        <button class="sb-iconbtn" type="button" data-act="setcard" title="改归属课程">⇄</button>
        <button class="sb-iconbtn sb-iconbtn--danger" type="button" data-act="remove" title="删除（进回收站）" aria-label="删除 ${escapeHtml(item.title)}">✕</button>
      </span>
    </div>
  `
}

export function createMaterialsGrid(options: MaterialGridOptions): MaterialGridHandle {
  const element = document.createElement('div')
  element.className = 'sb-materials'

  const empty = document.createElement('p')
  empty.className = 'sb-empty'
  empty.textContent = '还没有课程资料。把下载好的 PDF / PPT 直接拖进窗口，或点「导入资料」。'
  empty.hidden = true
  element.appendChild(empty)

  const body = document.createElement('div')
  element.appendChild(body)

  let items: readonly MaterialItem[] = []

  function renderGroups(next: readonly MaterialItem[]): void {
    items = next

    // 分组键 = 课程名。同一门课的资料摆在一起，课程改名了分组自动跟着走；
    // 未归类（含卡片已删）排最后
    const groups = new Map<string, MaterialItem[]>()
    for (const item of next) {
      const name = options.courseNameOf(item.courseCardId) || UNKNOWN_COURSE
      const bucket = groups.get(name)
      if (bucket) bucket.push(item)
      else groups.set(name, [item])
    }

    const ordered = [...groups.entries()].sort((a, b) => {
      if (a[0] === UNKNOWN_COURSE) return 1
      if (b[0] === UNKNOWN_COURSE) return -1
      return a[0].localeCompare(b[0], 'zh-Hans-CN')
    })

    body.innerHTML = ordered
      .map(([course, list]) => {
        const lostCount = list.filter((item) => item.missing).length
        return `
          <section class="sb-materials__group">
            <div class="sb-materials__group-head">
              <h3 class="sb-materials__group-title">${escapeHtml(course)}</h3>
              <span class="sb-materials__group-count">
                ${list.length} 份${lostCount > 0 ? ` · ${lostCount} 份丢失` : ''}
              </span>
            </div>
            ${list.map((item) => rowHtml(item)).join('')}
          </section>
        `
      })
      .join('')

    empty.hidden = next.length > 0
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    const host = target.closest<HTMLElement>('.sb-material')
    if (!host) return
    const item = items.find((entry) => entry.id === host.dataset['id'])
    if (!item) return
    const act = target.closest<HTMLElement>('[data-act]')?.dataset['act']
    if (act === 'open') options.onOpen?.(item)
    else if (act === 'rename') options.onRename?.(item)
    else if (act === 'remove') options.onRemove?.(item)
    else if (act === 'setcard') options.onSetCard?.(item)
  }

  body.addEventListener('click', onClick)

  return {
    element,
    render: renderGroups,
    count: () => items.length,
    dispose() {
      body.removeEventListener('click', onClick)
    }
  }
}
