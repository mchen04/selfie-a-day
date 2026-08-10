import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, encodePNG } from './png.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/icons')
mkdirSync(outDir, { recursive: true })

const BG = [10, 10, 12]
const INK = [244, 244, 246]
const ACCENT = [94, 224, 184]

/**
 * The mark is the product in one glyph: a crisp ring (today's face) with a
 * faint offset ring behind it (yesterday's ghost) and a hairline grid.
 * `bleed` = true fills the whole square (maskable), false insets a rounded tile.
 */
function drawMark(size, { bleed }) {
  const c = createCanvas(size)
  const S = c.w
  c.fillAll(BG, 1)

  const inset = bleed ? 0 : S * 0.085
  if (!bleed) {
    c.roundRect(inset, inset, S - inset, S - inset, S * 0.225, BG, 1)
  }

  // Safe zone for maskable icons is the middle 80%; keep the glyph inside 62%.
  const cx = S / 2
  const cy = S / 2
  const r = S * (bleed ? 0.235 : 0.255)
  const stroke = S * 0.045

  // Hairline grid — thirds, the alignment aid.
  const gridA = 0.16
  const g = S * 0.006
  for (const t of [1 / 3, 2 / 3]) {
    const gx = inset + (S - 2 * inset) * t
    c.rect(gx - g, inset + S * 0.06, gx + g, S - inset - S * 0.06, INK, gridA)
    c.rect(inset + S * 0.06, gx - g, S - inset - S * 0.06, gx + g, INK, gridA)
  }

  // Ghost of yesterday: offset up-left, translucent accent.
  c.ring(cx - r * 0.34, cy - r * 0.3, r + stroke / 2, r - stroke / 2, ACCENT, 0.45)

  // Today: crisp ink ring.
  c.ring(cx, cy, r + stroke / 2, r - stroke / 2, INK, 1)

  // Shutter dot — the one-tap promise.
  c.disc(cx, cy + r * 0.02, S * 0.052, ACCENT, 1)

  return encodePNG(size, size, c.toRGBA())
}

const targets = [
  ['icon-192.png', 192, { bleed: false }],
  ['icon-512.png', 512, { bleed: false }],
  ['maskable-192.png', 192, { bleed: true }],
  ['maskable-512.png', 512, { bleed: true }],
  // iOS ignores the manifest for the home-screen icon and uses apple-touch-icon.
  // It also does not respect transparency, so this one is always full-bleed.
  ['apple-touch-icon.png', 180, { bleed: true }],
]

for (const [name, size, opts] of targets) {
  writeFileSync(resolve(outDir, name), drawMark(size, opts))
  console.log(`wrote public/icons/${name} (${size}x${size})`)
}

// Favicon as SVG: crisp at every size, ~600 bytes, no extra request weight.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0a0c"/>
  <circle cx="27" cy="30" r="15" fill="none" stroke="#5ee0b8" stroke-opacity=".45" stroke-width="3"/>
  <circle cx="32" cy="32" r="15" fill="none" stroke="#f4f4f6" stroke-width="3"/>
  <circle cx="32" cy="32" r="3.4" fill="#5ee0b8"/>
</svg>
`
writeFileSync(resolve(root, 'public/favicon.svg'), favicon)
console.log('wrote public/favicon.svg')
