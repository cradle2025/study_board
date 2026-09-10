import { encodePng } from './png'

/**
 * HEIF / HEIC 解码。
 *
 * 为什么不直接用 Chromium 内置的解码能力：
 *  - Chromium 出于专利原因**不支持** HEIC/HEIF，渲染层拿到 .heic 也显示不出来；
 *  - Electron 的 nativeImage 同样基于 Chromium，读不了 HEIF。
 * 所以苹果手机拍出来的课表照片必须靠 libheif 兜住。
 *
 * 用的是 `libheif-js/wasm-bundle`：WASM 被 base64 内联在 JS 里，
 * 运行时**不需要**再去磁盘上找 .wasm 文件——这一点很关键，
 * 打包成 asar 之后仍然能正常工作，也不会因为用户系统升级而失效。
 *
 * 体积代价约 2MB，且只在真的导入 HEIF 时才加载（懒加载），
 * 不用 HEIF 的人不会付出这部分启动成本。
 */

interface HeifImage {
  get_width(): number
  get_height(): number
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: { data: Uint8ClampedArray } | null) => void
  ): void
}

interface HeifDecoder {
  decode(data: ArrayBuffer | Uint8Array): HeifImage[]
}

interface LibheifModule {
  HeifDecoder: new () => HeifDecoder
}

let cachedModule: LibheifModule | null = null

function loadLibheif(): LibheifModule {
  if (cachedModule) return cachedModule
  // 主进程产物是 CJS，这里直接 require 即可；
  // 写死字面量而不是拼接，避免被打包器误判成动态依赖。
  const loaded = require('libheif-js/wasm-bundle') as unknown
  const mod = loaded as LibheifModule
  if (typeof mod?.HeifDecoder !== 'function') {
    throw new Error('HEIF 解码器加载失败')
  }
  cachedModule = mod
  return mod
}

/** HEIF 家族的文件头品牌标识（AVIF 也基于 HEIF，但 Chromium 原生支持，不走这里） */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1'
])

/**
 * 通过文件头判断是不是 HEIF。
 * 结构：4 字节长度 + "ftyp" + 4 字节主品牌，因此只读前 12 字节就够。
 */
export function isHeif(buffer: Buffer | Uint8Array): boolean {
  if (buffer.length < 12) return false
  const view = buffer instanceof Buffer ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.toString('ascii', 4, 8) !== 'ftyp') return false
  return HEIF_BRANDS.has(view.toString('ascii', 8, 12))
}

export interface DecodedImage {
  png: Buffer
  width: number
  height: number
}

/** 解码 HEIF 的第一帧，产出 PNG 字节 */
export async function decodeHeifToPng(buffer: Buffer): Promise<DecodedImage> {
  const libheif = loadLibheif()

  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer

  const decoder = new libheif.HeifDecoder()
  const images = decoder.decode(arrayBuffer)
  const image = images[0]
  if (!image) throw new Error('这个 HEIF 文件里没有可用的图像')

  const width = image.get_width()
  const height = image.get_height()
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('HEIF 图像尺寸异常')
  }

  const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
  await new Promise<void>((resolve, reject) => {
    image.display(target, (result) => {
      if (result) resolve()
      else reject(new Error('HEIF 解码失败，文件可能已损坏'))
    })
  })

  return { png: encodePng(Buffer.from(target.data.buffer), width, height), width, height }
}
