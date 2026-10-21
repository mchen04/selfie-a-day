import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureFromFile, captureFromSource, captureFromVideo } from '../../../src/camera/capture.ts'
import { bestEncodeFormat, canvasToBlob, decodeImage, makeThumbnail, MASTER_QUALITY } from '../../../src/camera/encode.ts'

vi.mock('../../../src/camera/encode.ts', () => ({
  bestEncodeFormat: vi.fn().mockResolvedValue('image/webp'),
  canvasToBlob: vi.fn(),
  decodeImage: vi.fn(),
  makeThumbnail: vi.fn().mockResolvedValue({ mime: 'image/webp', width: 240, height: 320, bytes: new ArrayBuffer(4) }),
  MASTER_QUALITY: 0.86,
}))

const drawImage = vi.fn()
const translate = vi.fn()
const scale = vi.fn()
const context = { drawImage, translate, scale, imageSmoothingQuality: 'low' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bestEncodeFormat).mockResolvedValue('image/webp')
  vi.mocked(makeThumbnail).mockResolvedValue({ mime: 'image/webp', width: 240, height: 320, bytes: new ArrayBuffer(4) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.mocked(canvasToBlob).mockResolvedValue({ type: 'image/webp', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob)
})

describe('capture timer metadata and pixels', () => {
  it.each([true, false])('timed and immediate captures keep identical canvas operations, size, quality and mirroring (%s)', async (mirrored) => {
    const source = document.createElement('video')
    Object.defineProperties(source, { readyState: { value: 2 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 } })
    const options = { longEdge: 1440, mirrored, now: 1000, albumId: 'selfies', timeZone: 'UTC' }
    const immediate = await captureFromVideo(source, options)
    const first = {
      draws: drawImage.mock.calls.slice(), translates: translate.mock.calls.slice(), scales: scale.mock.calls.slice(),
      canvas: [vi.mocked(canvasToBlob).mock.calls[0]?.[0].width, vi.mocked(canvasToBlob).mock.calls[0]?.[0].height],
    }
    drawImage.mockClear()
    translate.mockClear()
    scale.mockClear()
    const timed = await captureFromVideo(source, { ...options, timerSeconds: 5 })
    expect(drawImage.mock.calls).toEqual(first.draws)
    expect(translate.mock.calls).toEqual(first.translates)
    expect(scale.mock.calls).toEqual(first.scales)
    expect(first.canvas).toEqual([1080, 1440])
    expect(timed.master.width).toBe(immediate.master.width)
    expect(timed.master.height).toBe(immediate.master.height)
    expect(timed.meta.mirrored).toBe(mirrored)
    expect(timed.timerSeconds).toBe(5)
    expect(timed.meta.timerSeconds).toBe(5)
    expect(immediate.timerSeconds).toBe(0)
    expect(immediate.meta.timerSeconds).toBe(0)
    expect(timed.meta.capturedAt).toBe(1000)
    expect(timed.meta.dayKey).toBe('1970-01-01')
    expect(context.imageSmoothingQuality).toBe('high')
    expect(canvasToBlob).toHaveBeenCalledTimes(2)
    for (const [, mime, quality] of vi.mocked(canvasToBlob).mock.calls) {
      expect(mime).toBe('image/webp')
      expect(quality).toBe(MASTER_QUALITY)
    }
    if (mirrored) {
      expect(translate).toHaveBeenCalledWith(1080, 0)
      expect(scale).toHaveBeenCalledWith(-1, 1)
    } else {
      expect(translate).not.toHaveBeenCalled()
      expect(scale).not.toHaveBeenCalled()
    }
  })

  it('records every allowed timer and normalizes invalid timer metadata to Off', async () => {
    for (const seconds of [0, 3, 5, 10, 4, NaN]) {
      const result = await captureFromSource(document.createElement('video'), 800, 1200, {
        longEdge: 960, mirrored: false, timerSeconds: seconds,
      })
      const expected = [0, 3, 5, 10].includes(seconds) ? seconds : 0
      expect(result.timerSeconds).toBe(expected)
      expect(result.meta.timerSeconds).toBe(expected)
    }
  })

  it('file fallback records an untimed photo with the existing crop and mirroring', async () => {
    const release = vi.fn()
    vi.mocked(decodeImage).mockResolvedValue({ source: document.createElement('img'), width: 1200, height: 800, release })
    const file = { type: 'image/jpeg', arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) } as File
    const result = await captureFromFile(file, { longEdge: 960, mirrored: true })
    expect(result.timerSeconds).toBe(0)
    expect(result.meta.timerSeconds).toBe(0)
    expect(result.meta.source).toBe('file')
    expect(result.meta.mirrored).toBe(true)
    expect(result.master.width / result.master.height).toBe(0.75)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
