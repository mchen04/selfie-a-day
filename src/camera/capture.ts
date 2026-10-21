import { dayKeyOf, resolvedTimeZone, timeZoneOffsetMinutes } from '../core/day.ts'
import { computeCoverCrop, FRAME_ASPECT, isFrameSpace, outputSize } from '../core/geometry.ts'
import { newPhotoId } from '../core/id.ts'
import {
  DEFAULT_ALBUM_ID,
  SCHEMA_VERSION,
  type CaptureSource,
  type PhotoMeta,
  type StoredImage,
} from '../core/types.ts'
import { bestEncodeFormat, canvasToBlob, decodeImage, makeThumbnail, MASTER_QUALITY } from './encode.ts'
import { timerSeconds } from './preferences.ts'

export interface CaptureOptions {
  longEdge: number
  /** Must equal the mirroring of the preview the user was aligning against. */
  mirrored: boolean
  source?: CaptureSource
  now?: number
  albumId?: string
  /** IANA timezone used for this album's day boundary. */
  timeZone?: string
  timerSeconds?: number
}

export interface CaptureResult {
  meta: PhotoMeta & { timerSeconds: number }
  master: StoredImage
  thumb: StoredImage
  timerSeconds: number
}

export class CaptureError extends Error {
  override name = 'CaptureError'
}

/**
 * Render a source frame into frame space and encode it.
 *
 * This is the only place pixels are written, and it applies exactly the crop
 * that `computeCoverCrop` describes — the same function the preview's layout is
 * derived from. That shared call is what makes "what you aligned against is what
 * got saved" a property of the code rather than a hope.
 */
export async function captureFromSource(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  options: CaptureOptions,
): Promise<CaptureResult> {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new CaptureError('The camera has not produced a frame yet.')
  }

  const { width, height } = outputSize(options.longEdge)
  // Check before doing the work, not after: this guards the invariant, and a
  // violation should cost nothing rather than a full encode.
  if (!isFrameSpace(width, height)) {
    throw new CaptureError(`Capture would produce ${width}x${height}, which is not frame space.`)
  }
  const crop = computeCoverCrop(sourceWidth, sourceHeight, FRAME_ASPECT)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new CaptureError('Could not get a 2D drawing context.')

  if (options.mirrored) {
    // Store the reflection the user actually aligned to, so the ghost derived
    // from this photo needs no transform to line up with a mirrored preview.
    ctx.translate(width, 0)
    ctx.scale(-1, 1)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height)

  const format = await bestEncodeFormat()
  const blob = await canvasToBlob(canvas, format, MASTER_QUALITY)
  const mime = blob.type || format
  const bytes = await blob.arrayBuffer()

  const capturedAt = options.now ?? Date.now()
  const capturedDate = new Date(capturedAt)
  const timeZone = options.timeZone ?? resolvedTimeZone()
  const id = newPhotoId(capturedAt)
  const thumb = await makeThumbnail(bytes, mime)

  return {
    timerSeconds: timerSeconds(options.timerSeconds),
    meta: {
      id,
      albumId: options.albumId ?? DEFAULT_ALBUM_ID,
      dayKey: dayKeyOf(capturedDate, timeZone),
      capturedAt,
      timeZone,
      tzOffsetMinutes: timeZoneOffsetMinutes(capturedDate, timeZone),
      width,
      height,
      mime,
      mirrored: options.mirrored,
      source: options.source ?? 'camera',
      timerSeconds: timerSeconds(options.timerSeconds),
      masterBytes: bytes.byteLength,
      thumbBytes: thumb.bytes.byteLength,
      deletedAt: null,
      schema: SCHEMA_VERSION,
    },
    master: { id, mime, width, height, bytes },
    thumb: { id, ...thumb },
  }
}

export async function captureFromVideo(
  video: HTMLVideoElement,
  options: CaptureOptions,
): Promise<CaptureResult> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new CaptureError('The camera is still starting up. Try again in a moment.')
  }
  return captureFromSource(video, video.videoWidth, video.videoHeight, options)
}

/**
 * Capture from a picked or camera-roll file (the iOS fallback path).
 *
 * A file from the system camera arrives un-mirrored, but the archive it is
 * joining may not be. The caller passes the space the library is already in, and
 * the pixels are written to match — a timeline that mixes both flips left to
 * right on playback, which is the failure this whole app exists to prevent.
 * `mirrored` then records the space the stored pixels are actually in.
 */
export async function captureFromFile(
  file: File,
  options: Omit<CaptureOptions, 'mirrored' | 'source'> & { mirrored?: boolean },
): Promise<CaptureResult> {
  if (!file.type.startsWith('image/')) {
    throw new CaptureError(`"${file.name}" is not an image.`)
  }
  const bytes = await file.arrayBuffer()
  const decoded = await decodeImage(bytes, file.type)
  try {
    return await captureFromSource(decoded.source, decoded.width, decoded.height, {
      ...options,
      mirrored: options.mirrored ?? false,
      source: 'file',
    })
  } finally {
    decoded.release()
  }
}
