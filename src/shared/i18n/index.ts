import { EN } from './en-US'
import { ZH } from './zh-CN'

/**
 * 双语支持。
 *
 * ## 为什么放在 `shared`
 *
 * 主进程的报错文案也会出现在界面上（IPC 抛出的错误经 `formatError`
 * 变成 toast），所以两边必须用**同一份**词典。放在任一侧都会让另一侧
 * 只能硬编码，那就等于没做双语。
 *
 * ## 为什么用扁平 key 而不是嵌套对象
 *
 * `t('notes.group.rename')` 这种点分 key 有个实际好处：**漏翻译能被查出来**。
 * 嵌套对象要递归比对，而扁平表一句 `Object.keys` 就能比出两边差在哪。
 * 自检里那条「中英词条必须一一对应」的断言就是靠这个成立的。
 *
 * ## 缺翻译时怎么办
 *
 * 分两层：英文表里缺某条 → 回落到中文（用户至少看得懂意思，而不是空白）；
 * 两张表都没有 → 把 key 原样显示出来。后者看着丑，但那正是它存在的意义：
 * 界面上出现 `notes.foo.bar` 比出现一个空字符串好排查得多。
 */

export type Lang = 'zh-CN' | 'en-US'

export const LANGS: readonly Lang[] = ['zh-CN', 'en-US']

/** 语言在界面上的名字。**两种语言下都写自己的名字**——
 *  把「English」在中文界面里翻成「英文」会让英文用户找不到它 */
export const LANG_LABEL: Record<Lang, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English'
}

export function isLang(value: unknown): value is Lang {
  return value === 'zh-CN' || value === 'en-US'
}

export type TParams = Record<string, string | number>

const TABLES: Record<Lang, Record<string, string>> = { 'zh-CN': ZH, 'en-US': EN }

/** 按语言取一条文案。`{name}` 形式的占位符由 `params` 填 */
export function translate(lang: Lang, key: string, params?: TParams): string {
  const table = TABLES[lang] ?? ZH
  const template = table[key] ?? ZH[key]
  if (template === undefined) return key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** 两边的 key 是否一一对应。自检用它来防止「加了中文忘了英文」 */
export function dictionaryGaps(): { missingInEn: string[]; missingInZh: string[] } {
  const zhKeys = new Set(Object.keys(ZH))
  const enKeys = new Set(Object.keys(EN))
  return {
    missingInEn: [...zhKeys].filter((key) => !enKeys.has(key)).sort(),
    missingInZh: [...enKeys].filter((key) => !zhKeys.has(key)).sort()
  }
}

/**
 * 主进程文案的**英文查表**：中文原文 → 英文。
 *
 * 为什么不把 `t()` 塞进每一个 `throw new Error(...)`：主进程里那些
 * 报错散在几十个服务里，而且很多是**动态拼**出来的（`资料最多 200 份`
 * 这种带数字的）。逐个改造要动上百处，改错的代价是错误信息丢失。
 *
 * 所以换个方向：主进程继续抛中文，渲染层在**展示那一刻**查这张表。
 * 查不到就原样显示中文 —— 用户看到中文总比看到 `err.unknown` 好。
 * 这是有意的降级：翻译不全时界面仍然可用。
 */
export function translateMessage(lang: Lang, message: string): string {
  if (lang === 'zh-CN') return message
  const exact = EN_MESSAGES[message]
  if (exact) return exact
  // 带数字的文案：把数字挖出来，用剩下的骨架去匹配模板
  for (const [pattern, replacement] of EN_MESSAGE_PATTERNS) {
    const match = pattern.exec(message)
    if (match) return replacement(match)
  }
  return message
}

/** 完全固定的主进程文案 */
const EN_MESSAGES: Record<string, string> = {}

/** 带参数的：每条给出正则与替换函数 */
const EN_MESSAGE_PATTERNS: readonly [RegExp, (m: RegExpMatchArray) => string][] = []
