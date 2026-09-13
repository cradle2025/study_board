import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { safeJoin } from '../paths'
import { ASSET_SCHEME } from '../security'

/**
 * 本地资源协议：sb-asset://<bucket>/<relative-path>
 *
 * 存在的意义：
 *  - 渲染层的 CSP 是 default-src 'none'，只有这个协议被显式放行，图片才能显示；
 *  - 只有三个「桶」可以访问，且每个桶都锁死在自己的目录里，禁止路径穿越；
 *  - 只读不写，永远不出网。
 */

export interface AssetBuckets {
  notes: string
  timetable: string
  icons: string
}

/**
 * 扩展名 → MIME。
 *
 * 导出（`noteImagePath.ts`）也要用它来判断「这个引用指向的是不是一张图」，
 * 所以导出而不是各留一份——两份表迟早会漂，而漂的那次表现为
 * 「某个格式在应用里能看、导出就没了」，很难查。
 */
export const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function pickBase(bucket: string, buckets: AssetBuckets): string {
  switch (bucket) {
    case 'notes':
      return buckets.notes
    case 'timetable':
      return buckets.timetable
    case 'icon':
      return buckets.icons
    default:
      throw new Error(`未知的资源桶：${bucket}`)
  }
}

export function installAssetProtocol(getBuckets: () => AssetBuckets): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // 桶名**不区分大小写**：Electron 在把请求交到 protocol.handle 之前
      // 会把 hostname 规范化成小写（实测：渲染层发 sb-asset://TIMETABLE/x.png，
      // 这里收到的 url.hostname 已经是 'timetable'）。Node 的 new URL() 对
      // 非特殊 scheme 并不做这件事，所以只跑单测是发现不了的。
      // 规范化掉大小写，行为才只由「桶名对不对」决定，而不是由客户端写法决定
      const base = pickBase(url.hostname.toLowerCase(), getBuckets())
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!relative) throw new Error('资源路径为空')

      const filePath = safeJoin(base, relative)
      const buffer = await readFile(filePath)
      const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }
  })
}
