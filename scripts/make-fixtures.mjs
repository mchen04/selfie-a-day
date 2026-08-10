import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'tests/fixtures')
mkdirSync(outDir, { recursive: true })

/**
 * A Y4M video for Chromium's `--use-file-for-fake-video-capture`, painted with
 * an asymmetric, precisely-placed target.
 *
 * This is what turns "the ghost looks about right" into a measurement. The
 * frame carries markers at known fractions of the source, so a test can compute
 * where each one must land after the cover-crop and mirroring, then read the
 * captured pixels and check. Asymmetry is the point: a left/right or top/bottom
 * mix-up has to change the answer.
 *
 * Source is 1280x720 — a landscape webcam, the case where the 3:4 frame crops
 * the sides and where a wrong crop is most visible.
 */
const WIDTH = 1280
const HEIGHT = 720
// Two frames: a single-frame Y4M does not loop cleanly in Chromium's fake
// capture device, which leaves the preview blank for some contexts.
const FRAMES = 2

/** Markers as {x, y} fractions of the SOURCE frame, with an RGB colour. */
export const MARKERS = [
  // Inside the 3:4 centre crop (x in [0.28125, 0.71875]) so they survive it.
  { name: 'left', x: 0.34, y: 0.25, rgb: [255, 0, 0] }, // red
  { name: 'right', x: 0.66, y: 0.25, rgb: [0, 0, 255] }, // blue
  { name: 'bottom', x: 0.5, y: 0.78, rgb: [0, 255, 0] }, // green
]

const MARKER_RADIUS = 26

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function rgbToYuv(r, g, b) {
  return [
    clamp(Math.round(0.299 * r + 0.587 * g + 0.114 * b), 0, 255),
    clamp(Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128), 0, 255),
    clamp(Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128), 0, 255),
  ]
}

function buildFrame() {
  const ySize = WIDTH * HEIGHT
  const cW = WIDTH / 2
  const cH = HEIGHT / 2

  const [bgY, bgU, bgV] = rgbToYuv(24, 24, 28)
  const yPlane = new Uint8Array(ySize).fill(bgY)
  const uPlane = new Uint8Array(cW * cH).fill(bgU)
  const vPlane = new Uint8Array(cW * cH).fill(bgV)

  for (const marker of MARKERS) {
    const [my, mu, mv] = rgbToYuv(...marker.rgb)
    const cx = Math.round(marker.x * WIDTH)
    const cy = Math.round(marker.y * HEIGHT)

    for (let dy = -MARKER_RADIUS; dy <= MARKER_RADIUS; dy++) {
      for (let dx = -MARKER_RADIUS; dx <= MARKER_RADIUS; dx++) {
        if (dx * dx + dy * dy > MARKER_RADIUS * MARKER_RADIUS) continue
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue
        yPlane[y * WIDTH + x] = my
        const ci = Math.floor(y / 2) * cW + Math.floor(x / 2)
        uPlane[ci] = mu
        vPlane[ci] = mv
      }
    }
  }

  return Buffer.concat([Buffer.from(yPlane), Buffer.from(uPlane), Buffer.from(vPlane)])
}

const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F30:1 Ip A1:1 C420jpeg\n`, 'ascii')
const frameHeader = Buffer.from('FRAME\n', 'ascii')
const frame = buildFrame()

const parts = [header]
for (let i = 0; i < FRAMES; i++) parts.push(frameHeader, frame)

const target = resolve(outDir, 'alignment-target.y4m')
writeFileSync(target, Buffer.concat(parts))

writeFileSync(
  resolve(outDir, 'alignment-target.json'),
  JSON.stringify({ width: WIDTH, height: HEIGHT, markerRadius: MARKER_RADIUS, markers: MARKERS }, null, 2),
)

console.log(`wrote tests/fixtures/alignment-target.y4m (${WIDTH}x${HEIGHT}, ${FRAMES} frames)`)
console.log('wrote tests/fixtures/alignment-target.json')
