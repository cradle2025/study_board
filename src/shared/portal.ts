import { MAX_SITE_NAME, MAX_SITE_URL } from './limits'

/**
 * 网站门户的公共规则。
 *
 * 网址清洗与配色放在共享层而不是主进程，是因为**两边都要用同一套判断**：
 *  - 渲染层要在用户输入时即时提示「这个网址不合法」；
 *  - 主进程要在真正发起网络请求 / 落盘前再校验一次。
 * 写成两份迟早会不一致，而不一致的那天就是安全漏洞。
 */

export type UrlCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; error: string }

/** 只允许 http / https：其它协议一律拒绝，避免 file: 之类被带进来 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** 可见 ASCII 的起始码位；低于它的是空白与控制字符 */
const FIRST_PRINTABLE = 33
/** DEL 控制字符 */
const DEL = 127

/** 去掉空白与控制字符，防止靠插入不可见字符绕过协议白名单 */
function stripInvisible(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code >= FIRST_PRINTABLE && code !== DEL) out += ch
  }
  return out
}

/**
 * 把用户输入的网址收敛成可安全使用的形式。
 *
 * 处理顺序很关键：先补协议再解析，否则 `bilibili.com` 这种最常见的输入
 * 会被 URL 当成相对路径。解析完之后再逐条拒绝不合法的部分。
 */
export function normalizeSiteUrl(raw: unknown): UrlCheck {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return { ok: false, error: '网址不能为空' }
  if (trimmed.length > MAX_SITE_URL) {
    return { ok: false, error: `网址过长（最多 ${MAX_SITE_URL} 个字符）` }
  }

  const cleaned = stripInvisible(trimmed)
  if (cleaned.length === 0) return { ok: false, error: '网址不能为空' }

  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned) ? cleaned : `https://${cleaned}`

  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    return { ok: false, error: '这不是一个合法的网址' }
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `只支持 http / https，不支持 ${parsed.protocol.replace(':', '')}` }
  }
  if (parsed.hostname.length === 0) return { ok: false, error: '网址缺少主机名' }
  // 带用户名密码的网址（http://user:pass@host）一律拒绝：
  // 门户里存的是「快捷方式」，没有任何理由保存凭据
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: '网址里不能带用户名和密码' }
  }

  return { ok: true, url: parsed.toString(), host: parsed.hostname }
}

/** 用于展示的短主机名：去掉开头的 www. */
export function displayHost(host: string): string {
  return host.replace(/^www\./i, '')
}

/** 站点名：折叠空白、去掉首尾空格、截断到上限 */
export function normalizeSiteName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SITE_NAME)
}

/** 兜底色块的备选色：都与界面主色协调，且明暗主题下都看得清 */
const SITE_COLORS: readonly string[] = [
  '#3b6ef0',
  '#d64545',
  '#2f9e6f',
  '#b7791f',
  '#7c5cd6',
  '#0f8f9e',
  '#c25ca0',
  '#5a7a2f'
]

/** FNV-1a：同一个站点每次打开都拿到同一个颜色，不会因为重启就变色 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 由站点名 + 主机名推导兜底色 */
export function colorForSite(name: string, host: string): string {
  const seed = `${host}#${name}`
  const index = hashSeed(seed) % SITE_COLORS.length
  return SITE_COLORS[index] as string
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** 只接受 #rrggbb：不允许把任意 CSS 值塞进 style 里 */
export function sanitizeColor(raw: unknown, fallback: string): string {
  const value = String(raw ?? '').trim()
  return HEX_COLOR.test(value) ? value : fallback
}

/**
 * 图标抓取失败时显示在色块里的字。
 * 中文取首字，英文取首字母——比统一用一个问号好看得多。
 */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  const first = trimmed[0] as string
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first
}
