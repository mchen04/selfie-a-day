import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

export interface ServiceWorkerState {
  updateReady: boolean
  applyUpdate: () => void
}

/**
 * Service-worker lifecycle, surfaced rather than automatic.
 *
 * The update is never applied on its own. Reloading the page out from under
 * someone who is mid-capture would, at best, waste the photo they were lining
 * up; the new version waits until they say so.
 *
 * The worker only caches the app shell.
 */
export function useServiceWorker(): ServiceWorkerState {
  const [updateReady, setUpdateReady] = useState(false)
  const applyRef = useRef<((reload: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    if (import.meta.env.DEV) return
    applyRef.current = registerSW({
      immediate: true,
      onNeedRefresh: () => setUpdateReady(true),
    })
  }, [])

  const applyUpdate = useCallback(() => {
    void applyRef.current?.(true)
  }, [])

  return { updateReady, applyUpdate }
}
