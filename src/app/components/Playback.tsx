import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dayKeyToDate, formatDayLabel, type DayKey } from '../../core/day.ts'
import {
  filterTimelapsePhotos,
  formatTimelapseDuration,
  orderTimelapsePhotos,
  type TimelapseRange,
  type TimelapseRangePreset,
} from '../../core/timelapse.ts'
import type { PhotoMeta } from '../../core/types.ts'
import { getMaster } from '../../storage/photos.ts'
import {
  makeTimelapseVideo,
  supportsTimelapseExport,
  timelapseFilename,
} from '../timelapse-export.ts'
import { useModalFocus } from '../useModalFocus.ts'
import { useToast } from '../useToast.ts'
import { IconClose, IconExport } from './Icons.tsx'
import { Toast } from './Toast.tsx'

const SPEEDS = [
  { label: 'Slow', fps: 3 },
  { label: 'Normal', fps: 6 },
  { label: 'Fast', fps: 12 },
] as const

const PREFETCH = 6

interface ReadyVideo {
  file: File
  filename: string
  shareable: boolean
}

export function Playback({
  photos,
  albumName,
  onClose,
}: {
  photos: readonly PhotoMeta[]
  albumName: string
  onClose: () => void
}) {
  const [range, setRange] = useState<TimelapseRange>({ preset: 'all' })
  const selected = useMemo(() => filterTimelapsePhotos(photos, range), [photos, range])
  const ordered = useMemo(() => orderTimelapsePhotos(selected), [selected])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(() => !prefersReducedMotion())
  const [fps, setFps] = useState<number>(6)
  const [loop, setLoop] = useState(false)
  const [showDates, setShowDates] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [currentFrame, setCurrentFrame] = useState<{ id: string; url: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [readyVideo, setReadyVideo] = useState<ReadyVideo | null>(null)
  const { toast, show } = useToast()
  const cacheRef = useRef(new Map<string, string>())
  const exportSupported = supportsTimelapseExport()

  useEffect(() => {
    let cancelled = false
    const current = ordered[index]
    if (!current) {
      for (const url of cacheRef.current.values()) URL.revokeObjectURL(url)
      cacheRef.current.clear()
      return
    }

    const ahead = ordered.slice(index, index + PREFETCH)
    const keep = new Set(ahead.map((photo) => photo.id))
    const previous = ordered[index - 1]
    if (previous) keep.add(previous.id)

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
        if (offset === 0) setCurrentFrame({ id: photo.id, url })
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

  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  useEffect(() => {
    if (!playing || ordered.length < 2) return
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current + 1 < ordered.length) return current + 1
        if (loop) return 0
        setPlaying(false)
        return current
      })
    }, 1000 / fps)
    return () => window.clearInterval(timer)
  }, [fps, loop, ordered.length, playing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (optionsOpen) setOptionsOpen(false)
        else onClose()
      }
      if (event.key === ' ' && !optionsOpen) {
        event.preventDefault()
        setPlaying((current) => !current)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose, optionsOpen])

  const makeVideo = useCallback(async () => {
    setPlaying(false)
    setExporting(true)
    setReadyVideo(null)
    try {
      const video = await makeTimelapseVideo({
        photos: selected,
        fps,
        showDates,
        onProgress: (done, total) => setExportProgress(`Rendering ${done}/${total}`),
      })
      const filename = timelapseFilename(albumName, selected, video.extension)
      const file = new File([video.blob], filename, { type: video.blob.type })
      const shareable =
        typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
      setReadyVideo({ file, filename, shareable })
      if (shareable) show('Video ready to share.', 'success')
      else {
        downloadVideo(file, filename)
        show('Timelapse saved.', 'success')
      }
    } catch (error) {
      show(error instanceof Error ? error.message : 'The timelapse could not be exported.', 'error')
    } finally {
      setExporting(false)
      setExportProgress('')
    }
  }, [albumName, fps, selected, show, showDates])

  const saveReadyVideo = useCallback(async () => {
    if (!readyVideo) return
    if (readyVideo.shareable) {
      try {
        await navigator.share({ files: [readyVideo.file], title: `${albumName} timelapse` })
        show('Timelapse shared.', 'success')
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          show('The video could not be shared.', 'error')
        }
      }
      return
    }
    downloadVideo(readyVideo.file, readyVideo.filename)
    show('Timelapse saved.', 'success')
  }, [albumName, readyVideo, show])

  const changeRange = useCallback(
    (next: TimelapseRange) => {
      setRange(next)
      setIndex(0)
      setPlaying(false)
      setReadyVideo(null)
    },
    [],
  )

  const changeShowDates = useCallback((enabled: boolean) => {
    setShowDates(enabled)
    setReadyVideo(null)
  }, [])

  const current = ordered[index]
  const currentUrl = currentFrame && currentFrame.id === current?.id ? currentFrame.url : null
  const atEnd = ordered.length > 0 && index >= ordered.length - 1
  const rangeLabel = labelForRange(range.preset)

  return (
    <div className="playback" data-testid="playback">
      <header className="topbar">
        <div className="topbar__title">
          {albumName}
          <span className="topbar__sub" data-testid="playback-position">
            {current ? `${formatDayLabel(current.dayKey)} · ${index + 1} of ${ordered.length}` : '0 of 0'}
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
          ) : current ? (
            <div className="frame__overlay frame__overlay--quiet">
              <span className="spinner" aria-hidden="true" />
            </div>
          ) : (
            <div className="frame__overlay">
              <p className="frame__overlay-body">No photos match this range.</p>
            </div>
          )}
          {showDates && current ? (
            <span className="playback__date" data-testid="playback-date">
              {exportDateLabel(current.dayKey)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="playback__controls">
        <div className="playback__summary" data-testid="playback-summary">
          <span>{ordered.length} frame{ordered.length === 1 ? '' : 's'} · {formatTimelapseDuration(ordered.length, fps)}</span>
          <span>{loop ? 'Looping' : 'Stops at end'}</span>
        </div>

        <input
          type="range"
          min={0}
          max={Math.max(0, ordered.length - 1)}
          value={Math.min(index, Math.max(0, ordered.length - 1))}
          disabled={ordered.length === 0}
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
            disabled={ordered.length < 2}
            onClick={() => {
              if (atEnd && !loop) setIndex(0)
              setPlaying((currentPlaying) => (atEnd && !loop ? true : !currentPlaying))
            }}
            data-testid="playback-toggle"
          >
            {atEnd && !loop ? 'Play again' : playing ? 'Pause' : 'Play'}
          </button>

          <div className="segmented segmented--compact" role="group" aria-label="Playback speed">
            {SPEEDS.map((speed) => (
              <button
                key={speed.label}
                type="button"
                className="segmented__item"
                data-active={fps === speed.fps}
                aria-pressed={fps === speed.fps}
                onClick={() => {
                  setFps(speed.fps)
                  setReadyVideo(null)
                }}
              >
                {speed.label}
              </button>
            ))}
          </div>
        </div>

        <div className="playback__row playback__row--actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPlaying(false)
              setOptionsOpen(true)
            }}
            data-testid="playback-options"
          >
            {rangeLabel}
          </button>
          <button
            type="button"
            className="btn"
            disabled={exporting || ordered.length < 2 || !exportSupported}
            title={exportSupported ? undefined : 'Video export is unavailable in this browser'}
            onClick={() => void (readyVideo ? saveReadyVideo() : makeVideo())}
            data-testid="playback-export"
          >
            <IconExport size={18} />
            {exporting
              ? exportProgress || 'Preparing…'
              : readyVideo
                ? readyVideo.shareable
                  ? 'Share video'
                  : 'Save again'
                : 'Export video'}
          </button>
        </div>
      </div>

      {optionsOpen ? (
        <PlaybackOptions
          photos={photos}
          selectedCount={selected.length}
          range={range}
          loop={loop}
          showDates={showDates}
          onRangeChange={changeRange}
          onLoopChange={setLoop}
          onShowDatesChange={changeShowDates}
          onClose={() => setOptionsOpen(false)}
        />
      ) : null}

      <Toast toast={toast} />
    </div>
  )
}

