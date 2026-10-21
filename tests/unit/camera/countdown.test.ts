import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCountdown } from '../../../src/camera/countdown.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('countdown state machine', () => {
  it('fires immediately with Off and creates no timer', () => {
    const clock = createCountdown()
    const fire = vi.fn()
    clock.press(0, fire)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(clock.getSnapshot()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([3, 5, 10] as const)('ticks once per second and fires exactly once at zero for %ss', (seconds) => {
    const clock = createCountdown()
    const fire = vi.fn()
    const ticks: Array<number | null> = []
    const unsubscribe = clock.subscribe(() => ticks.push(clock.getSnapshot()))
    clock.press(seconds, fire)
    vi.advanceTimersByTime(999)
    expect(clock.getSnapshot()).toBe(seconds)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(seconds * 1000 - 999)
    expect(ticks).toEqual([...Array.from({ length: seconds }, (_, index) => seconds - index), null])
    expect(fire).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
  })

  it('a second press cancels instead of starting a second capture', () => {
    const clock = createCountdown()
    const fire = vi.fn()
    clock.press(3, fire)
    vi.advanceTimersByTime(2000)
    clock.press(3, fire)
    vi.advanceTimersByTime(60_000)
    expect(fire).not.toHaveBeenCalled()
    expect(clock.getSnapshot()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel just before zero prevents capture and permits a fresh countdown', () => {
    const clock = createCountdown()
    const fire = vi.fn()
    clock.press(3, fire)
    vi.advanceTimersByTime(2999)
    clock.cancel()
    clock.cancel()
    vi.advanceTimersByTime(1)
    expect(fire).not.toHaveBeenCalled()
    clock.press(5, fire)
    vi.advanceTimersByTime(5000)
    expect(fire).toHaveBeenCalledTimes(1)
  })
})
