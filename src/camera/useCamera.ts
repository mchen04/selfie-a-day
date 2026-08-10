import { useCallback, useEffect, useRef, useState } from 'react'
import { FRAME_ASPECT } from '../core/geometry.ts'
import { detectCaptureCapabilities, type CaptureCapabilities } from './support.ts'

export type CameraState =
  | 'idle'
  | 'starting'
  | 'live'
  /** Capture was interrupted by the OS; a tap is needed to bring it back. */
  | 'interrupted'
  /** Restarting now would trigger a fresh permission prompt. Wait for a tap. */
  | 'needs-gesture'
  | 'denied'
  | 'no-camera'
  | 'insecure'
  | 'unsupported'
  | 'error'

export interface CameraHandle {
  state: CameraState
  /** Human-readable explanation, present whenever the state is not `live`. */
  message: string | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  capabilities: CaptureCapabilities
  /**
   * Acquire the stream. Prefer calling this from a user gesture: WebKit skips
   * its re-prompt check entirely when a gesture is in scope.
   */
  start: () => Promise<void>
  stop: () => void
}

/**
 * WebKit re-prompts for camera permission when `getUserMedia` is called without
 * a user gesture and capture has been inactive for longer than this. The value
 * is one minute on iOS (ten on desktop) — see
 * `inactiveMediaCaptureStreamRepromptIntervalForiOS` in WebKit's
 * WebPreferencesDefaultValues.cpp. Calling inside a gesture skips the check
 * entirely, so past this window we wait for a tap rather than spending one of
 * the user's permission prompts on a background resume.
 *
 * 50s, not 60s, ON PURPOSE: the limit is WebKit's, the margin is ours. Timers
 * and the round trip through getUserMedia are not free, and landing exactly on
 * the boundary is the one outcome this constant exists to avoid. Raising it to
 * 60_000 looks like a correction and reintroduces the re-prompt.
 */
const REPROMPT_WINDOW_MS = 50_000

/** Ask for a portrait-ish frame at least as large as we intend to store. */
function constraintsFor(longEdge: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: Math.round(longEdge * FRAME_ASPECT) },
      height: { ideal: longEdge },
      // Anything wider is cropped away by the frame; asking for it wastes
      // bandwidth and battery on phones that would happily hand over 4K.
      aspectRatio: { ideal: FRAME_ASPECT },
    },
  }
}

function describeError(err: unknown): { state: CameraState; message: string } {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        state: 'denied',
        message: 'Camera access was blocked. Allow the camera for this site, then try again.',
      }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { state: 'no-camera', message: 'No camera was found on this device.' }
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        state: 'error',
        message: 'The camera is in use by another app. Close it and try again.',
      }
    case 'OverconstrainedError':
      return { state: 'error', message: 'This camera cannot provide a usable picture size.' }
    case 'SecurityError':
      return { state: 'insecure', message: 'Live camera needs a secure (https) connection.' }
    default:
      return {
        state: 'error',
        message: err instanceof Error && err.message ? err.message : 'The camera could not be started.',
      }
  }
}

/** A stream is only usable when a track is live *and* not muted by the OS. */
function isUsable(stream: MediaStream | null): boolean {
  return Boolean(stream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted))
}

/**
 * Owns the MediaStream for the whole app.
 *
 * Three behaviours here exist because of documented iOS behaviour rather than
 * defensive guesswork:
 *
 *  - Interruption shows up as `track.muted`, not `ended`, and `readyState`
 *    stays `"live"` throughout. Checking readyState alone would leave a frozen
 *    picture on screen that still claims to be running.
 *  - Resuming after more than a minute of inactivity re-prompts unless the call
 *    happens inside a user gesture, so past that window we surface a
 *    tap-to-resume state instead of burning a permission prompt.
 *  - Nothing is assumed about permission persisting: iOS home-screen web apps
 *    are isolated from Safari and do not inherit its grants, so a prompt on
 *    every cold start is the expected path, not an error.
 */
export function useCamera(longEdge: number): CameraHandle {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startTokenRef = useRef(0)
  /** When capture stopped being active; drives the re-prompt window. */
  const inactiveSinceRef = useRef<number | null>(null)

  const [capabilities] = useState<CaptureCapabilities>(() => detectCaptureCapabilities())
  const [state, setState] = useState<CameraState>(() =>
    capabilities.path === 'stream' ? 'idle' : capabilities.secureContext ? 'unsupported' : 'insecure',
  )
  const [message, setMessage] = useState<string | null>(capabilities.fallbackReason)

  const releaseStream = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      inactiveSinceRef.current = Date.now()
    }
  }, [])

  const stop = useCallback(() => {
    startTokenRef.current++
    releaseStream()
    const video = videoRef.current
    if (video) video.srcObject = null
    setState((prev) => (prev === 'live' || prev === 'starting' ? 'idle' : prev))
  }, [releaseStream])

  const start = useCallback(
    async () => {
      if (capabilities.path !== 'stream') return

      const token = ++startTokenRef.current
      setState('starting')
      setMessage(null)

      // Release any previous stream first: iOS hands back the same ended track
      // rather than a fresh one if the old one is still attached.
      releaseStream()

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraintsFor(longEdge))
        if (token !== startTokenRef.current) {
          for (const track of stream.getTracks()) track.stop()
          return
        }

        streamRef.current = stream
        const video = videoRef.current
        if (!video) {
          setState('error')
          setMessage('The preview surface is not ready.')
          return
        }

        video.srcObject = stream
        video.setAttribute('playsinline', '')
        video.muted = true
        try {
          await video.play()
        } catch {
          // Autoplay can be refused until a gesture; the stream is still live
          // and the first tap starts it. Not worth failing the whole start for.
        }

        for (const track of stream.getVideoTracks()) {
          const onEnded = () => {
            if (token !== startTokenRef.current) return
            inactiveSinceRef.current = Date.now()
            setState('idle')
          }
          const onMute = () => {
            if (token !== startTokenRef.current) return
            inactiveSinceRef.current = Date.now()
            setState('interrupted')
          }
          const onUnmute = () => {
            if (token !== startTokenRef.current) return
            inactiveSinceRef.current = null
            setState('live')
          }
          track.addEventListener('ended', onEnded)
          track.addEventListener('mute', onMute)
          track.addEventListener('unmute', onUnmute)
        }

        inactiveSinceRef.current = null
        setState(isUsable(stream) ? 'live' : 'interrupted')
      } catch (err) {
        if (token !== startTokenRef.current) return
        inactiveSinceRef.current = Date.now()
        const described = describeError(err)
        setState(described.state)
        setMessage(described.message)
      }
    },
    [capabilities.path, longEdge, releaseStream],
  )

  // Recover after the OS tore the stream down while we were backgrounded.
  useEffect(() => {
    if (capabilities.path !== 'stream') return

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (isUsable(streamRef.current)) return

      const inactiveFor = inactiveSinceRef.current ? Date.now() - inactiveSinceRef.current : Infinity
      if (inactiveFor < REPROMPT_WINDOW_MS) {
        void start()
      } else {
        // Past the window an automatic restart would re-prompt. Ask for a tap.
        setState((prev) =>
          prev === 'denied' || prev === 'no-camera' || prev === 'insecure' ? prev : 'needs-gesture',
        )
      }
    }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
    }
  }, [capabilities.path, start])

  useEffect(() => stop, [stop])

  return { state, message, videoRef, capabilities, start, stop }
}
