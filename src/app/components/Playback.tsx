import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDayLabel } from '../../core/day.ts'
import type { PhotoMeta } from '../../core/types.ts'
import { getMaster } from '../../storage/photos.ts'
import { IconClose } from './Icons.tsx'

const SPEEDS = [
  { label: 'Slow', fps: 3 },
  { label: 'Normal', fps: 6 },
  { label: 'Fast', fps: 12 },
] as const

/**
 * How many frames ahead to decode. Enough to stay smooth, small enough that a
 * ten-year timeline never has more than a handful of images in memory.
 */
const PREFETCH = 6

/**
 * Plays the timeline back as a timelapse.
 *
 * This is the payoff the daily habit is for, and the one place the alignment
 * work becomes visible: if the ghost overlay did its job, the face stays put
 * and only time moves.
 *
 * Frames are decoded in a rolling window rather than up front. Loading a whole
 * timeline into memory is the specific failure users of the native apps report
 * — "once I added around 900 photos the preview only shows a blank screen" —
 * and it is entirely avoidable.
 */
export function Playback({ photos, onClose }: { photos: readonly PhotoMeta[]; onClose: () => void }) {
  // Oldest first: a timelapse runs forwards.
  const ordered = useMemo(() => [...photos].reverse(), [photos])

  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [fps, setFps] = useState<number>(6)
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)

  /** id -> object URL for the frames currently decoded. Never read in render. */
  const cacheRef = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    // Named `ahead`, not `window` — shadowing the global inside an async effect
    // is exactly how a later edit reaches for `window.setTimeout` and gets an
    // array instead.
    const ahead = ordered.slice(index, index + PREFETCH)
    const keep = new Set(ahead.map((p) => p.id))
    const previous = ordered[index - 1]
    if (previous) keep.add(previous.id) // scrubbing backwards one step is free

    void (async () => {
      for (const [offset, photo] of ahead.entries()) {
        if (cancelled) return
        let url = cacheRef.current.get(photo.id)
        if (!url) {
          const stored = await getMaster(photo.id)
          if (cancelled) return
          if (!stored) continue
          url = URL.createObjectURL(new Blob([stored.bytes], { type: stored.mime }))
          cacheRef.current.set(photo.id, url)
        }
        if (offset === 0) setCurrentUrl(url)
      }

      if (cancelled) return
      for (const [id, url] of cacheRef.current) {
        if (!keep.has(id)) {
          URL.revokeObjectURL(url)
          cacheRef.current.delete(id)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [index, ordered])

  // Release every decoded frame on the way out. A playback session that leaked
  // its frames would be the largest memory leak in the app.
  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  useEffect(() => {
    if (!playing || ordered.length < 2) return
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i + 1 >= ordered.length) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, 1000 / fps)
    return () => clearInterval(timer)
  }, [playing, fps, ordered.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((p) => !p)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = ordered[index]
  const atEnd = index >= ordered.length - 1

  return (
    <div className="playback" data-testid="playback">
      <header className="topbar">
        <div className="topbar__title">
          {current ? formatDayLabel(current.dayKey) : 'Timelapse'}
          <span className="topbar__sub" data-testid="playback-position">
            {index + 1} of {ordered.length}
          </span>
        </div>
        <button
          type="button"
          className="iconbtn"
          onClick={onClose}
          aria-label="Close timelapse"
          data-testid="playback-close"
        >
          <IconClose />
        </button>
      </header>

      <div className="playback__stage">
        <div className="frame frame--static">
          {currentUrl ? (
            <img className="frame__still" src={currentUrl} alt="" data-testid="playback-frame" />
          ) : (
            <div className="frame__overlay frame__overlay--quiet">
              <span className="spinner" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>

      <div className="playback__controls">
        <input
          type="range"
          min={0}
          max={Math.max(0, ordered.length - 1)}
          value={index}
          onChange={(event) => {
            setPlaying(false)
            setIndex(Number(event.target.value))
          }}
          aria-label="Scrub through the timelapse"
          data-testid="playback-scrub"
        />

        <div className="playback__row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              if (atEnd) {
                setIndex(0)
                setPlaying(true)
              } else {
                setPlaying((p) => !p)
              }
            }}
            data-testid="playback-toggle"
          >
            {atEnd ? 'Play again' : playing ? 'Pause' : 'Play'}
          </button>

          <div className="segmented segmented--compact" role="group" aria-label="Playback speed">
            {SPEEDS.map((speed) => (
              <button
                key={speed.label}
                type="button"
                className="segmented__item"
                data-active={fps === speed.fps}
                aria-pressed={fps === speed.fps}
                onClick={() => setFps(speed.fps)}
              >
                {speed.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
