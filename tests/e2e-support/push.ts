import type { PushPreference } from '../../src/api/client.ts'
import { dayKeyOf, timeZoneOffsetMinutes } from '../../src/core/day.ts'

/** The instant a wall clock in `timeZone` reads `time` on `dayKey`, DST included. */
export function wallClock(dayKey: string, time: string, timeZone: string, minutesAfter = 0): number {
  const wallTime = Date.parse(`${dayKey}T${time}:00Z`) + minutesAfter * 60_000
  let instant = wallTime
  for (let pass = 0; pass < 2; pass++) {
    instant = wallTime + timeZoneOffsetMinutes(new Date(instant), timeZone) * 60_000
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
