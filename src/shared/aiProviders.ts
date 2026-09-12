/**
 * 主流大模型的「服务商预设」。
 *
 * 它们**只是快捷方式**：选中之后把 `baseUrl` 与 `model` 两个输入框填好，
 * 两个框本身始终可编辑。这一点是刻意的——
 *
 *  - 各家的模型名几个月就换一批，把清单写成硬编码的"可选值"迟早会过期，
 *    而过期的清单会让用户以为自己填错了；
 *  - 本应用要求「版本变动不得导致功能失效」，所以任何一个值都必须能绕过预设手动填。
 *
 * 接口形态统一按 **OpenAI 兼容**（`POST {baseUrl}/chat/completions`）——
 * 上面这些厂商全都提供兼容端点，一套请求代码就够，不用为每家写适配器。
 */

export interface AiProviderPreset {
  id: string
  label: string
  /** OpenAI 兼容端点，末尾不带斜杠 */
  baseUrl: string
  /** 默认模型（只是建议值，用户可改） */
  model: string
  /** 该家常用的型号，填进 `<datalist>` 当候选，不是白名单 */
  models: readonly string[]
  /** 去哪里申请密钥 */
  keyUrl?: string
  /** 不需要密钥（本地模型服务） */
  keyOptional?: boolean
  /** 给用户的一句提醒 */
  note?: string
}

/** 用户自己改了地址或模型时会切到这个 id（它不在预设列表里） */
export const CUSTOM_PROVIDER_ID = 'custom'

export const AI_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
    keyUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-8B', 'THUDM/glm-4-9b-chat'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    models: [],
    keyUrl: 'https://console.volcengine.com/ark',
    note: '这一家的「模型」要填自己创建的接入点 ID（ep- 开头），不是模型名'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内网络通常需要自备代理'
  },
  {
    id: 'ollama',
    label: '本地模型（Ollama / LM Studio）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    keyOptional: true,
    note: '本机地址走 http 明文，但因为不出网，内容不会离开这台电脑'
  }
]

export function findAiProvider(id: string): AiProviderPreset | null {
  return AI_PROVIDERS.find((item) => item.id === id) ?? null
}

/**
 * 地址是不是指向本机。
 *
 * 这是「这次请求要不要密钥」的**唯一判据**，两个进程都用它，判据不能有两份。
 *
 * 为什么不用「预设 id 是不是本地模型」来判断：预设里的地址是用户可以改的。
 * 一旦把判据挂在 id 上，把 ollama 那套预设的地址改成公网地址之后，
 * 请求会以「不需要密钥」发出去（然后被对面 401），而界面上连填密钥的地方都没有。
 * 反过来，判断地址本身则永远和事实一致。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(String(baseUrl ?? '').trim()).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * 默认预设：给中文用户挑一个**不需要代理、有免费额度**的。
 *
 * 默认值会影响第一次使用的成败，所以它不能是「国外某家 + 需要自己想办法联网」。
 */
export const DEFAULT_AI_PROVIDER: AiProviderPreset =
  AI_PROVIDERS.find((item) => item.id === 'deepseek') ?? (AI_PROVIDERS[0] as AiProviderPreset)
