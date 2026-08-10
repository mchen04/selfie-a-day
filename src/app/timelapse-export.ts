import { decodeImage, type DecodedImage } from '../camera/encode.ts'
import { dayKeyToDate } from '../core/day.ts'
import { orderTimelapsePhotos } from '../core/timelapse.ts'
import type { PhotoMeta } from '../core/types.ts'
import { getMaster } from '../storage/photos.ts'

const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
]

export interface TimelapseVideo {
  blob: Blob
  extension: 'mp4' | 'webm'
}

export function supportsTimelapseExport(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  )
}

export function timelapseFilename(
  albumName: string,
  photos: readonly PhotoMeta[],
  extension: TimelapseVideo['extension'],
): string {
  const days = photos.map((photo) => photo.dayKey).sort()
  const first = days[0] ?? 'empty'
  const last = days.at(-1) ?? 'empty'
  const album = albumName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'album'
  return `${album}-timelapse-${first}-to-${last}.${extension}`
}

export async function makeTimelapseVideo({
  photos,
  fps,
  showDates,
  onProgress,
}: {
  photos: readonly PhotoMeta[]
  fps: number
  showDates: boolean
  onProgress?: (done: number, total: number) => void
}): Promise<TimelapseVideo> {
  if (!supportsTimelapseExport()) {
    throw new Error('Video export is not supported by this browser.')
  }
  if (photos.length < 2) throw new Error('Choose at least two photos for a timelapse.')
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('Timelapse speed must be positive.')

  const ordered = orderTimelapsePhotos(photos)
  let current = await decodeMaster(ordered[0]!)
  let stream: MediaStream | null = null

  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1440 / Math.max(current.width, current.height))
    canvas.width = Math.max(2, Math.round(current.width * scale))
    canvas.height = Math.max(2, Math.round(current.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare the video canvas.')

    drawFrame(context, canvas, current, ordered[0]!.dayKey, showDates)
    stream = canvas.captureStream(fps)
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
    const mimeType = VIDEO_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 5_000_000,
    })
    const chunks: Blob[] = []
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => reject(new Error('Video encoding failed.'))
      recorder.onstop = () => resolve()
    })

    try {
      recorder.start()
      let next = ordered[1] ? decodeMaster(ordered[1]) : null

      for (let index = 0; index < ordered.length; index += 1) {
        if (index > 0) drawFrame(context, canvas, current, ordered[index]!.dayKey, showDates)
        track?.requestFrame()
        onProgress?.(index + 1, ordered.length)

        const frameDelay = wait(1000 / fps)
        let decodedNext: DecodedImage | null = null
        if (next) {
          const results = await Promise.all([frameDelay, next])
          decodedNext = results[1]
        } else {
          await frameDelay
        }
        if (decodedNext) {
          current.release()
          current = decodedNext
          const after = ordered[index + 2]
          next = after ? decodeMaster(after) : null
        }
      }

      // Give the held final image a sample at the end of its interval. Without
      // this redraw, MediaRecorder ends the file one frame earlier than the UI.
      drawFrame(context, canvas, current, ordered.at(-1)!.dayKey, showDates)
      track?.requestFrame()
      await wait(1000 / fps)
      recorder.stop()
      await stopped
    } catch (error) {
      if (recorder.state !== 'inactive') recorder.stop()
      throw error
    }

    const type = recorder.mimeType || mimeType || chunks[0]?.type || 'video/webm'
    const blob = new Blob(chunks, { type })
    if (blob.size === 0) throw new Error('The browser produced an empty video.')
    return { blob, extension: type.includes('mp4') ? 'mp4' : 'webm' }
  } finally {
    current.release()
    for (const streamTrack of stream?.getTracks() ?? []) streamTrack.stop()
  }
}

async function decodeMaster(photo: PhotoMeta): Promise<DecodedImage> {
  const stored = await getMaster(photo.id)
  if (!stored) throw new Error(`The photo from ${photo.dayKey} is missing from this device.`)
  return decodeImage(stored.bytes, stored.mime)
}

function drawFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  decoded: DecodedImage,
  dayKey: string,
  showDate: boolean,
): void {
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const scale = Math.min(canvas.width / decoded.width, canvas.height / decoded.height)
  const width = decoded.width * scale
  const height = decoded.height * scale
  context.drawImage(decoded.source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)

  if (!showDate) return
  const label = dayKeyToDate(dayKey).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const fontSize = Math.max(22, Math.round(canvas.width * 0.04))
  const padding = Math.round(fontSize * 0.55)
  context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
  context.textBaseline = 'middle'
  const textWidth = context.measureText(label).width
  const boxHeight = fontSize + padding * 1.2
  const x = padding
  const y = canvas.height - boxHeight - padding
  context.fillStyle = 'rgba(0, 0, 0, 0.65)'
  context.fillRect(x, y, textWidth + padding * 2, boxHeight)
  context.fillStyle = '#fff'
  context.fillText(label, x + padding, y + boxHeight / 2)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}
