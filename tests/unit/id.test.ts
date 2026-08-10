import { describe, expect, it } from 'vitest'
import { isPhotoId, newPhotoId } from '../../src/core/id.ts'

describe('newPhotoId', () => {
  it('sorts lexicographically in capture order', () => {
    // IndexedDB's natural key order is then already the timeline order.
    const early = newPhotoId(Date.parse('2026-01-01T00:00:00Z'))
    const mid = newPhotoId(Date.parse('2026-08-09T12:00:00Z'))
    const late = newPhotoId(Date.parse('2030-12-31T23:59:59Z'))
    expect([late, early, mid].sort()).toEqual([early, mid, late])
  })

  it('does not collide across many ids at the same timestamp', () => {
    const at = Date.now()
    const ids = new Set(Array.from({ length: 5000 }, () => newPhotoId(at)))
    expect(ids.size).toBe(5000)
  })

  it('produces a fixed-width id, which is what keeps the ordering true', () => {
    const short = newPhotoId(0)
    const long = newPhotoId(Date.parse('2099-01-01T00:00:00Z'))
    expect(short).toHaveLength(long.length)
    expect(short < long).toBe(true)
  })

  it('clamps a negative timestamp instead of emitting a malformed id', () => {
    expect(isPhotoId(newPhotoId(-5000))).toBe(true)
  })
})

describe('isPhotoId', () => {
  it('accepts generated ids and rejects anything else', () => {
    expect(isPhotoId(newPhotoId())).toBe(true)
    expect(isPhotoId('')).toBe(false)
    expect(isPhotoId('../../etc/passwd')).toBe(false)
    expect(isPhotoId('ABCDEF')).toBe(false)
    expect(isPhotoId(12345)).toBe(false)
    expect(isPhotoId(null)).toBe(false)
  })
})
