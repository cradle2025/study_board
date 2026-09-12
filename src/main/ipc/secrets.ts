import { CHANNELS } from '@shared/channels'
import type { AppSettings } from '@shared/types'

import { context } from '../context'
import type { SecretKind } from '../services/secrets'
import { broadcast, handle } from './index'

/**
 * 密钥 IPC。
 *
 * 只有「写入」和「清除」两个方向，**没有读取**——
 * 渲染层能拿到的密钥信息永远只有一个布尔值（`settings.ai.hasApiKey`）。
 * 这样即便渲染层被完全攻陷，也偷不走密钥；它至多能覆盖成一个新值。
 *
 * 写完/清完统一广播一次设置变更，让设置页与笔记页同时更新
 * 「AI 能不能用」的判断，不用各自去轮询。
 */
export function registerSecretHandlers(): void {
  const presence = (kind: SecretKind): 'ai' | 'notion' =>
    kind === 'aiKey' ? 'ai' : 'notion'

  const put = (kind: SecretKind) => (raw: unknown) => {
    // 这里的 raw 是不可信数据。长度与换行由 SecretsStore 再校验一次，
    // 两层都留着：万一以后多一条写入路径，也不会绕过约束
    context().secrets.set(kind, typeof raw === 'string' ? raw : '')
    context().settings.markSecretPresence(presence(kind), true)
    broadcastSettings()
    return true
  }

  const drop = (kind: SecretKind) => () => {
    context().secrets.clear(kind)
    context().settings.markSecretPresence(presence(kind), false)
    broadcastSettings()
    return true
  }

  handle<unknown, boolean>(CHANNELS.SECRET_SET_AI_KEY, put('aiKey'))
  handle<unknown, boolean>(CHANNELS.SECRET_CLEAR_AI_KEY, drop('aiKey'))
  handle<unknown, boolean>(CHANNELS.SECRET_SET_NOTION_TOKEN, put('notionToken'))
  handle<unknown, boolean>(CHANNELS.SECRET_CLEAR_NOTION_TOKEN, drop('notionToken'))
}

function broadcastSettings(): void {
  broadcast(CHANNELS.EVENT_SETTINGS_CHANGED, structuredClone(context().settings.get()) as AppSettings)
}
