import { wallClock } from '../e2e-support/push.ts'
import { ZONE } from './config.ts'

/**
 * The ten simulated days, by their real calendar dates in Los Angeles. Day 6
 * (Sunday 1 November 2026) is the day daylight saving time ends there: 02:00
 * PDT becomes 01:00 PST. Weekday names come from the date, never from a table.
 */
export const DAY_KEYS = [
  '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
  '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
] as const

export const weekday = (dayKey: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(Date.parse(`${dayKey}T12:00:00Z`))

export const dayLabel = (day: number) => `Day ${day} · ${weekday(DAY_KEYS[day - 1]!)} ${DAY_KEYS[day - 1]}`

/** Epoch ms when Los Angeles clocks read `time` on `dayKey`. */
export const at = (dayKey: string, time: string) => wallClock(dayKey, time, ZONE)

/** `2026-11-01 09:05 PST` style label for evidence. */
export function simStamp(instant: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${part('timeZoneName')}`
}
