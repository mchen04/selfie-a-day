import { useMemo, useRef, useState } from 'react'
import { dayKeyToDate, formatDayLabel } from '../../core/day.ts'
import type { PhotoMeta } from '../../core/types.ts'
import { IconBack, IconCamera, IconPlay } from '../components/Icons.tsx'
import { Playback } from '../components/Playback.tsx'
import { goBack, useNavigate } from '../router.ts'
import { useApp } from '../store-context.ts'
import { useNearViewport, useStoredImage } from '../useStoredImage.ts'

interface MonthGroup {
  key: string
  label: string
  photos: PhotoMeta[]
}

function groupByMonth(metas: readonly PhotoMeta[]): MonthGroup[] {
  const groups: MonthGroup[] = []
  let current: MonthGroup | null = null

  for (const meta of metas) {
    const key = meta.dayKey.slice(0, 7)
    if (!current || current.key !== key) {
      current = {
        key,
        label: dayKeyToDate(meta.dayKey).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        }),
        photos: [],
      }
      groups.push(current)
    }
    current.photos.push(meta)
  }

  return groups
}

export function TimelineScreen() {
  const { metas, status } = useApp()
  const navigate = useNavigate()
  const groups = useMemo(() => groupByMonth(metas), [metas])
  const [playing, setPlaying] = useState(false)

  // Two photos is the minimum where a timelapse means anything.
  const canPlay = metas.length >= 2

  if (playing) return <Playback photos={metas} onClose={() => setPlaying(false)} />

  return (
    <div className="screen" data-testid="timeline-screen">
      <header className="topbar">
        <button
          type="button"
          className="iconbtn"
          onClick={() => goBack()}
          aria-label="Back to camera"
          data-testid="timeline-back"
        >
          <IconBack />
        </button>
        <div className="topbar__title">
          Timeline
          <span className="topbar__sub" data-testid="timeline-count">
            {metas.length} photo{metas.length === 1 ? '' : 's'}
          </span>
        </div>
        {canPlay ? (
          <button
            type="button"
            className="iconbtn"
            onClick={() => setPlaying(true)}
            aria-label="Play timelapse"
            data-testid="play-timelapse"
          >
            <IconPlay />
          </button>
        ) : null}
      </header>

      <div className="screen__scroll">
        {status === 'loading' ? (
          <p className="empty muted">Loading…</p>
        ) : metas.length === 0 ? (
          <div className="empty" data-testid="timeline-empty">
            <IconCamera size={30} />
            <p className="empty__title">No photos yet</p>
            <p className="empty__body muted">
              Your first selfie becomes the ghost you line up against tomorrow.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: 'capture' })}
            >
              Take today&apos;s photo
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="month">
              <h2 className="month__label">{group.label}</h2>
              <ul className="grid" data-testid="timeline-grid">
                {group.photos.map((meta) => (
                  <li key={meta.id}>
                    <button
                      type="button"
                      className="cell"
                      onClick={() => navigate({ name: 'photo', id: meta.id })}
                      data-testid="timeline-cell"
                      data-day={meta.dayKey}
                    >
                      <Thumb meta={meta} />
                      <span className="cell__day">{Number(meta.dayKey.slice(8))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * A single timeline cell.
 *
 * Thumbnails load only once the cell is within 400px of the viewport, so a
 * timeline with several hundred photos does the decode work for the dozen the
 * user can actually see rather than all of them at once.
 */
function Thumb({ meta }: { meta: PhotoMeta }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const near = useNearViewport(ref)
  const image = useStoredImage(meta.id, 'thumb', near)

  return (
    <div className="cell__media" ref={ref}>
      {image.url ? (
        <img
          src={image.url}
          alt={formatDayLabel(meta.dayKey)}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className="cell__placeholder" aria-hidden="true" />
      )}
    </div>
  )
}
