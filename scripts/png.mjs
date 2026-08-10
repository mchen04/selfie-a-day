import { deflateSync } from 'node:zlib'

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/**
 * Encode RGBA pixels as a PNG. `rgba` is a Uint8ClampedArray/Buffer of w*h*4 bytes.
 * Pure Node (zlib only) so the repo needs no image dependency.
 */
export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0 (None)
    Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length).copy(
      raw,
      y * (stride + 1) + 1,
      y * stride,
      y * stride + stride,
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Simple RGBA canvas with 4x supersampled drawing helpers. */
export function createCanvas(size, ss = 4) {
  const w = size * ss
  const px = new Float64Array(w * w * 4)

  const blend = (x, y, [r, g, b], a) => {
    if (a <= 0 || x < 0 || y < 0 || x >= w || y >= w) return
    const i = (y * w + x) * 4
    px[i] = px[i] * (1 - a) + r * a
    px[i + 1] = px[i + 1] * (1 - a) + g * a
    px[i + 2] = px[i + 2] * (1 - a) + b * a
    px[i + 3] = Math.min(1, px[i + 3] + a)
  }

  return {
    size,
    ss,
    w,
    fillAll(color, a = 1) {
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) blend(x, y, color, a)
    },
    /** Rounded rectangle in supersampled coordinates. */
    roundRect(x0, y0, x1, y1, radius, color, a = 1) {
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius))
          const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius))
          if (dx * dx + dy * dy <= radius * radius) blend(x, y, color, a)
        }
      }
    },
    /** Ring (annulus). rOuter/rInner in supersampled units. */
    ring(cx, cy, rOuter, rInner, color, a = 1) {
      for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
        for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
          const d = Math.hypot(x - cx, y - cy)
          if (d <= rOuter && d >= rInner) blend(x, y, color, a)
        }
      }
    },
    disc(cx, cy, r, color, a = 1) {
      this.ring(cx, cy, r, 0, color, a)
    },
    rect(x0, y0, x1, y1, color, a = 1) {
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) blend(x, y, color, a)
    },
    /** Downsample the supersampled buffer to `size`x`size` RGBA bytes. */
    toRGBA() {
      const out = new Uint8ClampedArray(size * size * 4)
      const n = ss * ss
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let r = 0,
            g = 0,
            b = 0,
            al = 0
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) {
              const i = ((y * ss + sy) * w + (x * ss + sx)) * 4
              r += px[i]
              g += px[i + 1]
              b += px[i + 2]
              al += px[i + 3]
            }
          }
          const o = (y * size + x) * 4
          out[o] = r / n
          out[o + 1] = g / n
          out[o + 2] = b / n
          out[o + 3] = (al / n) * 255
        }
      }
      return out
    },
  }
}
