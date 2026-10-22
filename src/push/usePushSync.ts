import { useEffect } from 'react'
import { resyncDevice } from './client.ts'

export function usePushSync(userId: string | undefined): void {
  useEffect(() => {
    if (!userId) return
    const sync = () => { if (!document.hidden) void resyncDevice(userId).catch(() => undefined) }
    sync()
    window.addEventListener('online', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('online', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [userId])
}
