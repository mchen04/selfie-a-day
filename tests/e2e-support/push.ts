import type { PushPreference } from '../../src/api/client.ts'
import { dayKeyOf } from '../../src/core/day.ts'

/** `Date#getTimezoneOffset` semantics for any IANA timezone. */
function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return Math.round((date.getTime() - Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))) / 60_000)
}

/** The instant a wall clock in `timeZone` reads `time` on `dayKey`, DST included. */
export function wallClock(dayKey: string, time: string, timeZone: string, minutesAfter = 0): number {
  const wallTime = Date.parse(`${dayKey}T${time}:00Z`) + minutesAfter * 60_000
  let instant = wallTime
  for (let pass = 0; pass < 2; pass++) {
    instant = wallTime + offsetMinutes(new Date(instant), timeZone) * 60_000
  }
  return instant
}

export function reminderSchedule(pref: PushPreference, now: number) {
  const dayKey = dayKeyOf(new Date(now), pref.timeZone)
  return {
    dayKey,
    morning: wallClock(dayKey, pref.time, pref.timeZone, 5),
    evening: wallClock(dayKey, '20:35', pref.timeZone),
  }
}
