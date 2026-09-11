import { CHANNELS } from '@shared/channels'
import type { PortalSite, PortalSiteInput } from '@shared/types'

import { context } from '../context'
import { fetchSiteIcon } from '../services/iconFetch'
import { handle } from './index'

/**
 * 网站门户 IPC。
 *
 * 所有写操作都返回「完整的新列表」而不是单个站点，理由与课表一致：
 * 渲染层拿到就能直接重绘，不必自己维护一份可能过期的状态。
 *
 * 网络相关只有 PORTAL_FETCH_ICON 一个入口，且是用户显式点击才触发。
 * 抓取失败时**抛错**而不是静默返回旧列表——用户需要知道「没抓到」这件事，
 * 否则会对着一个色块不知道该重试还是该放弃。
 */

export function registerPortalHandlers(): void {
  handle<unknown, PortalSite[]>(CHANNELS.PORTAL_LIST, () => context().portal.list())

  handle<unknown, PortalSite[]>(CHANNELS.PORTAL_UPSERT, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as PortalSiteInput
    return context().portal.upsert(input)
  })

  handle<unknown, PortalSite[]>(CHANNELS.PORTAL_DELETE, (id) => context().portal.remove(id))

  handle<unknown, PortalSite[]>(CHANNELS.PORTAL_FETCH_ICON, async (id) => {
    const site = context().portal.find(id)
    if (!site) throw new Error('站点不存在')

    const icon = await fetchSiteIcon(site.url)
    const fileName = context().portal.writeIcon(icon.data)
    return context().portal.setIcon(site.id, fileName)
  })
}
