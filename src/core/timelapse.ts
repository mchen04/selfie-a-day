import { addDays, type DayKey } from './day.ts'

export type TimelapseRangePreset = 'all' | '30-days' | '1-year' | 'custom'

export interface TimelapseRange {
  preset: TimelapseRangePreset
  from?: DayKey | null
  to?: DayKey | null
}

export function filterTimelapsePhotos<T extends { dayKey: DayKey }>(
  photos: readonly T[],
  range: TimelapseRange,
): T[] {
  if (range.preset === 'all') return [...photos]
  if (photos.length === 0) return []

  let from: DayKey | null = null
  let to: DayKey | null = null

  if (range.preset === 'custom') {
    from = range.from ?? null
    to = range.to ?? null
  } else {
    to = photos.reduce((latest, photo) => (photo.dayKey > latest ? photo.dayKey : latest), photos[0]!.dayKey)
    from = addDays(to, range.preset === '30-days' ? -29 : -364)
  }

  if (!from || !to || from > to) return []
  return photos.filter((photo) => photo.dayKey >= from && photo.dayKey <= to)
}

export function timelapseDurationSeconds(frameCount: number, fps: number): number {
  if (frameCount <= 0) return 0
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('Timelapse speed must be positive.')
  return frameCount / fps
}

export function formatTimelapseDuration(frameCount: number, fps: number): string {
  const duration = timelapseDurationSeconds(frameCount, fps)
  if (duration === 0) return '0 sec'
  if (duration < 1) return `${Math.max(0.1, Number(duration.toFixed(1))).toFixed(1)} sec`
  if (duration < 60) return `${Number(duration.toFixed(1))} sec`

  const rounded = Math.round(duration)
  const minutes = Math.floor(rounded / 60)
  const seconds = rounded % 60
  return `${minutes} min${seconds === 0 ? '' : ` ${seconds} sec`}`
}
