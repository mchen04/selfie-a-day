import { describe, expect, it } from 'vitest'
import {
  computeCoverCrop,
  FRAME_ASPECT,
  isFrameSpace,
  outputSize,
} from '../../src/core/geometry.ts'

describe('computeCoverCrop', () => {
  it('keeps full height and crops the sides of a landscape camera', () => {
    // 1280x720 into a 3:4 portrait frame: height is the limiting dimension.
    const crop = computeCoverCrop(1280, 720, FRAME_ASPECT)
    expect(crop.sh).toBe(720)
    expect(crop.sw).toBeCloseTo(540, 6) // 720 * 3/4
    expect(crop.sx).toBeCloseTo((1280 - 540) / 2, 6)
    expect(crop.sy).toBe(0)
  })

  it('keeps full width and crops top and bottom of a tall source', () => {
    // 720x1600 is taller than 3:4, so width is the limiting dimension.
    const crop = computeCoverCrop(720, 1600, FRAME_ASPECT)
    expect(crop.sw).toBe(720)
    expect(crop.sh).toBeCloseTo(960, 6) // 720 / (3/4)
    expect(crop.sx).toBe(0)
    expect(crop.sy).toBeCloseTo((1600 - 960) / 2, 6)
  })

  it('is the identity for a source already in frame space', () => {
    const crop = computeCoverCrop(1080, 1440, FRAME_ASPECT)
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1440 })
  })

  it('always produces a rectangle matching the frame aspect', () => {
    const sources: [number, number][] = [
      [640, 480],
      [1280, 720],
      [1920, 1080],
      [720, 1280],
      [1080, 1440],
      [4032, 3024],
      [3, 4],
      [1000, 1000],
    ]
    for (const [w, h] of sources) {
      const crop = computeCoverCrop(w, h, FRAME_ASPECT)
      expect(crop.sw / crop.sh).toBeCloseTo(FRAME_ASPECT, 9)
      // Never sample outside the source, which would produce black edges.
      expect(crop.sx).toBeGreaterThanOrEqual(-1e-9)
      expect(crop.sy).toBeGreaterThanOrEqual(-1e-9)
      expect(crop.sx + crop.sw).toBeLessThanOrEqual(w + 1e-9)
      expect(crop.sy + crop.sh).toBeLessThanOrEqual(h + 1e-9)
    }
  })

  it('does not depend on the pixel size of the preview box', () => {
    // The whole reason a 390px phone preview and a 1080px capture canvas agree.
    const a = computeCoverCrop(1280, 720, 300 / 400)
    const b = computeCoverCrop(1280, 720, 780 / 1040)
    expect(a).toEqual(b)
  })

  it('rejects degenerate dimensions instead of producing NaN', () => {
    expect(() => computeCoverCrop(0, 720)).toThrow(RangeError)
    expect(() => computeCoverCrop(1280, 0)).toThrow(RangeError)
    expect(() => computeCoverCrop(1280, 720, 0)).toThrow(RangeError)
  })
})

describe('outputSize', () => {
  it('produces even dimensions in frame space', () => {
    for (const longEdge of [480, 960, 1440, 2048, 1441]) {
      const { width, height } = outputSize(longEdge)
      expect(width % 2).toBe(0)
      expect(height % 2).toBe(0)
      expect(isFrameSpace(width, height)).toBe(true)
    }
  })

  it('matches the documented Standard preset exactly', () => {
    expect(outputSize(1440)).toEqual({ width: 1080, height: 1440 })
  })
})

describe('isFrameSpace', () => {
  it('accepts stored photo dimensions', () => {
    expect(isFrameSpace(1080, 1440)).toBe(true)
    expect(isFrameSpace(720, 960)).toBe(true)
  })

  it('rejects the camera aspect ratios that must never reach storage', () => {
    expect(isFrameSpace(1280, 720)).toBe(false)
    expect(isFrameSpace(1920, 1080)).toBe(false)
    expect(isFrameSpace(1000, 1000)).toBe(false)
  })

  it('rejects degenerate sizes', () => {
    expect(isFrameSpace(0, 0)).toBe(false)
    expect(isFrameSpace(-1080, 1440)).toBe(false)
  })
})
