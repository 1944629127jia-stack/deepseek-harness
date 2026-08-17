/**
 * Generate the desktop shell's icons with zero dependencies:
 * a gradient rounded square with a white four-point spark, encoded as PNG
 * (zlib deflate of raw RGBA scanlines), plus a Windows ICO wrapping the PNGs.
 *
 * Outputs into desktop/build/:
 *   icon.png  256x256 (Linux / general use)
 *   tray.png   32x32  (tray template)
 *   icon.ico          (256 + 32, Windows installer & window icon)
 *
 * Usage: node desktop/scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../build', import.meta.url))

/** Render one pixel of the icon in normalized [-1,1] coordinates; returns [r,g,b,a]. */
function shade(nx, ny) {
  // Rounded-square mask, corner radius 22% of the half-size.
  const radius = 0.44
  const qx = Math.abs(nx) - (1 - radius)
  const qy = Math.abs(ny) - (1 - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  if (outside > 0) return [0, 0, 0, 0]
  // Diagonal gradient: DeepSeek blue → cyan.
  const t = Math.min(1, Math.max(0, (nx + ny + 2) / 4))
  const r = Math.round(0x4d + (0x22 - 0x4d) * t)
  const g = Math.round(0x6b + (0xb8 - 0x6b) * t)
  const b = Math.round(0xfe + (0xf0 - 0xfe) * t)
  // Four-point spark centered in the square.
  const px = nx * 1.15
  const py = ny * 1.15
  const half = 0.62
  const core = 0.16
  const inSpark = Math.abs(px) + Math.abs(py) <= half
    && Math.abs(py) <= core + ((half - Math.abs(px)) / half) * (half - core)
    && Math.abs(px) <= core + ((half - Math.abs(py)) / half) * (half - core)
  if (inSpark) return [255, 255, 255, 255]
  return [r, g, b, 255]
}

/** Render the icon at `size` with 4x supersampling for anti-aliased edges. */
function render(size) {
  const scale = 4
  const hi = size * scale
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const nx = (((x * scale + sx + 0.5) / hi) * 2) - 1
          const ny = (((y * scale + sy + 0.5) / hi) * 2) - 1
          const [pr, pg, pb, pa] = shade(nx, ny)
          r += pr * pa
          g += pg * pa
          b += pb * pa
          a += pa
        }
      }
      const samples = scale * scale
      const offset = (y * size + x) * 4
      pixels[offset] = a === 0 ? 0 : Math.round(r / a)
      pixels[offset + 1] = a === 0 ? 0 : Math.round(g / a)
      pixels[offset + 2] = a === 0 ? 0 : Math.round(b / a)
      pixels[offset + 3] = Math.round(a / samples)
    }
  }
  return pixels
}

/** Minimal PNG encoder: 8-bit RGBA, one IDAT, no interlace. */
function encodePng(size, pixels) {
  const scanlines = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    scanlines[y * (size * 4 + 1)] = 0
    pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const chunks = [pngChunk('IHDR', ihdr(size)), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

function ihdr(size) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(size, 0)
  data.writeUInt32BE(size, 4)
  data[8] = 8 // bit depth
  data[9] = 6 // color type RGBA
  return data
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Windows ICO with PNG-compressed entries (Vista+). */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const records = entries.map(({ size, png }) => {
    const record = Buffer.alloc(16)
    record[0] = size >= 256 ? 0 : size
    record[1] = size >= 256 ? 0 : size
    record.writeUInt16LE(1, 4) // planes
    record.writeUInt16LE(32, 6) // bit count
    record.writeUInt32LE(png.length, 8)
    record.writeUInt32LE(offset, 12)
    offset += png.length
    return record
  })
  return Buffer.concat([header, ...records, ...entries.map(entry => entry.png)])
}

mkdirSync(OUT_DIR, { recursive: true })
const png256 = encodePng(256, render(256))
const png32 = encodePng(32, render(32))
writeFileSync(join(OUT_DIR, 'icon.png'), png256)
writeFileSync(join(OUT_DIR, 'tray.png'), png32)
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco([{ size: 256, png: png256 }, { size: 32, png: png32 }]))
console.log(`make-icons: wrote icon.png, tray.png, icon.ico to ${OUT_DIR}`)
