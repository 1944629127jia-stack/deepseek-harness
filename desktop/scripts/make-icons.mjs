/**
 * Generate the desktop shell's icons from the DeepSeek whale
 * (website/public/favicon.svg), rasterized through sharp (resolved from the
 * workspace — `@deepseek-ai/dsh-attachment-local` depends on it).
 *
 * Outputs into desktop/build/:
 *   icon.png  256x256 (Linux / general use)
 *   tray.png   32x32  (tray template)
 *   icon.ico          (256 + 48 + 32 + 16 PNG-compressed, Windows installer & window icon)
 *
 * Usage: node desktop/scripts/make-icons.mjs   (from the repository root)
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../packages/attachment/attachment-local/package.json', import.meta.url))
const sharp = require('sharp')

const SRC = fileURLToPath(new URL('../../website/public/favicon.svg', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../build', import.meta.url))
// The official dark-slate whale (#3C3C46, sampled from the product reference)
// rather than the website favicon's #4D6BFE blue.
const WHALE_COLOR = '#3C3C46'

/** Rasterize the whale at one size with ~8% transparent padding around it. */
async function render(size) {
  const svg = readFileSync(SRC, 'utf8').replaceAll('#4D6BFE', WHALE_COLOR)
  const inner = Math.round(size * 0.84)
  const whale = await sharp(Buffer.from(svg), { density: 512 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: whale, gravity: 'center' }])
    .png()
    .toBuffer()
}

const sizes = [256, 48, 32, 16]
const images = []
for (const size of sizes) images.push(await render(size))

writeFileSync(`${OUT_DIR}/icon.png`, images[0])
writeFileSync(`${OUT_DIR}/tray.png`, images[2])

// ICO (PNG-compressed entries), largest first.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)
let offset = 6 + images.length * 16
const entries = images.map((png, index) => {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], 0) // width (0 = 256)
  entry.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], 1) // height
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8) // dwBytesInRes
  entry.writeUInt32LE(offset, 12) // dwImageOffset
  offset += png.length
  return entry
})
writeFileSync(`${OUT_DIR}/icon.ico`, Buffer.concat([header, ...entries, ...images]))
console.log(`make-icons: ${sizes.join('/')}px whale icons written to desktop/build/`)
