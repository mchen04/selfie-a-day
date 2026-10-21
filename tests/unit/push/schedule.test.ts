import { describe, expect, it } from 'vitest'
import { reminderSchedule } from '../../e2e-support/push.ts'

describe('push browser cron schedule', () => {
  it.each([
    ['summer', '2026-07-01T19:00:00Z', '09:00', '2026-07-01', '2026-07-01T16:05:00Z', '2026-07-02T03:35:00Z'],
    ['winter', '2026-01-01T20:00:00Z', '09:00', '2026-01-01', '2026-01-01T17:05:00Z', '2026-01-02T04:35:00Z'],
    ['spring-forward day', '2026-03-08T08:30:00Z', '09:00', '2026-03-08', '2026-03-08T16:05:00Z', '2026-03-09T03:35:00Z'],
    ['fall-back day', '2026-11-01T07:30:00Z', '09:00', '2026-11-01', '2026-11-01T17:05:00Z', '2026-11-02T04:35:00Z'],
    ['different UTC date', '2026-07-02T01:00:00Z', '09:00', '2026-07-01', '2026-07-01T16:05:00Z', '2026-07-02T03:35:00Z'],
    ['saved reminder time', '2026-07-01T19:00:00Z', '10:15', '2026-07-01', '2026-07-01T17:20:00Z', '2026-07-02T03:35:00Z'],
  ])('uses the saved Los Angeles preference for %s', (_case, now, time, dayKey, morning, evening) => {
    const schedule = reminderSchedule({ albumId: 'selfies', enabled: true, time, timeZone: 'America/Los_Angeles' }, Date.parse(now))
    expect(schedule).toEqual({ dayKey, morning: Date.parse(morning), evening: Date.parse(evening) })
  })
})
