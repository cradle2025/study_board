import { nativeImage, net, type ClientRequest } from 'electron'

import { PORTAL_ICON_EDGE } from '@shared/limits'

/**
 * 网站图标抓取。
 *
 * 这是整个应用里**唯一会主动出网**的地方，所以约束写得比别处更紧：
 *
 *  1. 只在用户明确点「抓取图标」时触发，启动时绝不自动抓——
 *     本应用的默认状态是离线的；
 *  2. 只走 http / https，重定向目标同样要过协议白名单，最多跟 3 跳；
 *  3. 不发送任何 Cookie / 凭据（`useSessionCookies: false`），
 *     抓图标这件事不该带上用户的登录态；
 *  4. 体积、时长双重上限：网页正文最多读 512KB，图标最多 2MB，单次 8 秒超时；
 *  5. 拿到字节后**一律交给 Chromium 解码再重新编码成 PNG**——
 *     解不出来就当失败。这样既能挡掉伪装成图片的 HTML / SVG，
 *     也顺手把各种尺寸的图标统一到 64px，避免图标目录被塞进高清大图。
 *
 * 失败是常态（离线、反爬、站点没图标），所以失败路径只是抛出一个人类可读的原因，
 * 界面回退到「色块 + 首字」，站点本身照常能用。
 */

const TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 512 * 1024
const MAX_ICON_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
/** 解码后像素数上限：防止一张 2MB 的 PNG 展开成几亿像素把内存吃光 */
const MAX_PIXELS = 64 * 1024 * 1024

/** 一个朴素的爬虫 UA：不少站点会拒绝空 UA */
const USER_AGENT = 'Mozilla/5.0 StudyBoard/1.0 (+favicon fetch)'

const ACCEPT_HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
const ACCEPT_IMAGE = 'image/avif,image/webp,image/png,image/*,*/*;q=0.8'

interface RawResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** 跟完重定向之后的最终地址，用于把相对路径的图标链接补全 */
  finalUrl: string
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function requestOnce(
  url: string,
  accept: string,
  maxBytes: number,
  timeoutMs: number
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest
    try {
      request = net.request({
        url,
        method: 'GET',
        // 手动处理重定向，才能逐个校验跳转目标
        redirect: 'manual',
        // 关键：不带会话 Cookie，抓图标不该带上用户的登录态
        useSessionCookies: false
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        request.abort()
        reject(new Error('请求超时'))
      })
    }, timeoutMs)

    request.setHeader('User-Agent', USER_AGENT)
    request.setHeader('Accept', accept)
    request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9')

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let received = 0

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > maxBytes) {
          finish(() => {
            request.abort()
            reject(new Error('响应内容过大'))
          })
          return
        }
        chunks.push(chunk)
      })

      response.on('end', () => {
        finish(() => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[key.toLowerCase()] = value
            else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ')
          }
          resolve({
            status: response.statusCode,
            headers,
            body: Buffer.concat(chunks),
            finalUrl: url
          })
        })
      })

      response.on('error', (error: Error) => {
        finish(() => reject(error))
      })
    })

    request.on('error', (error: Error) => {
      finish(() => reject(error))
    })

    request.on('abort', () => {
      finish(() => reject(new Error('请求已中止')))
    })

    request.end()
  })
}

/** 跟重定向，但每一跳都要重新校验协议，且限制跳数 */
async function fetchWithRedirects(
  startUrl: string,
  accept: string,
  maxBytes: number
): Promise<RawResponse> {
  let url = startUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(url, accept, maxBytes, TIMEOUT_MS)
    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers['location']
    if (!location) return response

    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new Error('重定向地址不合法')
    }
    if (!isHttp(next)) throw new Error('重定向到了不支持的协议')
    url = next.toString()
  }
  throw new Error('重定向次数过多')
}

