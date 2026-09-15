import type { PortalSite, PortalSiteInput } from '@shared/types'

import { t, tm } from '../lib/i18n'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { createPortalGrid, type PortalGridHandle } from './portal-grid'

/**
 * 门户的读写控制器。
 *
 * 概览页与管理页都要「加载 / 新增 / 改 / 删 / 抓图标」，抽到这里，
 * 两个页面只决定长什么样，不重复实现业务与错误处理。
 */

export interface PortalControllerOptions {
  editable: boolean
  onData?(sites: readonly PortalSite[]): void
  /** 点「编辑」时由视图弹出自己的表单——控制器不认识「表单」这个 UI 概念 */
  onEdit?(site: PortalSite): void
}

export interface PortalController {
  grid: PortalGridHandle
  current(): readonly PortalSite[]
  load(): Promise<readonly PortalSite[]>
  upsert(input: PortalSiteInput): Promise<void>
  refetchIcon(site: PortalSite): Promise<void>
  dispose(): void
}

export function createPortalController(options: PortalControllerOptions): PortalController {
  let sites: readonly PortalSite[] = []

  const apply = (next: readonly PortalSite[]): void => {
    sites = next
    grid.render(next)
    options.onData?.(next)
  }

  // 抓取图标是一次真实网络请求，慢。用这个标志兜住连点：
  // 连点两次不该发出两个请求、更不该弹两条互相矛盾的提示。
  let fetching = false

  const grid: PortalGridHandle = createPortalGrid({
    editable: options.editable,

    onOpen(site) {
      void bridge()
        .app.openExternal(site.url)
        .then((result) => {
          if (!result.ok) toast(t('portal.openLinkFailed', { reason: tm(result.error ?? '') }), 'error')
        })
    },

    onEdit(site) {
      options.onEdit?.(site)
    },

    onRefetchIcon(site) {
      void refetchIcon(site)
    },

    async onToggleHidden(site) {
      try {
        apply(
          await unwrap(
            bridge().portal.upsert({
              id: site.id,
              name: site.name,
              url: site.url,
              hidden: !site.hidden
            })
          )
        )
      } catch (error) {
        toast(t('portal.actionFailed', { reason: tm(formatError(error)) }), 'error')
      }
    },

    async onRemove(site) {
      try {
        apply(await unwrap(bridge().portal.remove(site.id)))
        toast(t('portal.removed', { name: site.name }), 'success')
      } catch (error) {
        toast(t('portal.removeFailed', { reason: tm(formatError(error)) }), 'error')
      }
    }
  })

  async function refetchIcon(site: PortalSite): Promise<void> {
    if (fetching) return
    fetching = true
    try {
      apply(await unwrap(bridge().portal.fetchIcon(site.id)))
      toast(t('portal.iconUpdated', { name: site.name }), 'success')
    } catch (error) {
      // 抓不到是常态（离线、站点反爬），明确告诉用户并说明退路，
      // 别让人对着一个色块不知道是该重试还是该放弃
      toast(t('portal.iconFailed', { reason: tm(formatError(error)) }), 'error')
    } finally {
      fetching = false
    }
  }

  return {
    grid,
    current: () => sites,
    async load() {
      try {
        apply(await unwrap(bridge().portal.list()))
      } catch (error) {
        toast(t('portal.loadFailed', { reason: tm(formatError(error)) }), 'error')
      }
      return sites
    },
    async upsert(input) {
      try {
        const next = await unwrap(bridge().portal.upsert(input))
        apply(next)
        toast(input.id ? t('card.saved') : t('portal.added', { name: input.name }), 'success')
      } catch (error) {
        // 抛回去让表单继续开着：用户输入错了网址，不该因为一次失败就白填
        throw new Error(formatError(error))
      }
    },
    refetchIcon,
    dispose() {
      grid.dispose()
    }
  }
}
