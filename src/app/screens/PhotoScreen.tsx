import { useCallback, useMemo } from 'react'
import { formatDayLabel } from '../../core/day.ts'
import { IconBack, IconChevronLeft, IconChevronRight, IconTrash } from '../components/Icons.tsx'
import { Toast } from '../components/Toast.tsx'
import { useToast } from '../useToast.ts'
import { goBack, useNavigate } from '../router.ts'
import { useApp } from '../store-context.ts'
import { useStoredImage } from '../useStoredImage.ts'

export function PhotoScreen({ id }: { id: string }) {
  const { metas, actions, status, pendingIds } = useApp()
  const navigate = useNavigate()
  const { toast, show } = useToast()

  const index = useMemo(() => metas.findIndex((m) => m.id === id), [metas, id])
  const meta = index >= 0 ? metas[index] : undefined
  const image = useStoredImage(meta?.id, 'master', true, false)

  // metas is newest-first, so the *next* newer photo is at a lower index.
  const newer = index > 0 ? metas[index - 1] : undefined
  const older = index >= 0 && index < metas.length - 1 ? metas[index + 1] : undefined

  const onDelete = useCallback(async () => {
    if (!meta) return
    try {
      const fallback = newer ?? older
      await actions.trashPhoto(meta.id)
      if (fallback) navigate({ name: 'photo', id: fallback.id }, { replace: true })
      else navigate({ name: 'timeline' }, { replace: true })
    } catch (err) {
      show(err instanceof Error ? err.message : 'That photo could not be moved to Trash.', 'error')
    }
  }, [actions, meta, navigate, newer, older, show])

  if (status === 'loading') {
    return (
      <div className="screen" data-testid="photo-screen">
        <p className="empty muted">Loading…</p>
      </div>
    )
  }

  if (!meta) {
    return (
      <div className="screen" data-testid="photo-screen">
        <header className="topbar">
          <button type="button" className="iconbtn" onClick={() => goBack({ name: 'timeline' })} aria-label="Back">
            <IconBack />
          </button>
          <div className="topbar__title">Photo</div>
        </header>
        <div className="empty" data-testid="photo-missing">
          <p className="empty__title">This photo is no longer here</p>
          <p className="empty__body muted">It may have been moved to Trash.</p>
          <button type="button" className="btn" onClick={() => navigate({ name: 'timeline' }, { replace: true })}>
            Back to timeline
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen" data-testid="photo-screen">
      <header className="topbar">
        <button
          type="button"
          className="iconbtn"
          onClick={() => goBack({ name: 'timeline' })}
          aria-label="Back to timeline"
          data-testid="photo-back"
        >
          <IconBack />
        </button>
        <div className="topbar__title">
          {formatDayLabel(meta.dayKey)}
          <span className="topbar__sub">
            {new Date(meta.capturedAt).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
            })}
            {' · '}
            {meta.width}×{meta.height}
          </span>
        </div>
        <button
          type="button"
          className="iconbtn"
          onClick={() => void onDelete()}
          aria-label="Move photo to Trash"
          data-testid="photo-delete"
        >
          <IconTrash />
        </button>
      </header>

      <div className="photo__stage">
        <div className="frame frame--static">
          {pendingIds.includes(meta.id) ? <span className="upload-badge">Uploading</span> : null}
          {image.url ? (
            <img width={meta.width} height={meta.height} decoding="async" className="frame__still" src={image.url} alt={formatDayLabel(meta.dayKey)} data-testid="photo-image" />
          ) : image.error ? (
            <div className="frame__overlay">
              <p className="frame__overlay-body">{image.error}</p>
            </div>
          ) : (
            <div className="frame__overlay frame__overlay--quiet">
              <span className="spinner" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>

      <nav className="photo__nav">
        <button
          type="button"
          className="btn"
          disabled={!older}
          onClick={() => older && navigate({ name: 'photo', id: older.id }, { replace: true })}
          data-testid="photo-older"
        >
          <IconChevronLeft size={18} /> Older
        </button>
        <button
          type="button"
          className="btn"
          disabled={!newer}
          onClick={() => newer && navigate({ name: 'photo', id: newer.id }, { replace: true })}
          data-testid="photo-newer"
        >
          Newer <IconChevronRight size={18} />
        </button>
      </nav>

      <Toast toast={toast} />
    </div>
  )
}
