import { useEffect, useState } from 'react'
import { dayKeyOf, resolvedTimeZone, type DayKey } from '../core/day.ts'

const DAY_CHECK_INTERVAL_MS = 30_000

interface AlbumClock {
  today: DayKey
  timeZone: string
}

function readClock(override: string | null): AlbumClock {
  const timeZone = override ?? resolvedTimeZone()
  return { today: dayKeyOf(new Date(), timeZone), timeZone }
}

/** Keep midnight and automatic timezone changes honest without requiring a reload. */
export function useCurrentDay(timeZoneOverride: string | null): AlbumClock {
  const [clock, setClock] = useState(() => readClock(timeZoneOverride))

  useEffect(() => {
    const update = () => {
      const next = readClock(timeZoneOverride)
      setClock((previous) =>
        previous.today === next.today && previous.timeZone === next.timeZone ? previous : next,
      )
    }
    update()
    const timer = window.setInterval(update, DAY_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [timeZoneOverride])

  return clock
}
