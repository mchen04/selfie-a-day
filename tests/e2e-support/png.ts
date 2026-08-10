import { inflateSync } from 'node:zlib'

export interface DecodedPNG {
  width: number
  height: number
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8Array
}

/**
 * Minimal PNG decoder for screenshot assertions.
 *
 * Playwright hands back PNG bytes; without decoding them, any claim about what
 * is on screen is a claim about a file we never looked inside. Node's zlib does
 * the decompression, so this needs no image dependency — it only has to handle
 * what Chromium actually emits: non-interlaced 8-bit RGB or RGBA.
 */
export function decodePNG(bytes: Buffer): DecodedPNG {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) throw new Error('Not a PNG file')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8

    if (type === 'IHDR') {
      width = bytes.readUInt32BE(start)
      height = bytes.readUInt32BE(start + 4)
      bitDepth = bytes[start + 8]!
      colorType = bytes[start + 9]!
      interlace = bytes[start + 12]!
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length))
    } else if (type === 'IEND') {
      break
    }

    offset = start + length + 4 // skip data + CRC
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`)
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`Unsupported PNG colour type: ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const line = new Uint8Array(stride)
  const previous = new Uint8Array(stride)

  let pointer = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pointer++]!
    for (let x = 0; x < stride; x++) line[x] = raw[pointer + x]!
    pointer += stride

    // Undo the per-scanline filter (PNG spec section 9.2).
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0
      const b = previous[x]!
      const c = x >= channels ? previous[x - channels]! : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[x] = (line[x]! + a) & 0xff
          break
        case 2:
          line[x] = (line[x]! + b) & 0xff
          break
        case 3:
          line[x] = (line[x]! + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          line[x] = (line[x]! + pred) & 0xff
          break
        }
        default:
          throw new Error(`Unknown PNG filter type ${filter}`)
      }
    }

    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      out[dst] = line[src]!
      out[dst + 1] = line[src + 1]!
      out[dst + 2] = line[src + 2]!
      out[dst + 3] = channels === 4 ? line[src + 3]! : 255
    }

    previous.set(line)
  }

  return { width, height, data: out }
}

/**
 * Average colour of a small patch, so a single stray antialiased pixel cannot
 * decide the result.
 */
export function samplePatch(
  image: DecodedPNG,
  u: number,
  v: number,
  radius = 4,
): [number, number, number] {
  const cx = Math.round(u * (image.width - 1))
  const cy = Math.round(v * (image.height - 1))
  let r = 0
  let g = 0
  let b = 0
  let n = 0

  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
      const i = (y * image.width + x) * 4
      r += image.data[i]!
      g += image.data[i + 1]!
      b += image.data[i + 2]!
      n++
    }
  }

  if (n === 0) throw new Error(`Sample point (${u}, ${v}) is outside the image`)
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}
