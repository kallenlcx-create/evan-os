// 生成 PWA 图标（纯 Node，无依赖）：渐变圆角底 + 白色 "E" 字块
// 用法: node scripts/gen-icons.mjs
// 输出: public/icons/icon-192.png / icon-512.png / icon-512-maskable.png

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  // 每行前置 filter 0
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 绘制 ----------
// "E" 字 5x7 点阵
const E = [
  '11111',
  '10000',
  '10000',
  '11110',
  '10000',
  '10000',
  '11111',
]

function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4)
  const radius = maskable ? 0 : size * 0.22
  const inRounded = (x, y) => {
    if (maskable) return true
    const cx = Math.min(Math.max(x, radius), size - radius)
    const cy = Math.min(Math.max(y, radius), size - radius)
    const dx = x - cx, dy = y - cy
    return dx * dx + dy * dy <= radius * radius
  }
  // 渐变色 indigo(#4f46e5) → violet(#7c3aed)
  const lerp = (a, b, t) => Math.round(a + (b - a) * t)
  // 字形区域：宽 60% 高 66%，居中（maskable 缩小到安全区）
  const glyphScale = maskable ? 0.5 : 0.62
  const cell = Math.floor((size * glyphScale) / 7)
  const gw = cell * 5, gh = cell * 7
  const gx = Math.floor((size - gw) / 2)
  const gy = Math.floor((size - gh) / 2)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!inRounded(x, y)) { px[i + 3] = 0; continue }
      const t = y / size
      px[i] = lerp(0x4f, 0x7c, t)
      px[i + 1] = lerp(0x46, 0x3a, t)
      px[i + 2] = lerp(0xe5, 0xed, t)
      px[i + 3] = 255
      // 字形
      const col = Math.floor((x - gx) / cell)
      const row = Math.floor((y - gy) / cell)
      if (x >= gx && x < gx + gw && y >= gy && y < gy + gh && E[row]?.[col] === '1') {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255
      }
    }
  }
  return encodePNG(px, size, size)
}

const outDir = path.resolve('public/icons')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192))
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512))
fs.writeFileSync(path.join(outDir, 'icon-512-maskable.png'), drawIcon(512, { maskable: true }))
console.log('icons generated:', fs.readdirSync(outDir).join(', '))
