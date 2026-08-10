import type { StoredImage } from '../core/types.ts'

export const JPEG = 'image/jpeg'
export const WEBP = 'image/webp'

export const MASTER_QUALITY = 0.86
export const THUMB_QUALITY = 0.72
export const THUMB_LONG_EDGE = 320

/**
 * WebP saves roughly a third of the bytes at matching quality, which directly
 * extends how long a timeline fits inside a phone's storage quota. But canvas
 * WebP encoding arrived late in WebKit, and a browser that cannot encode it
 * silently hands back a PNG — far larger than the JPEG we were avoiding. So we
 * ask the canvas what it actually produced instead of trusting a version check.
 */
let formatProbe: Promise<string> | null = null

export function bestEncodeFormat(): Promise<string> {
  formatProbe ??= (async () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const blob = await canvasToBlob(canvas, WEBP, 0.8)
      return blob.type === WEBP ? WEBP : JPEG
    } catch {
      return JPEG
    }
  })()
  return formatProbe
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error(`Could not encode canvas as ${mime}`))
      },
      mime,
      quality,
    )
  })
}

export interface DecodedImage {
  readonly source: CanvasImageSource
  readonly width: number
  readonly height: number
  release(): void
}

/**
 * Decode stored bytes into something drawable.
 *
 * Both paths hold an object URL or an ImageBitmap, and both leak if the caller
 * forgets to release. Callers must use try/finally — the timeline decodes on
 * every scroll, so a leak here is measured in hundreds of megabytes, not bytes.
 */
export async function decodeImage(bytes: ArrayBuffer, mime: string): Promise<DecodedImage> {
  const blob = new Blob([bytes], { type: mime })

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      }
    } catch {
      // Fall through to the <img> path rather than failing the whole decode.
    }
  }

  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImageElement(url)
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode image data'))
    image.src = url
  })
}

/**
 * Shrink an already-frame-space image to a timeline thumbnail.
 *
 * The aspect ratio is preserved exactly — a thumbnail that crops differently
 * from its master would make the timeline disagree with the photo it opens.
 */
export async function makeThumbnail(
  bytes: ArrayBuffer,
  mime: string,
  longEdge: number = THUMB_LONG_EDGE,
): Promise<Omit<StoredImage, 'id'>> {
  const decoded = await decodeImage(bytes, mime)
  try {
    const scale = Math.min(1, longEdge / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D context for the thumbnail')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(decoded.source, 0, 0, width, height)

    const format = await bestEncodeFormat()
    const blob = await canvasToBlob(canvas, format, THUMB_QUALITY)
    return { mime: blob.type || format, width, height, bytes: await blob.arrayBuffer() }
  } finally {
    decoded.release()
  }
}