function PlaybackOptions({
  photos,
  selectedCount,
  range,
  loop,
  showDates,
  onRangeChange,
  onLoopChange,
  onShowDatesChange,
  onClose,
}: {
  photos: readonly PhotoMeta[]
  selectedCount: number
  range: TimelapseRange
  loop: boolean
  showDates: boolean
  onRangeChange: (range: TimelapseRange) => void
  onLoopChange: (enabled: boolean) => void
  onShowDatesChange: (enabled: boolean) => void
  onClose: () => void
}) {
  const dialogRef = useModalFocus<HTMLElement>(onClose)
  const boundaries = useMemo(() => {
    const days = photos.map((photo) => photo.dayKey).sort()
    return { first: days[0] ?? '', last: days.at(-1) ?? '' }
  }, [photos])

  const choosePreset = (preset: TimelapseRangePreset) => {
    if (preset === 'custom') {
      onRangeChange({
        preset,
        from: range.from ?? boundaries.first,
        to: range.to ?? boundaries.last,
      })
    } else {
      onRangeChange({ preset })
    }
  }

  return (
    <div className="sheet-layer" data-testid="playback-options-sheet">
      <button
        type="button"
        className="sheet__backdrop"
        onClick={onClose}
        aria-label="Close timelapse options"
        tabIndex={-1}
      />
      <section
        ref={dialogRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="timelapse-options-title"
        tabIndex={-1}
      >
        <header className="sheet__header">
          <div>
            <h2 id="timelapse-options-title" className="sheet__title">Timelapse options</h2>
            <p className="sheet__sub">{selectedCount} photo{selectedCount === 1 ? '' : 's'} selected</p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>

        <div className="timelapse-options">
          <label className="field">
            <span className="field__label">Date range</span>
            <select
              className="select-input"
              value={range.preset}
              onChange={(event) => choosePreset(event.target.value as TimelapseRangePreset)}
              data-testid="playback-range"
            >
              <option value="all">All photos</option>
              <option value="30-days">Last 30 days</option>
              <option value="1-year">Last year</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>

          {range.preset === 'custom' ? (
            <div className="timelapse-options__dates">
              <label className="field">
                <span className="field__label">From</span>
                <input
                  type="date"
                  className="text-input"
                  min={boundaries.first}
                  max={range.to ?? boundaries.last}
                  value={range.from ?? ''}
                  onChange={(event) => onRangeChange({ ...range, from: event.target.value })}
                  data-testid="playback-range-from"
                />
              </label>
              <label className="field">
                <span className="field__label">To</span>
                <input
                  type="date"
                  className="text-input"
                  min={range.from ?? boundaries.first}
                  max={boundaries.last}
                  value={range.to ?? ''}
                  onChange={(event) => onRangeChange({ ...range, to: event.target.value })}
                  data-testid="playback-range-to"
                />
              </label>
            </div>
          ) : null}

          <OptionSwitch
            label="Loop playback"
            hint="Start over automatically at the last frame."
            checked={loop}
            onChange={onLoopChange}
            testId="playback-loop"
          />
          <OptionSwitch
            label="Show dates"
            hint="Stamp each frame in playback and exported video."
            checked={showDates}
            onChange={onShowDatesChange}
            testId="playback-show-dates"
          />
        </div>
      </section>
    </div>
  )
}

function OptionSwitch({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
  testId: string
}) {
  return (
    <div className="row">
      <div className="row__text">
        <span className="row__label">{label}</span>
        <span className="row__hint">{hint}</span>
      </div>
      <div className="row__control">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          data-testid={testId}
        >
          <span className="switch__knob" />
        </button>
      </div>
    </div>
  )
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function labelForRange(preset: TimelapseRangePreset): string {
  if (preset === '30-days') return 'Last 30 days'
  if (preset === '1-year') return 'Last year'
  if (preset === 'custom') return 'Custom dates'
  return 'All photos'
}

function exportDateLabel(dayKey: DayKey): string {
  return dayKeyToDate(dayKey).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function downloadVideo(file: File, filename: string): void {
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
