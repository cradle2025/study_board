/**
 * 生成应用图标 build/icon.png（1024×1024）。
 *
 * 为什么用脚本画而不是丢一张图进仓库：
 *  - 不依赖任何图像库，只用 Node 内置的 zlib
 *  - 想改配色/造型时改几个常量重跑即可，不需要重新找设计
 *  - electron-builder 会从这个 png 自动派生 Windows 的 .ico 与 macOS 的 .icns
 *
 * 用法：npm run icon
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SS = 3 // 每像素 3×3 超采样，用来做抗锯齿

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.png')

/* ---------------------------------------------------------------- 绘制辅助 */

/** 圆角矩形的有符号距离场：负数在内部，正数在外部 */
function roundedRectSDF(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = Math.max(0, (x1 - x0) / 2 - r)
  const hh = Math.max(0, (y1 - y0) / 2 - r)
  const dx = Math.abs(px - cx) - hw
  const dy = Math.abs(py - cy) - hh
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** 把一层图形混合到画布上（source-over） */
function blend(canvas, color, alphaAt) {
  const [r, g, b] = hexToRgb(color)
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let acc = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          acc += Math.min(1, Math.max(0, 0.5 - alphaAt(px, py)))
        }
      }
      const a = acc / (SS * SS)
      if (a <= 0) continue
      const i = (y * SIZE + x) * 4
      const dstA = canvas[i + 3] / 255
      const outA = a + dstA * (1 - a)
      canvas[i] = Math.round((r * a + canvas[i] * dstA * (1 - a)) / outA)
      canvas[i + 1] = Math.round((g * a + canvas[i + 1] * dstA * (1 - a)) / outA)
      canvas[i + 2] = Math.round((b * a + canvas[i + 2] * dstA * (1 - a)) / outA)
      canvas[i + 3] = Math.round(outA * 255)
    }
  }
}

const rect = (x0, y0, x1, y1, r) => (px, py) => roundedRectSDF(px, py, x0, y0, x1, y1, r)

/* ---------------------------------------------------------------- 图形定义 */

const canvas = Buffer.alloc(SIZE * SIZE * 4, 0)

// 1. 底板：圆角方块
blend(canvas, '#3B6EF0', rect(64, 64, 960, 960, 208))

// 2. 内衬：稍微暗一点，做出层次
blend(canvas, '#2F5CD6', rect(112, 112, 912, 912, 176))

// 3. 课表网格
const AREA_X0 = 176
const AREA_X1 = 848
const COLS = 4
const GAP = 32
const CELL_W = (AREA_X1 - AREA_X0 - GAP * (COLS - 1)) / COLS
const ROW_Y0 = 232
const HEADER_H = 48
const ROW_H = 96

const colX = (i) => AREA_X0 + i * (CELL_W + GAP)
const headerY = ROW_Y0
const rowY = (i) => ROW_Y0 + HEADER_H + GAP + i * (ROW_H + GAP)

// 表头：代表星期几
for (let c = 0; c < COLS; c += 1) {
  blend(canvas, '#A8C2F8', rect(colX(c), headerY, colX(c) + CELL_W, headerY + HEADER_H, 24))
}

// 主体：4 行课程格
for (let r = 0; r < 4; r += 1) {
  for (let c = 0; c < COLS; c += 1) {
    const y0 = rowY(r)
    blend(canvas, '#FFFFFF', rect(colX(c), y0, colX(c) + CELL_W, y0 + ROW_H, 30), 0.93)
  }
}

// 一节"连堂课"：跨两行的强调色块，让图标有重点
const hiCol = 2
blend(
  canvas,
  '#FFC94D',
  rect(colX(hiCol), rowY(1), colX(hiCol) + CELL_W, rowY(2) + ROW_H, 30)
)

// 小块上的两段"文字"示意
blend(canvas, '#B4801F', rect(colX(hiCol) + 26, rowY(1) + 28, colX(hiCol) + CELL_W - 26, rowY(1) + 44, 8))
blend(canvas, '#B4801F', rect(colX(hiCol) + 26, rowY(1) + 60, colX(hiCol) + CELL_W - 62, rowY(1) + 74, 7))

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(rgba) {
  const stride = SIZE * 4
  const raw = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, encodePng(canvas))
console.log(`[icon] 已生成 ${OUT}（${SIZE}×${SIZE}）`)
