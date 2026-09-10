import { deflateSync } from 'node:zlib'

/**
 * 极简 PNG 编码器：RGBA 像素 → PNG 字节。
 *
 * 为什么自己写而不引库：
 *  - 只用到 Node 内置的 zlib，零第三方依赖，Windows / macOS 行为完全一致；
 *  - HEIF 解码出来的是裸 RGBA，需要交给 Electron 的 nativeImage 继续处理，
 *    而 nativeImage 不能直接吃裸像素（createFromBitmap 的字节序按平台而异），
 *    所以中间转一道 PNG 是最稳妥、最可预测的做法。
 *
 * 注意：这里刻意不做行过滤优化（全部用 filter 0），换来的是实现简单、结果确定。
 * 体积换稳定，符合本项目「宁可慢一点也不要因为环境差异崩掉」的取向。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buffer[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

function toBuffer(pixels: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(pixels)) return pixels
  return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
}

/** 把 width×height 的 RGBA8888 像素编码成 PNG */
export function encodePng(pixels: Buffer | Uint8Array, width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸不合法')
  }
  const expected = width * height * 4
  const src = toBuffer(pixels)
  if (src.length < expected) {
    throw new Error(`像素数据长度不足：需要 ${expected}，实际 ${src.length}`)
  }

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // 每行开头一个字节的 filter 类型，0 = None
    raw[y * (stride + 1)] = 0
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：真彩色 + Alpha
  ihdr[10] = 0 // 压缩方法：deflate
  ihdr[11] = 0 // 过滤方法：标准
  ihdr[12] = 0 // 隔行扫描：无

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
