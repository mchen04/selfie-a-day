/**
 * Day identity, in the user's local time.
 *
 * "One selfie a day" is a human claim, not a UTC one: a photo taken at 11pm and
 * one taken at 1am are different days to the user even though they may be the
 * same UTC day. Every day boundary in this app is local, and each photo records
 * the timezone offset it was taken at so a later timezone change cannot silently
 * re-bucket history.
 */

/** `YYYY-MM-DD` in local time. Sorts lexicographically, which we rely on. */
export type DayKey = string

export function dayKeyOf(date: Date = new Date()): DayKey {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDayKey(value: unknown): value is DayKey {
  return typeof value === 'string' && DAY_KEY_RE.test(value)
}

/** Local midnight for a day key. Throws on a malformed key rather than drifting. */
export function dayKeyToDate(key: DayKey): Date {
  if (!isDayKey(key)) throw new RangeError(`Not a day key: ${JSON.stringify(key)}`)
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

/** Whole local days between two keys (b - a). */
export function daysBetween(a: DayKey, b: DayKey): number {
  const ms = dayKeyToDate(b).getTime() - dayKeyToDate(a).getTime()
  // Round rather than floor: DST shifts make some local days 23 or 25 hours.
  return Math.round(ms / 86_400_000)
}

export function addDays(key: DayKey, delta: number): DayKey {
  const d = dayKeyToDate(key)
  d.setDate(d.getDate() + delta)
  return dayKeyOf(d)
}

/**
 * Current streak: consecutive days with a photo, ending today or yesterday.
 *
 * Ending yesterday still counts — today is not over yet, and telling someone
 * their 200-day streak is dead at 9am because they have not taken today's photo
 * is the kind of detail that makes people quit.
 */
export function currentStreak(dayKeys: readonly DayKey[], today: DayKey = dayKeyOf()): number {
  if (dayKeys.length === 0) return 0
  const present = new Set(dayKeys)

  let cursor = present.has(today) ? today : addDays(today, -1)
  if (!present.has(cursor)) return 0

  let streak = 0
  while (present.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

/** Human label: "Today", "Yesterday", else a localised medium date. */
export function formatDayLabel(key: DayKey, today: DayKey = dayKeyOf()): string {
  const delta = daysBetween(key, today)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Yesterday'
  return dayKeyToDate(key).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: dayKeyToDate(key).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}
