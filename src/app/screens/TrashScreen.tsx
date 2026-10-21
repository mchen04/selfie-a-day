import { useMemo, useState } from 'react'
import { dayKeyToDate } from '../../core/day.ts'
const TRASH_RETENTION_MS = 30 * 86_400_000
import { IconBack, IconCamera, IconRestore, IconTrash } from '../components/Icons.tsx'
import { Toast } from '../components/Toast.tsx'
import { goBack } from '../router.ts'
import { useApp } from '../store-context.ts'
import { useStoredImage } from '../useStoredImage.ts'
import { useToast } from '../useToast.ts'

export function TrashScreen() {
  const { trashedMetas, albums, actions, status } = useApp()
  const { toast, show } = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const albumNames = useMemo(
    () => new Map(albums.map((album) => [album.id, album.name])),
    [albums],
  )

  const restore = async (id: string) => {
    setBusyId(id)
    try {
      await actions.restorePhoto(id)
      show('Photo restored.', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'The photo could not be restored.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const removePermanently = async (id: string) => {
    setBusyId(id)
    try {
      await actions.deletePhotoPermanently(id)
      show('Photo deleted permanently.', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'The photo could not be deleted.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const empty = async () => {
    setBusyId('all')
    try {
      const removed = await actions.emptyTrash()
      show(`Deleted ${removed} photo${removed === 1 ? '' : 's'} permanently.`, 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Trash could not be emptied.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="screen" data-testid="trash-screen">
      <header className="topbar">
        <button
          type="button"
          className="iconbtn"
          onClick={() => goBack({ name: 'settings' })}
          aria-label="Back to settings"
          data-testid="trash-back"
        >
          <IconBack />
        </button>
        <div className="topbar__title">
          Trash
          <span className="topbar__sub" data-testid="trash-count">
            {trashedMetas.length} photo{trashedMetas.length === 1 ? '' : 's'}
          </span>
        </div>
        {trashedMetas.length > 0 ? (
          <button
            type="button"
            className="topbar__text-action"
            disabled={busyId !== null}
            onClick={() => void empty()}
            data-testid="empty-trash"
          >
            Empty
          </button>
        ) : null}
      </header>

      <div className="screen__scroll trash-screen">
        <p className="trash-note">
          Photos are deleted permanently after 30 days. Restore anything you want to keep.
        </p>

        {status === 'loading' ? (
          <p className="empty muted">Loading…</p>
        ) : trashedMetas.length === 0 ? (
          <div className="empty" data-testid="trash-empty">
            <IconCamera size={30} />
            <p className="empty__title">Trash is empty</p>
            <p className="empty__body muted">Photos you remove will wait here for 30 days.</p>
          </div>
        ) : (
          <ul className="trash-list">
            {trashedMetas.map((meta) => (
              <TrashItem
                key={meta.id}
                id={meta.id}
                dayKey={meta.dayKey}
                deletedAt={meta.deletedAt ?? now}
                now={now}
                albumName={albumNames.get(meta.albumId) ?? 'Album'}
                busy={busyId !== null}
                onRestore={() => void restore(meta.id)}
                onDelete={() => void removePermanently(meta.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <Toast toast={toast} />
    </div>
  )
}

function TrashItem({
  id,
  dayKey,
  deletedAt,
  now,
  albumName,
  busy,
  onRestore,
  onDelete,
}: {
  id: string
  dayKey: string
  deletedAt: number
  now: number
  albumName: string
  busy: boolean
  onRestore: () => void
  onDelete: () => void
}) {
  const image = useStoredImage(id, 'thumb')
  const daysLeft = Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / 86_400_000))
  const date = dayKeyToDate(dayKey).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <li className="trash-item" data-testid="trash-item">
      <div className="trash-item__photo">
        {image.url ? <img width="72" height="96" loading="lazy" decoding="async" src={image.url} alt={`${albumName}, ${date}`} /> : null}
      </div>
      <div className="trash-item__body">
        <div className="trash-item__copy">
          <strong>{date}</strong>
          <span>{albumName} · {daysLeft} day{daysLeft === 1 ? '' : 's'} left</span>
        </div>
        <div className="trash-item__actions">
          <button type="button" className="btn" disabled={busy} onClick={onRestore}>
            <IconRestore size={17} /> Restore
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={onDelete}
            data-testid="trash-delete-permanently"
          >
            <IconTrash size={17} /> Delete
          </button>
        </div>
      </div>
    </li>
  )
}
