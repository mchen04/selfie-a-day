import type { TimerSeconds } from './preferences.ts'

export function createCountdown() {
  let remaining: number | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()

  const emit = () => listeners.forEach((listener) => listener())
  const cancel = () => {
    if (interval !== null) clearInterval(interval)
    interval = null
    if (remaining === null) return
    remaining = null
    emit()
  }

  return {
    getSnapshot: () => remaining,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    cancel,
    press: (seconds: TimerSeconds, fire: () => void) => {
      if (remaining !== null) {
        cancel()
        return
      }
      if (seconds === 0) {
        fire()
        return
      }
      remaining = seconds
      interval = setInterval(() => {
        if (remaining === null) return
        if (remaining <= 1) {
          cancel()
          fire()
        } else {
          remaining -= 1
          emit()
        }
      }, 1000)
      emit()
    },
  }
}
