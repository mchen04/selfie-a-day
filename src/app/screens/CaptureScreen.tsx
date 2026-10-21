import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { captureFromFile, captureFromVideo, type CaptureResult } from '../../camera/capture.ts'
import { useCamera, type CameraState } from '../../camera/useCamera.ts'
import { createCaptureFlash, videoTrack } from '../../camera/flash.ts'
import {
  cycleTimer,
  rememberFlash,
  rememberTimer,
  timerSeconds,
  type TimerSeconds,
} from '../../camera/preferences.ts'
import { useCameraPreferences } from '../../camera/useCameraPreferences.ts'
import { useCountdown } from '../../camera/useCountdown.ts'
import { currentStreak, formatDayLabel } from '../../core/day.ts'
import {
  IconAlert,
  IconCamera,
  IconChevronDown,
  IconSettings,
  IconTimeline,
} from '../components/Icons.tsx'
import { Advice } from '../components/Advice.tsx'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { chooseAdvice, type AdviceKind } from '../advice.ts'
import { CaptureFrame } from '../components/CaptureFrame.tsx'
import { CameraControls } from '../components/camera/CameraControls.tsx'
import { GhostControls } from '../components/GhostControls.tsx'
import { Toast } from '../components/Toast.tsx'
import { useToast } from '../useToast.ts'
import { useNavigate } from '../router.ts'
import { useApp } from '../store-context.ts'
import { useStoredImage } from '../useStoredImage.ts'
import { useCurrentDay } from '../useCurrentDay.ts'

/** States where a tap should (re)start the camera rather than take a photo. */
const NEEDS_START: ReadonlySet<CameraState> = new Set<CameraState>([
  'idle',
  'interrupted',
  'needs-gesture',
  'denied',
  'error',
])

