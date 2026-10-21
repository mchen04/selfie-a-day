import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createCountdown } from './countdown.ts'
import type { TimerSeconds } from './preferences.ts'

export function useCountdown(albumId: string, live: boolean, onCancel: () => void) {
  const [clock] = useState(createCountdown)
  const remaining = useSyncExternalStore(clock.subscribe, clock.getSnapshot)
  const cancel = useCallback(() => {
    clock.cancel()
    onCancel()
  }, [clock, onCancel])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', cancel)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', cancel)
      cancel()
    }
  }, [albumId, live, cancel])

  const press = useCallback((seconds: TimerSeconds, fire: () => void) => {
    if (!live || document.visibilityState === 'hidden') return
    if (clock.getSnapshot() !== null) {
      cancel()
      return
    }
    clock.press(seconds, () => {
      if (document.visibilityState !== 'hidden') fire()
    })
  }, [clock, live, cancel])

  return { remaining, press, cancel }
}
