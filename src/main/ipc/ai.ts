import { CHANNELS } from '@shared/channels'
import { MAX_AI_CONTEXT, MAX_AI_FOCUS, MAX_AI_INSTRUCTION } from '@shared/limits'
import type { AiCompleteRequest, AiCompleteResult } from '@shared/types'

import { aiComplete, aiTest } from '../services/ai'
import { handle } from './index'

/**
 * AI IPC。
 *
 * 入参按不可信数据处理：长度全部收敛到上限。这里拦一次的意义不只是省流量——
 * 笔记正文是用户自己写的，但「发出去」这个动作会把内容送到第三方，
 * 长度上限同时也是「一次误操作不要把整库内容都发出去」的护栏。
 */
export function registerAiHandlers(): void {
  handle<unknown, { model: string; ok: boolean }>(CHANNELS.AI_TEST, () => aiTest())

  handle<unknown, AiCompleteResult>(CHANNELS.AI_COMPLETE, (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('参数不合法')
    const input = raw as Partial<AiCompleteRequest>

    const instruction = String(input.instruction ?? '').slice(0, MAX_AI_INSTRUCTION)
    const focus = String(input.focus ?? '').slice(0, MAX_AI_FOCUS)
    const contextText = String(input.context ?? '').slice(0, MAX_AI_CONTEXT)

    return aiComplete({ instruction, focus, context: contextText })
  })
}
