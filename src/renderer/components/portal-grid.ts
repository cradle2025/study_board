import { displayHost, initialOf } from '@shared/portal'
import type { PortalSite } from '@shared/types'

import { t } from '../lib/i18n'
import { escapeHtml } from '../lib/html'

/**
 * 网站门户网格：概览页与管理页共用同一个渲染器。
 *
 * 与课表面板是同一个套路——「快捷启动」和「管理站点」看的是同一份数据，
 * 各写一套迟早会出现「首页点了能开、管理页显示不出来」这类偏差。
 *
 * 区别只在于 `editable`：
 *  - false（概览页）：只显示未隐藏的站点，点一下就打开；
 *  - true（管理页）：连隐藏的一起显示（半透明），并带出操作按钮。
 */

/** 图标走与主进程 assetProtocol 对应的自有协议 */
function iconUrl(fileName: string): string {
  return `sb-asset://icon/${encodeURIComponent(fileName)}`
}

/** 从网址里取主机名用于副标题；拿不到就显示整条网址 */
function hostOf(site: PortalSite): string {
  try {
    return displayHost(new URL(site.url).hostname)
  } catch {
    return site.url
  }
}

export interface PortalGridOptions {
  editable: boolean
  /** 点击站点本体 */
  onOpen(site: PortalSite): void
  /** 编辑（仅 editable） */
  onEdit?(site: PortalSite): void
  /** 重新抓取图标（仅 editable） */
  onRefetchIcon?(site: PortalSite): void
  /** 隐藏 / 取消隐藏（仅 editable） */
  onToggleHidden?(site: PortalSite): void
  /** 删除（仅 editable） */
  onRemove?(site: PortalSite): void
}

export interface PortalGridHandle {
  element: HTMLElement
  render(sites: readonly PortalSite[]): void
  /** 当前渲染出来的站点数，供视图判断空态 */
  count(): number
  dispose(): void
}

function iconHtml(site: PortalSite): string {
  if (site.iconFile) {
    return `<img class="sb-portal__img" src="${escapeHtml(iconUrl(site.iconFile))}" alt="" loading="lazy" />`
  }
  return `<span class="sb-portal__letter" aria-hidden="true">${escapeHtml(initialOf(site.name))}</span>`
}

function actionsHtml(site: PortalSite): string {
  return `
    <span class="sb-portal__actions">
      <button class="sb-iconbtn" type="button" data-act="edit" title="${escapeHtml(t('common.edit'))}" aria-label="${escapeHtml(t('portal.editLabel', { name: site.name }))}">✎</button>
      <button class="sb-iconbtn" type="button" data-act="icon" title="${escapeHtml(t('portal.refetchIcon'))}" aria-label="${escapeHtml(t('portal.refetchIconLabel', { name: site.name }))}">⟳</button>
      <button class="sb-iconbtn" type="button" data-act="hide" title="${escapeHtml(t(site.hidden ? 'portal.show' : 'portal.hide'))}" aria-label="${escapeHtml(t(site.hidden ? 'portal.show' : 'portal.hide'))} ${escapeHtml(site.name)}">${site.hidden ? '◌' : '◉'}</button>
      <button class="sb-iconbtn sb-iconbtn--danger" type="button" data-act="remove" title="${escapeHtml(t(site.builtin ? 'portal.builtinNoRemove' : 'common.delete'))}" aria-label="${escapeHtml(site.builtin ? t('portal.builtinNoRemove') : t('portal.removeLabel', { name: site.name }))}" ${site.builtin ? 'disabled' : ''}>✕</button>
    </span>
  `
}

function tileHtml(site: PortalSite, editable: boolean): string {
  const hidden = site.hidden ? ' sb-portal__item--hidden' : ''
  const builtin = site.builtin ? ' sb-portal__item--builtin' : ''
  return `
    <div class="sb-portal__item${hidden}${builtin}" data-id="${escapeHtml(site.id)}" style="--site-color: ${escapeHtml(site.color)}">
      <button class="sb-portal__hit" type="button" data-act="open" title="${escapeHtml(site.url)}">
        <span class="sb-portal__icon">${iconHtml(site)}</span>
        <span class="sb-portal__text">
          <span class="sb-portal__name">${escapeHtml(site.name)}</span>
          <span class="sb-portal__host">${escapeHtml(hostOf(site))}</span>
        </span>
      </button>
      ${editable ? actionsHtml(site) : ''}
    </div>
  `
}

export function createPortalGrid(options: PortalGridOptions): PortalGridHandle {
  const element = document.createElement('div')
  element.className = 'sb-portal'

  const grid = document.createElement('div')
  grid.className = 'sb-portal__grid'
  element.appendChild(grid)

  const empty = document.createElement('p')
  empty.className = 'sb-empty'
  empty.textContent = options.editable
    ? t('portal.emptyWithAction')
    : t('portal.empty')
  empty.hidden = true
  element.appendChild(empty)

  let sites: readonly PortalSite[] = []

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    const button = target.closest<HTMLElement>('[data-act]')
    if (!button) return

    const act = button.dataset['act']
    const host = button.closest<HTMLElement>('[data-id]')
    const id = host?.dataset['id']
    const site = id ? sites.find((item) => item.id === id) : undefined
    if (!site) return

    // 操作按钮不能顺带触发「打开网站」——点删除结果先跳浏览器可太糟了
    event.stopPropagation()

    switch (act) {
      case 'open':
        options.onOpen(site)
        break
      case 'edit':
        options.onEdit?.(site)
        break
      case 'icon':
        options.onRefetchIcon?.(site)
        break
      case 'hide':
        options.onToggleHidden?.(site)
        break
      case 'remove':
        options.onRemove?.(site)
        break
      default:
        break
    }
  }

  grid.addEventListener('click', onClick)

  return {
    element,
    render(next) {
      sites = next
      const visible = options.editable ? sites : sites.filter((site) => !site.hidden)
      grid.innerHTML = visible.map((site) => tileHtml(site, options.editable)).join('')
      empty.hidden = visible.length > 0
    },
    count() {
      return options.editable ? sites.length : sites.filter((site) => !site.hidden).length
    },
    dispose() {
      grid.removeEventListener('click', onClick)
    }
  }
}
