import { nativeImage } from 'electron'

import { decodeHeifToPng, isHeif } from './heif'

/**
 * 图片归一化：任何用户选中的图片，最终都变成「Chromium 一定能显示的」格式。
 *
 * 规则：
 *  - HEIF/HEIC  → libheif 解码后再压成 JPEG（Chromium 自己读不了 HEIC，只能这样兜）
 *  - PNG        → 保持 PNG（课表截图多为 PNG，转 JPEG 会把文字糊掉）
 *  - JPEG/WEBP/AVIF → 统一转 JPEG q88（照片体积小、清晰度够）
 *  - 其它       → 转 PNG
 *  - 长边超过上限时等比缩小：手机直出照片动辄 4000px，课表只需要看清字
 *
 * 关键取向：**优先用 Electron 内置的 nativeImage 做缩放与重编码**（Chromium 负责，
 * 质量与性能都好），但它万一读不了某个格式，就退回原始字节——绝不因为「优化失败」
 * 而让用户导入不了图片。
 */

/** 单张源文件体积上限，超过直接拒绝，避免解码时把内存打爆 */
export const MAX_SOURCE_BYTES = 48 * 1024 * 1024

/** 落盘后长边上限（像素） */
export const MAX_LONG_EDGE = 2400

/** JPEG 质量 */
const JPEG_QUALITY = 88

/** 单个文件落盘体积上限，兜底防止异常数据 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** 原样保留（不经 Chromium 转码）时允许的扩展名 */
const PASS_THROUGH_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])

export interface NormalizedImage {
  data: Buffer
  ext: string
  width: number
  height: number
}

export function extOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : ''
}

/** 该扩展名的图片是否按「照片」处理（压缩成 JPEG） */
function isPhotoLike(ext: string): boolean {
  return ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'avif' || ext === 'heic' || ext === 'heif'
}

export async function normalizeImage(raw: Buffer, sourceName: string): Promise<NormalizedImage> {
  if (raw.length === 0) throw new Error('文件是空的')
  if (raw.length > MAX_SOURCE_BYTES) {
    throw new Error(`文件过大（上限 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)}MB）`)
  }

  const sourceExt = extOf(sourceName)
  const heif = isHeif(raw)

  // 1. 先拿到 Chromium 认得的字节：HEIF 必须先解码
  let decoded: Buffer = raw
  if (heif) {
    decoded = (await decodeHeifToPng(raw)).png
  }

  const asPng = heif ? false : !isPhotoLike(sourceExt)

  // 2. 交给 Chromium 缩放 / 重编码
  try {
    const image = nativeImage.createFromBuffer(decoded)
    if (image.isEmpty()) throw new Error('无法解码该图片')

    const original = image.getSize()
    let working = image
    const longEdge = Math.max(original.width, original.height)
    if (longEdge > MAX_LONG_EDGE) {
      working =
        original.width >= original.height
          ? image.resize({ width: MAX_LONG_EDGE, quality: 'good' })
          : image.resize({ height: MAX_LONG_EDGE, quality: 'good' })
    }

    const size = working.getSize()
    if (size.width <= 0 || size.height <= 0) throw new Error('图片尺寸异常')

    const encoded = asPng ? working.toPNG() : working.toJPEG(JPEG_QUALITY)
    if (encoded.length === 0) throw new Error('图片编码结果为空')
    if (encoded.length > MAX_OUTPUT_BYTES) throw new Error('图片处理后仍然过大')

    return { data: encoded, ext: asPng ? 'png' : 'jpg', width: size.width, height: size.height }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    // HEIF 已经解过码了，这里再失败说明确实无法处理
    if (heif) throw new Error(`HEIF 转码失败：${reason}`)

    // 其它格式：原样保留，只要扩展名是 Chromium 认得的
    if (!PASS_THROUGH_EXT.has(sourceExt)) {
      throw new Error('不支持的图片格式，请使用 JPEG / PNG / HEIF')
    }
    return { data: raw, ext: sourceExt, width: 0, height: 0 }
  }
}
