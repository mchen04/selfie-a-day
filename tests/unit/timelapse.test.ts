import { describe, expect, it } from 'vitest'
import {
  filterTimelapsePhotos,
  formatTimelapseDuration,
  orderTimelapsePhotos,
  timelapseDurationSeconds,
} from '../../src/core/timelapse.ts'

const photos = [
  { id: 'newest', dayKey: '2026-08-10' },
  { id: 'month-old', dayKey: '2026-07-12' },
  { id: 'older', dayKey: '2026-07-11' },
  { id: 'year-old', dayKey: '2025-08-11' },
  { id: 'too-old', dayKey: '2025-08-10' },
] as const

describe('filterTimelapsePhotos', () => {
  it('keeps the album order when every photo is selected', () => {
    expect(filterTimelapsePhotos(photos, { preset: 'all' }).map((photo) => photo.id)).toEqual(
      photos.map((photo) => photo.id),
    )
  })

  it('anchors recent presets to the newest album photo', () => {
    expect(
      filterTimelapsePhotos(photos, { preset: '30-days' }).map((photo) => photo.id),
    ).toEqual(['newest', 'month-old'])
    expect(
      filterTimelapsePhotos(photos, { preset: '1-year' }).map((photo) => photo.id),
    ).toEqual(['newest', 'month-old', 'older', 'year-old'])
  })

  it('includes both ends of a custom date range', () => {
    expect(
      filterTimelapsePhotos(photos, {
        preset: 'custom',
        from: '2026-07-11',
        to: '2026-07-12',
      }).map((photo) => photo.id),
    ).toEqual(['month-old', 'older'])
  })

  it('returns no frames for an incomplete or inverted custom range', () => {
    expect(filterTimelapsePhotos(photos, { preset: 'custom', from: null, to: null })).toEqual([])
    expect(
      filterTimelapsePhotos(photos, {
        preset: 'custom',
        from: '2026-08-10',
        to: '2026-07-11',
      }),
    ).toEqual([])
  })
})

describe('timelapse duration', () => {
  it('calculates duration from frames and playback speed', () => {
    expect(timelapseDurationSeconds(12, 6)).toBe(2)
    expect(timelapseDurationSeconds(1, 12)).toBeCloseTo(1 / 12)
    expect(timelapseDurationSeconds(0, 6)).toBe(0)
  })

  it('formats short and long videos without false precision', () => {
    expect(formatTimelapseDuration(0, 6)).toBe('0 sec')
    expect(formatTimelapseDuration(2, 12)).toBe('0.2 sec')
    expect(formatTimelapseDuration(12, 6)).toBe('2 sec')
    expect(formatTimelapseDuration(372, 6)).toBe('1 min 2 sec')
  })
})

describe('orderTimelapsePhotos', () => {
  it('uses capture order even when timezone changes make day keys move backwards', () => {
    const frames = [
      { id: 'later', dayKey: '2026-08-09', capturedAt: 200 },
      { id: 'earlier', dayKey: '2026-08-10', capturedAt: 100 },
    ]
    expect(orderTimelapsePhotos(frames).map((frame) => frame.id)).toEqual(['earlier', 'later'])
  })
})
