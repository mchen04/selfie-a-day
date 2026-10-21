import type { PushPreference } from '../../src/api/client.ts'
import { dayKeyOf, timeZoneOffsetMinutes } from '../../src/core/day.ts'

export function reminderSchedule(pref: PushPreference, now: number) {
  const dayKey = dayKeyOf(new Date(now), pref.timeZone)
  const at = (time: string, minutesAfter = 0) => {
    const wallTime = Date.parse(`${dayKey}T${time}:00Z`) + minutesAfter * 60_000
    let instant = wallTime
    for (let pass = 0; pass < 2; pass++) {
      instant = wallTime + timeZoneOffsetMinutes(new Date(instant), pref.timeZone) * 60_000
    }
    return instant
  }
  return {
    dayKey,
    morning: at(pref.time, 5),
    evening: at('20:35'),
  }
}
