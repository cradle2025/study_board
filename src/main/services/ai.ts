import { isLoopbackBaseUrl } from '@shared/aiProviders'
import { AI_TIMEOUT_MS } from '@shared/limits'
import type { AiCompleteRequest, AiCompleteResult } from '@shared/types'

import { context } from '../context'

/**
 * AI 助手：把当前笔记 + 用户的要求发给大模型，拿回一段整理好的 Markdown。
 *
 * 请求写在主进程，不写在渲染层，理由有三条：
 *
 * 1. **密钥只在主进程**。渲染层连密钥都拿不到（只拿到一个布尔），
 *    自然也没法把它带进请求里 —— 「密钥不外泄」这件事在架构上就成立了。
 * 2. **渲染层的 CSP 是 `connect-src 'self'`**，本来就发不出请求。
 *    要让它能出网，就得给页面开口子，那才是真正的风险来源。
 * 3. 出网这件事集中在一处，审查时只有一个地方要看。
 *
 * 于是「会主动出网的代码」从一处（图标抓取）变成了三处（图标、AI、Notion），
 * 三处都只走用户自己配置的地址。这一点在 docs/SECURITY.md 里有记录。
 */

/** 响应体上限：挡住「对面吐一个几百兆的 JSON」把内存打爆 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const SYSTEM_PROMPT = [
  '你是一位学习助理，负责把学生的课程笔记整理得更清楚。',
  '',
  '硬性要求：',
  '- 只输出整理后的正文，用 Markdown。**不要**把整段结果包在 ``` 代码块里。',
  '- 不要复述这些指令，不要写「好的，以下是整理结果」这类客套话。',
  '- 不要虚构笔记里没有的事实、数据、引用。缺信息就留空或写「（待补充）」。',
  '- 尽量保留原文的用词与专有名词，只做结构化与措辞上的整理。',
  '- 层级用标题 + 列表表达，不要超过三级标题。'
].join('\n')

/**
 * 拼出对话端点，顺便把协议卡住。
 *
 * **除本机地址外一律要求 https**：密钥是随每个请求一起走的，
 * 明文 http 等于把它交给链路上的任何一跳。这条不是可配置项。
 */
function chatEndpoint(baseUrl: string): string {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('还没配置接口地址（设置 → AI 助手）')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('接口地址不是合法的 URL')
  }

  if (parsed.protocol === 'https:') return `${trimmed}/chat/completions`
  // 本机地址可以走 http：本地模型服务没有证书，而且流量不出这台机器
  if (parsed.protocol === 'http:' && isLoopbackBaseUrl(trimmed)) {
    return `${trimmed}/chat/completions`
  }
  throw new Error('接口地址必须是 https：密钥会随请求一起发出去，不能走明文（本机地址除外）')
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

interface ChatResponse {
  model?: unknown
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  error?: { message?: unknown }
}

function describeStatus(status: number, detail: string): string {
  const suffix = detail ? `：${detail.slice(0, 200)}` : ''
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）${suffix}`
  if (status === 404) return `接口地址或模型名不对（HTTP 404）${suffix}`
  if (status === 429) return `请求过于频繁或额度用尽（HTTP 429）${suffix}`
  if (status >= 500) return `服务端出错（HTTP ${status}）${suffix}`
  return `请求被拒绝（HTTP ${status}）${suffix}`
}

async function callChat(baseUrl: string, apiKey: string | null, messages: ChatMessage[], temperature: number): Promise<{ text: string; model: string; promptTokens: number; completionTokens: number }> {
  const endpoint = chatEndpoint(baseUrl)

  const payload: Record<string, unknown> = {
    model: context().settings.get().ai.model.trim(),
    messages,
    temperature
  }
  if (!String(payload['model'])) throw new Error('还没配置模型名（设置 → AI 助手）')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 密钥只在这一行出现，且不写日志
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // 跟随重定向是 fetch 的默认行为，这里显式写出来是为了让人看到「想过这件事」：
      // 规范要求跨源重定向时丢掉 Authorization 头，所以顺着跳转不会把密钥
      // 递给第三方；反过来若设成 'error'，那些入口域名与接口域名不一致的服务商
      // 会直接不可用，属于为了洁癖把功能弄坏
      redirect: 'follow'
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（超过 ${AI_TIMEOUT_MS / 1000} 秒）`)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`连不上接口地址：${message}`)
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('接口返回的内容过大，已中止')

  let data: ChatResponse = {}
  try {
    data = JSON.parse(text) as ChatResponse
  } catch {
    if (!response.ok) throw new Error(describeStatus(response.status, text))
    throw new Error('接口返回的不是合法 JSON，检查一下接口地址是不是填错了')
  }

  if (!response.ok) {
    const detail = typeof data.error?.message === 'string' ? data.error.message : ''
    throw new Error(describeStatus(response.status, detail))
  }

  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('模型没有返回内容，换个型号或稍后再试')
  }

  const usage = data.usage ?? {}
  return {
    text: content.trim(),
    model: typeof data.model === 'string' && data.model ? data.model : context().settings.get().ai.model,
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0
  }
}

function requireKey(): string | null {
  const settings = context().settings.get()
  const store = context().secrets
  const key = store.get('aiKey')
  if (key) return key

  // 本地模型服务不校验密钥，**判据只看地址是不是本机**。
  // 不能改成「看预设 id 是不是 ollama」：预设里的地址是用户能改的，
  // 把本机地址的判据挂在一个可改的值上，就会出现「以为不用密钥、
  // 实际地址在公网」的错配——那个请求会以无 Authorization 发出去然后被 401，
  // 而界面上连填密钥的入口都没有
  if (isLoopbackBaseUrl(settings.ai.baseUrl)) return null

  if (!store.available) throw new Error('系统钥匙串当前不可用，无法保存或读取密钥')
  throw new Error('还没配置 API Key（设置 → AI 助手）')
}

/** 连通性自检：发一句最短的话，确认地址 / 密钥 / 模型三者都对得上 */
export async function aiTest(): Promise<{ model: string; ok: boolean }> {
  const key = requireKey()
  const settings = context().settings.get()
  const result = await callChat(settings.ai.baseUrl, key, [
    { role: 'user', content: '回复两个字：可用' }
  ], settings.ai.temperature)
  return { model: result.model, ok: true }
}

/**
 * 生成整理内容。
 *
 * prompt 组装刻意把「笔记正文」放在后面、指令放在前面：
 * 长文本放末尾时模型的遵循度更好，也更不容易把指令当成被整理的内容。
 */
export async function aiComplete(request: AiCompleteRequest): Promise<AiCompleteResult> {
  const key = requireKey()
  const settings = context().settings.get()

  const instruction = String(request?.instruction ?? '').trim()
  if (!instruction) throw new Error('请先写下你想要的整理方式')

  const focus = String(request?.focus ?? '').trim()
  const body = String(request?.context ?? '')

  const parts = [`整理要求：${instruction}`]
  if (focus) parts.push(`参考重点：${focus}`)
  parts.push('', '以下是笔记原文（Markdown）：', '<<<笔记开始', body, '笔记结束>>>')

  const result = await callChat(settings.ai.baseUrl, key, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') }
  ], settings.ai.temperature)

  return {
    text: result.text,
    model: result.model,
    usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
  }
}
