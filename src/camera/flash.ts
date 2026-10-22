export const FLASH_SETTLE_MS = 150
export type FlashMethod = 'torch' | 'screen' | null

export function flashMethod(track: MediaStreamTrack | null, screenAvailable: boolean): FlashMethod {
  try {
    const capabilities = track?.getCapabilities() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
    if (capabilities?.torch && typeof track?.applyConstraints === 'function') return 'torch'
  } catch {
    return screenAvailable ? 'screen' : null
  }
  return screenAvailable ? 'screen' : null
}

export function videoTrack(video: HTMLVideoElement | null): MediaStreamTrack | null {
  const stream = video?.srcObject
  return stream && 'getVideoTracks' in stream ? stream.getVideoTracks()[0] ?? null : null
}

function torch(track: MediaStreamTrack, enabled: boolean): Promise<void> {
  const constraint = { torch: enabled } as MediaTrackConstraintSet
  return track.applyConstraints({ advanced: [constraint] })
}

interface Exposure {
  cancelled: boolean
  track: MediaStreamTrack | null
  torchAttempted: boolean
  timeout: ReturnType<typeof setTimeout> | null
  release: (() => void) | null
  warn: () => void
}

export function createCaptureFlash() {
  let active: Exposure | null = null
  let screen = false
  const listeners = new Set<() => void>()
  const setScreen = (value: boolean) => {
    if (screen === value) return
    screen = value
    listeners.forEach((listener) => listener())
  }
  const turnOff = async (exposure: Exposure) => {
    if (!exposure.torchAttempted || !exposure.track) return
    try {
      await torch(exposure.track, false)
    } catch {
      if (!exposure.cancelled) exposure.warn()
    }
  }
  const settle = (exposure: Exposure) => new Promise<void>((resolve) => {
    exposure.release = resolve
    exposure.timeout = setTimeout(() => {
      exposure.timeout = null
      exposure.release = null
      resolve()
    }, FLASH_SETTLE_MS)
  })

  return {
    getSnapshot: () => screen,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    cancel: () => {
      if (!active) return
      active.cancelled = true
      if (active.timeout !== null) clearTimeout(active.timeout)
      active.timeout = null
      active.release?.()
      active.release = null
      setScreen(false)
      void turnOff(active)
    },
    async capture<T>(
      track: MediaStreamTrack | null,
      enabled: boolean,
      screenAvailable: boolean,
      takePhoto: () => Promise<T>,
      onUnavailable: () => void,
    ): Promise<T | undefined> {
      if (active) return undefined
      let warned = false
      const exposure: Exposure = {
        cancelled: false, track, torchAttempted: false, timeout: null, release: null,
        warn: () => {
          if (warned) return
          warned = true
          onUnavailable()
        },
      }
      active = exposure
      let result: T | undefined
      try {
        if (enabled) {
          let method = flashMethod(track, screenAvailable)
          if (method === 'torch' && track) {
            exposure.torchAttempted = true
            try {
              await torch(track, true)
            } catch {
              method = screenAvailable ? 'screen' : null
            }
          }
          if (exposure.cancelled) return undefined
          if (method === 'screen') setScreen(true)
          if (method) await settle(exposure)
          else exposure.warn()
        }
        if (exposure.cancelled) return undefined
        result = await takePhoto()
      } catch (error) {
        if (!exposure.cancelled) throw error
        return undefined
      } finally {
        setScreen(false)
        await turnOff(exposure)
        if (active === exposure) active = null
      }
      return exposure.cancelled ? undefined : result
    },
  }
}