export function CaptureScreen() {
  const { metas, allMetas, albums, activeAlbum, settings, storageError, actions } = useApp()
  const navigate = useNavigate()
  const { toast, show } = useToast()

  const camera = useCamera(settings.captureLongEdge)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState(false)
  const [exposure] = useState(createCaptureFlash)
  const screenFlash = useSyncExternalStore(exposure.subscribe, exposure.getSnapshot)
  const [choosingAlbum, setChoosingAlbum] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<AdviceKind>>(() => new Set())

  const latest = metas[0] ?? null
  const preferences = useCameraPreferences(activeAlbum.id, latest)
  const countdown = useCountdown(activeAlbum.id, camera.state === 'live', exposure.cancel)
  const { today, timeZone: albumTimeZone } = useCurrentDay(activeAlbum.timeZone)
  const todayDone = metas.some((meta) => meta.dayKey === today)
  const streak = currentStreak(
    metas.map((m) => m.dayKey),
    today,
  )

  const ghost = useStoredImage(latest?.id, 'master', settings.ghostEnabled)
  const ghostFlipped = latest ? latest.mirrored !== settings.mirrorPreview : false

  /**
   * The space every new photo is stored in.
   *
   * It follows the library, not the Mirror setting. Mirroring the preview is a
   * *viewing* preference; letting it change the stored space means toggling it
   * mid-project leaves a library in two spaces and a timelapse that flips
   * left-to-right at the boundary — the failure this app exists to prevent,
   * quoted from a real review in docs/research.md.
   *
   * Alignment is unaffected: the ghost is rendered into whatever space the
   * preview is in, so the user still lines up against what they see, and the
   * capture is still exactly that framing — just possibly its mirror image,
   * which is a flip of the same content rather than a different photo.
   */
  const storageMirrored = latest ? latest.mirrored : settings.mirrorPreview

  const usingFileFallback = camera.capabilities.path === 'file'
  const needsStart = !usingFileFallback && NEEDS_START.has(camera.state)

  useEffect(() => {
    if (!feedback) return
    const timeout = setTimeout(() => setFeedback(false), 220)
    return () => clearTimeout(timeout)
  }, [feedback])

  // First mount only. Later resumes are handled inside useCamera, which decides
  // between an automatic restart and asking for a tap.
  useEffect(() => {
    if (!usingFileFallback && camera.state === 'idle') void camera.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingFileFallback])

  const persist = useCallback(
    async (result: CaptureResult) => {
      await actions.savePhoto(result)
      rememberTimer(activeAlbum.id, timerSeconds(result.timerSeconds), result.meta.capturedAt)
      const nextStreak = currentStreak([result.meta.dayKey, ...metas.map((m) => m.dayKey)], today)
      show(
        nextStreak > 1
          ? `Saved to ${activeAlbum.name} — ${nextStreak} days in a row`
          : `Saved to ${activeAlbum.name}`,
        'success',
      )
    },
    [actions, activeAlbum.id, activeAlbum.name, metas, show, today],
  )

  const takePhoto = useCallback(async (seconds: TimerSeconds) => {
    if (busyRef.current || document.visibilityState === 'hidden') return
    const video = camera.videoRef.current
    if (!video || camera.state !== 'live') {
      show('The camera is not ready yet.', 'error')
      return
    }

    busyRef.current = true
    setBusy(true)
    try {
      const result = await exposure.capture(
        videoTrack(video),
        preferences.flash === 'on',
        true,
        () => {
          setFeedback(true)
          return captureFromVideo(video, {
            longEdge: settings.captureLongEdge,
            mirrored: storageMirrored,
            albumId: activeAlbum.id,
            timeZone: albumTimeZone,
            now: Date.now(),
            timerSeconds: seconds,
          })
        },
        () => show('Flash is unavailable. Your photo still saves.'),
      )
      if (result) await persist(result)
    } catch (err) {
      show(err instanceof Error ? err.message : 'The photo could not be saved.', 'error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [
    camera,
    activeAlbum.id,
    albumTimeZone,
    exposure,
    preferences.flash,
    persist,
    settings.captureLongEdge,
    storageMirrored,
    show,
  ])

  const capture = useCallback(() => {
    if (countdown.remaining !== null) {
      countdown.cancel()
      return
    }
    if (busyRef.current) return
    if (usingFileFallback) {
      fileInputRef.current?.click()
      return
    }
    if (needsStart) {
      void camera.start()
      return
    }
    if (camera.state !== 'live') {
      show('The camera is not ready yet.', 'error')
      return
    }
    countdown.press(preferences.seconds, () => void takePhoto(preferences.seconds))
  }, [camera, countdown, needsStart, preferences.seconds, show, takePhoto, usingFileFallback])

  const onFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Reset immediately so picking the same file twice still fires a change.
      event.target.value = ''
      if (!file) return
      if (busyRef.current) return

      const capturedAt = Date.now()
      busyRef.current = true
      setBusy(true)
      try {
        // Store in the same space as a live capture. A library that mixes
        // mirrored and un-mirrored photos plays back flipping left to right,
        // which is precisely the "head jumping around" this app exists to stop.
        const result = await captureFromFile(file, {
          longEdge: settings.captureLongEdge,
          mirrored: storageMirrored,
          albumId: activeAlbum.id,
          timeZone: albumTimeZone,
          now: capturedAt,
          timerSeconds: 0,
        })
        await persist(result)
      } catch (err) {
        show(err instanceof Error ? err.message : 'That photo could not be used.', 'error')
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [activeAlbum.id, albumTimeZone, persist, settings.captureLongEdge, storageMirrored, show],
  )

  // The web has no volume-button shutter — the ergonomic trick users of the
  // native apps ask for most. Space and Enter are the desktop equivalent, and
  // the whole frame is tappable on touch.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' && event.key !== 'Enter') return
      if (event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(target.tagName)) return
      event.preventDefault()
      capture()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capture])

  const advice = chooseAdvice({ metas: allMetas, settings, dismissed })

  const progress =
    streak > 0
      ? `${streak} day${streak === 1 ? '' : 's'} in a row`
      : metas.length > 0
        ? `${metas.length} photo${metas.length === 1 ? '' : 's'} so far`
        : 'Day one'

  const shutterLabel =
    countdown.remaining !== null
      ? 'Cancel timer'
      : usingFileFallback
        ? "Take today's photo with the camera app"
        : needsStart
          ? 'Start the camera'
          : todayDone
            ? "Retake today's photo"
            : "Take today's photo"

  return (
    <div className="screen capture" data-testid="capture-screen">
      <header className="topbar">
        <button
          type="button"
          className="topbar__title topbar__album"
          onClick={() => {
            countdown.cancel()
            setChoosingAlbum(true)
          }}
          aria-label={`Choose album. ${activeAlbum.name} selected`}
          data-testid="active-album-picker"
        >
          <span className="topbar__album-line">
            {activeAlbum.name} <IconChevronDown size={16} />
          </span>
          <span className="topbar__sub">
            <span data-testid="today-status">{todayDone ? 'Today saved' : 'Today'}</span>
            {' · '}
            <span data-testid="streak-label">{progress}</span>
          </span>
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={() => {
            countdown.cancel()
            navigate({ name: 'timeline' })
          }}
          aria-label="Timeline"
          data-testid="nav-timeline"
        >
          <IconTimeline />
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={() => {
            countdown.cancel()
            navigate({ name: 'settings' })
          }}
          aria-label="Settings"
          data-testid="nav-settings"
        >
          <IconSettings />
        </button>
      </header>

      <div className="capture__stage">
        <CaptureFrame
          videoRef={camera.videoRef}
          mirrored={settings.mirrorPreview}
          gridStyle={settings.gridStyle}
          ghostUrl={settings.ghostEnabled ? ghost.url : null}
          ghostOpacity={settings.ghostOpacity}
          ghostFlipped={ghostFlipped}
          onTap={capture}
          tapLabel={shutterLabel}
        >
          {feedback ? <div className="frame__flash" aria-hidden="true" /> : null}

          <CameraControls
            seconds={preferences.seconds}
            flash={preferences.flash}
            counting={countdown.remaining !== null}
            busy={busy}
            available={!usingFileFallback && camera.state === 'live'}
            onTimer={() => rememberTimer(activeAlbum.id, cycleTimer(preferences.seconds))}
            onFlash={() => rememberFlash(preferences.flash === 'on' ? 'off' : 'on')}
          />

          <div className="camera-countdown" role="status" aria-live="polite" aria-atomic="true">
            {countdown.remaining !== null ? (
              <span data-testid="countdown" data-seconds={countdown.remaining} aria-label={`${countdown.remaining}`}>
                {countdown.remaining}
              </span>
            ) : null}
          </div>

          <CameraStatus
            state={camera.state}
            message={camera.message}
            usingFileFallback={usingFileFallback}
            fallbackReason={camera.capabilities.fallbackReason}
            onRetry={() => void camera.start()}
            onUseLibrary={() => fileInputRef.current?.click()}
          />

          {latest && settings.ghostEnabled && camera.state === 'live' ? (
            <p className="frame__hint" data-testid="ghost-hint">
              {todayDone
                ? "Lined up with today's photo"
                : `Line your eyes up with ${formatDayLabel(latest.dayKey).toLowerCase()}`}
            </p>
          ) : null}
        </CaptureFrame>
      </div>

      {storageError ? (
        <div className="banner banner--error" role="alert" data-testid="storage-error">
          <IconAlert size={18} />
          <span>{storageError}</span>
        </div>
      ) : null}

      <Advice
        kind={advice}
        photoCount={allMetas.length}
        onBackup={() => navigate({ name: 'settings' })}
        onDismiss={(kind) => setDismissed((prev) => new Set(prev).add(kind))}
      />

      <div className="capture__controls">
        <GhostControls
          settings={settings}
          hasGhost={Boolean(latest)}
          onChange={(patch) => void actions.updateSettings(patch)}
        />

        <div className="capture__actions">
          <span className="capture__slot capture__slot--left">
            {todayDone ? <span className="pill pill--done">Retake</span> : null}
          </span>

          <button
            type="button"
            className="shutter"
            onClick={capture}
            disabled={busy}
            aria-label={shutterLabel}
            data-testid="shutter"
            data-busy={busy}
            data-mode={usingFileFallback ? 'file' : needsStart ? 'start' : 'capture'}
            data-counting={countdown.remaining !== null}
          >
            <span className="shutter__ring" />
            <span className="shutter__core">
              {countdown.remaining !== null ? <span className="shutter__cancel" aria-hidden="true" /> : null}
              {usingFileFallback || needsStart ? <IconCamera size={26} /> : null}
            </span>
          </button>

          <span className="capture__slot capture__slot--right" />
        </div>
      </div>

      {/*
        The fallback capture path. `capture="user"` asks iOS for the front
        camera directly; on browsers that ignore it the user still gets a
        picker, which is a working path rather than a dead end.
      */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="user"
        className="visually-hidden"
        onChange={(event) => void onFilePicked(event)}
        data-testid="file-fallback-input"
        tabIndex={-1}
        aria-hidden="true"
      />

      <Toast toast={toast} />
      {screenFlash ? <div className="camera-screen-flash" data-testid="screen-flash" aria-hidden="true" /> : null}

      {choosingAlbum ? (
        <AlbumPicker
          albums={albums}
          photos={allMetas}
          activeAlbumId={activeAlbum.id}
          onSelect={actions.selectAlbum}
          onCreate={async (name) => {
            await actions.createAlbum(name)
          }}
          onClose={() => setChoosingAlbum(false)}
        />
      ) : null}
    </div>
  )
}

function CameraStatus({
  state,
  message,
  usingFileFallback,
  fallbackReason,
  onRetry,
  onUseLibrary,
}: {
  state: CameraState
  message: string | null
  usingFileFallback: boolean
  fallbackReason: string | null
  onRetry: () => void
  onUseLibrary: () => void
}) {
  if (usingFileFallback) {
    return (
      <div className="frame__overlay" data-testid="camera-status" data-state="fallback">
        <IconCamera size={30} />
        <p className="frame__overlay-title">Camera roll mode</p>
        <p className="frame__overlay-body">
          {fallbackReason ?? 'This browser cannot show a live preview.'} Tap the shutter to take
          today&apos;s photo with your phone&apos;s camera instead.
        </p>
      </div>
    )
  }

  if (state === 'live') return null

  if (state === 'starting') {
    return (
      <div className="frame__overlay frame__overlay--quiet" data-testid="camera-status" data-state={state}>
        <span className="spinner" aria-hidden="true" />
        <p className="frame__overlay-body">Starting camera…</p>
      </div>
    )
  }

  // Interrupted and needs-gesture are normal, recoverable states on iOS: the
  // OS pauses capture when the app is backgrounded. Present them as a tap, not
  // as an error, because that is what they are.
  if (state === 'interrupted' || state === 'needs-gesture' || state === 'idle') {
    return (
      <div className="frame__overlay frame__overlay--quiet" data-testid="camera-status" data-state={state}>
        <IconCamera size={28} />
        <p className="frame__overlay-title">Tap to start the camera</p>
        <p className="frame__overlay-body">
          {state === 'idle'
            ? 'The camera is off.'
            : 'Your phone paused the camera while the app was in the background.'}
        </p>
      </div>
    )
  }

  const title =
    state === 'denied'
      ? 'Camera access is off'
      : state === 'no-camera'
        ? 'No camera found'
        : state === 'insecure'
          ? 'Needs a secure connection'
          : 'Camera unavailable'

  return (
    <div className="frame__overlay" data-testid="camera-status" data-state={state}>
      <IconAlert size={28} />
      <p className="frame__overlay-title">{title}</p>
      <p className="frame__overlay-body">{message}</p>
      <div className="frame__overlay-actions">
        <button type="button" className="btn" onClick={onRetry} data-testid="camera-retry">
          Try again
        </button>
        <button type="button" className="btn" onClick={onUseLibrary} data-testid="camera-use-library">
          Use a photo instead
        </button>
      </div>
      <p className="tiny muted frame__overlay-foot">Your photos stay on this device either way.</p>
    </div>
  )
}