/** 从 <link ...> 标签里取某个属性的值 */
function attrOf(tag: string, name: string): string {
  const pattern = new RegExp(`[\\s"']${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(tag)
  if (!match) return ''
  return (match[2] ?? match[3] ?? match[4] ?? '').trim()
}

/**
 * 在 HTML 的 head 里找图标链接，按「更可能是高清图标」排序。
 *
 * 不用 DOMParser（主进程没有 DOM），正则足够——我们只需要找到那几个
 * link 标签，不追求解析任意 HTML。
 */
function findIconCandidates(html: string, baseUrl: string): string[] {
  const lower = html.toLowerCase()
  const headEnd = lower.indexOf('</head>')
  const head = headEnd >= 0 ? html.slice(0, headEnd + 7) : html

  const tags = head.match(/<link\b[^>]*>/gi) ?? []
  const scored: { href: string; score: number }[] = []

  for (const tag of tags) {
    const rel = attrOf(tag, 'rel').toLowerCase()
    if (rel.indexOf('icon') < 0) continue

    const href = attrOf(tag, 'href')
    if (href.length === 0) continue
    // data: 形式的内联图标不值得再发一次请求，也容易被塞进超大内容
    if (href.toLowerCase().startsWith('data:')) continue

    let score = 0
    if (rel.indexOf('apple-touch-icon') >= 0) score += 40
    if (rel.indexOf('shortcut') >= 0) score += 5

    const sizeMatch = /(\d+)\s*x\s*(\d+)/.exec(attrOf(tag, 'sizes').toLowerCase())
    if (sizeMatch) score += Math.min(Number(sizeMatch[1]) || 0, 256) / 8
    if (/\.png(\?|$)/i.test(href)) score += 8
    // SVG 要浏览器渲染才能变成位图，这里解不了，直接往后排
    if (/\.svg(\?|$)/i.test(href)) score -= 60
    if (/\.ico(\?|$)/i.test(href)) score -= 5

    scored.push({ href, score })
  }

  scored.sort((a, b) => b.score - a.score)

  const out: string[] = []
  for (const item of scored) {
    try {
      const resolved = new URL(item.href, baseUrl)
      if (!isHttp(resolved)) continue
      out.push(resolved.toString())
    } catch {
      /* 解析不了的链接跳过 */
    }
    if (out.length >= 4) break
  }
  return out
}

/**
 * 把任意「据说是图片」的字节变成统一的 PNG。
 *
 * 这一步同时充当安全过滤：解不出来的（伪装成图片的 HTML、脚本、SVG）
 * 一律失败，不会有任何外来字节被原样存进图标目录。
 */
function toIconPng(buffer: Buffer): Buffer {
  if (buffer.length === 0) throw new Error('图标内容是空的')

  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('抓到的内容不是能识别的图片')

  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) throw new Error('图标尺寸异常')
  if (size.width * size.height > MAX_PIXELS) throw new Error('图标尺寸过大')

  let working = image
  if (Math.max(size.width, size.height) > PORTAL_ICON_EDGE) {
    // 只给一个方向，nativeImage 会保持比例——同时给宽高会拉伸变形
    working =
      size.width >= size.height
        ? image.resize({ width: PORTAL_ICON_EDGE })
        : image.resize({ height: PORTAL_ICON_EDGE })
  }

  const encoded = working.toPNG()
  if (encoded.length === 0) throw new Error('图标编码失败')
  return encoded
}

export interface FetchedIcon {
  data: Buffer
  /** 最终是从哪个地址拿到的，失败排查时有用 */
  source: string
}

/**
 * 抓取一个站点的图标。
 *
 * 顺序：先读页面 HTML 找 <link rel=icon>（能拿到高清图标），
 * 两条路都不通再退回站点根的 /favicon.ico。全失败就抛出一个可读原因。
 */
export async function fetchSiteIcon(url: string): Promise<FetchedIcon> {
  let page: URL
  try {
    page = new URL(url)
  } catch {
    throw new Error('网址不合法')
  }
  if (!isHttp(page)) throw new Error('只支持 http / https 网址')

  const errors: string[] = []

  // 1. 页面里声明的图标
  try {
    const response = await fetchWithRedirects(page.toString(), ACCEPT_HTML, MAX_HTML_BYTES)
    const type = (response.headers['content-type'] ?? '').toLowerCase()

    if (response.status < 200 || response.status >= 300) {
      errors.push(`页面返回 ${response.status}`)
    } else if (type.includes('html') || response.body.toString('latin1').indexOf('<link') >= 0) {
      for (const candidate of findIconCandidates(
        response.body.toString('utf-8'),
        response.finalUrl
      )) {
        try {
          const iconResponse = await fetchWithRedirects(candidate, ACCEPT_IMAGE, MAX_ICON_BYTES)
          if (iconResponse.status < 200 || iconResponse.status >= 300) {
            errors.push(`${candidate} 返回 ${iconResponse.status}`)
            continue
          }
          return { data: toIconPng(iconResponse.body), source: candidate }
        } catch (error) {
          errors.push(`${candidate}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else {
      // 少数站点直接在根路径返回图标本身，内容类型也不是 html
      try {
        return { data: toIconPng(response.body), source: response.finalUrl }
      } catch {
        errors.push('页面返回的不是图标')
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  // 2. 兜底：站点根的 favicon.ico
  const favicon = new URL('/favicon.ico', page.origin).toString()
  try {
    const response = await fetchWithRedirects(favicon, ACCEPT_IMAGE, MAX_ICON_BYTES)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`favicon.ico 返回 ${response.status}`)
    }
    return { data: toIconPng(response.body), source: favicon }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  throw new Error(errors[0] ?? '未能获取到图标')
}
