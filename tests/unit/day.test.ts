import { describe, expect, it } from 'vitest'
import { addDays, currentStreak, dayKeyOf, daysBetween, formatDayLabel, isDayKey } from '../../src/core/day.ts'

describe('dayKeyOf', () => {
  it('uses local time, not UTC', () => {
    // 23:30 local on the 9th is still the 9th, whatever UTC thinks.
    const late = new Date(2026, 7, 9, 23, 30, 0)
    expect(dayKeyOf(late)).toBe('2026-08-09')
    const early = new Date(2026, 7, 10, 0, 30, 0)
    expect(dayKeyOf(early)).toBe('2026-08-10')
  })

  it('zero-pads so keys sort lexicographically', () => {
    expect(dayKeyOf(new Date(2026, 0, 5))).toBe('2026-01-05')
    const keys = [
      dayKeyOf(new Date(2026, 10, 2)),
      dayKeyOf(new Date(2026, 0, 5)),
      dayKeyOf(new Date(2026, 8, 30)),
    ]
    expect([...keys].sort()).toEqual(['2026-01-05', '2026-09-30', '2026-11-02'])
  })
})

describe('isDayKey', () => {
  it('accepts well-formed keys and rejects everything else', () => {
    expect(isDayKey('2026-08-09')).toBe(true)
    expect(isDayKey('2026-8-9')).toBe(false)
    expect(isDayKey('')).toBe(false)
    expect(isDayKey(20260809)).toBe(false)
    expect(isDayKey(null)).toBe(false)
    expect(isDayKey('2026-08-09T10:00:00Z')).toBe(false)
  })
})

describe('daysBetween / addDays', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween('2026-08-30', '2026-09-02')).toBe(3)
    expect(daysBetween('2026-09-02', '2026-08-30')).toBe(-3)
  })

  it('counts whole days across a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
  })

  it('survives a daylight-saving transition', () => {
    // US DST springs forward on 8 March 2026; that local day is 23 hours long.
    // Rounding rather than flooring is what keeps this at exactly 1.
    expect(daysBetween('2026-03-07', '2026-03-08')).toBe(1)
    expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1)
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1)
  })

  it('round-trips with addDays', () => {
    for (const delta of [-400, -31, -1, 0, 1, 31, 400]) {
      const moved = addDays('2026-08-09', delta)
      expect(daysBetween('2026-08-09', moved)).toBe(delta)
    }
  })

  it('rejects malformed keys rather than silently drifting', () => {
    expect(() => daysBetween('not-a-day', '2026-08-09')).toThrow(RangeError)
  })
})

describe('currentStreak', () => {
  it('is zero with no photos', () => {
    expect(currentStreak([], '2026-08-09')).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    const days = ['2026-08-09', '2026-08-08', '2026-08-07']
    expect(currentStreak(days, '2026-08-09')).toBe(3)
  })

  it('still counts when today has no photo yet but yesterday does', () => {
    // Today is not over. Declaring the streak dead at 9am is how people quit.
    const days = ['2026-08-08', '2026-08-07', '2026-08-06']
    expect(currentStreak(days, '2026-08-09')).toBe(3)
  })

  it('breaks when two days are missed', () => {
    const days = ['2026-08-07', '2026-08-06']
    expect(currentStreak(days, '2026-08-09')).toBe(0)
  })

  it('stops at the first gap rather than counting everything', () => {
    const days = ['2026-08-09', '2026-08-08', '2026-08-05', '2026-08-04']
    expect(currentStreak(days, '2026-08-09')).toBe(2)
  })

  it('is unaffected by duplicate or unordered input', () => {
    const days = ['2026-08-08', '2026-08-09', '2026-08-09', '2026-08-07']
    expect(currentStreak(days, '2026-08-09')).toBe(3)
  })

  it('spans a month boundary', () => {
    const days = ['2026-09-01', '2026-08-31', '2026-08-30']
    expect(currentStreak(days, '2026-09-01')).toBe(3)
  })
})

describe('formatDayLabel', () => {
  it('names the two days a user actually thinks about', () => {
    expect(formatDayLabel('2026-08-09', '2026-08-09')).toBe('Today')
    expect(formatDayLabel('2026-08-08', '2026-08-09')).toBe('Yesterday')
  })

  it('falls back to a real date further back', () => {
    const label = formatDayLabel('2026-08-01', '2026-08-09')
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    expect(label.length).toBeGreaterThan(3)
  })
})
