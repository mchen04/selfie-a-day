import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cycleTimer, parseTimer, readFlash, readPreference, rememberFlash, rememberTimer,
  resolveTimer, subscribePreferences, timerKey, type TimerSeconds,
} from '../../../src/camera/preferences.ts'

beforeEach(() => window.localStorage.clear())

describe('camera preferences', () => {
  it('defaults to Off and cycles Off → 3 → 5 → 10 → Off with one action each', () => {
    expect(resolveTimer(parseTimer(readPreference(timerKey('selfies'))), null)).toBe(0)
    let seconds: TimerSeconds = 0
    const seen: TimerSeconds[] = [seconds]
    for (let index = 0; index < 4; index++) {
      seconds = cycleTimer(seconds)
      seen.push(seconds)
    }
    expect(seen).toEqual([0, 3, 5, 10, 0])
  })

  it('persists separate album choices and reads them in a later session', () => {
    rememberTimer('selfies', 3, 100)
    rememberTimer('holiday', 10, 200)
    expect(window.localStorage.getItem('sad.camera.timer.selfies')).toBe('{"seconds":3,"at":100}')
    expect(parseTimer(readPreference(timerKey('selfies')))).toEqual({ seconds: 3, at: 100 })
    expect(parseTimer(readPreference(timerKey('holiday')))).toEqual({ seconds: 10, at: 200 })
    expect(parseTimer(readPreference(timerKey('new')))).toBeNull()
  })

  it('inherits the latest photo across devices and lets a newer local choice win', () => {
    expect(resolveTimer(null, { capturedAt: 200, timerSeconds: 5 })).toBe(5)
    expect(resolveTimer({ seconds: 3, at: 100 }, { capturedAt: 200, timerSeconds: 10 })).toBe(10)
    expect(resolveTimer({ seconds: 5, at: 300 }, { capturedAt: 200, timerSeconds: 10 })).toBe(5)
  })

  it('the latest untimed photo disables the timer, including legacy photos', () => {
    expect(resolveTimer({ seconds: 10, at: 100 }, { capturedAt: 200, timerSeconds: 0 })).toBe(0)
    expect(resolveTimer({ seconds: 10, at: 100 }, { capturedAt: 200 })).toBe(0)
  })

  it('preserves a local choice made at the latest photo timestamp', () => {
    expect(resolveTimer({ seconds: 5, at: 200 }, { capturedAt: 200, timerSeconds: 3 })).toBe(5)
  })

  it.each(['bad', 'null', '[]', '{}', '{"seconds":4,"at":1}', '{"seconds":"3","at":1}', '{"seconds":3,"at":-1}', '{"seconds":3,"at":1e999}'])('rejects corrupt timer preference %s', (value) => {
    expect(parseTimer(value)).toBeNull()
    expect(resolveTimer(parseTimer(value), null)).toBe(0)
  })

  it('rejects invalid inherited seconds and timestamps', () => {
    expect(resolveTimer(null, { capturedAt: 1, timerSeconds: 7 })).toBe(0)
    expect(resolveTimer({ seconds: 5, at: 1 }, { capturedAt: NaN, timerSeconds: 10 })).toBe(5)
  })

  it('persists flash On/Off and defaults missing or corrupt flash to Off', () => {
    expect(readFlash()).toBe('off')
    rememberFlash('on')
    expect(window.localStorage.getItem('sad.camera.flash')).toBe('on')
    expect(readFlash()).toBe('on')
    rememberFlash('off')
    expect(readFlash()).toBe('off')
    window.localStorage.setItem('sad.camera.flash', 'auto')
    expect(readFlash()).toBe('off')
  })

  it('notifies local and cross-window changes and removes listeners', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePreferences(listener)
    rememberTimer('selfies', 3, 1)
    window.dispatchEvent(new StorageEvent('storage'))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    rememberTimer('selfies', 5, 2)
    window.dispatchEvent(new StorageEvent('storage'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps choices usable when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readPreference(timerKey('blocked'))).toBeNull()
    rememberTimer('blocked', 5, 100)
    expect(parseTimer(readPreference(timerKey('blocked')))).toEqual({ seconds: 5, at: 100 })
  })
})
