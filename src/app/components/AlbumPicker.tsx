import { useMemo, useState } from 'react'
import { dayKeyOf, resolvedTimeZone } from '../../core/day.ts'
import type { Album, PhotoMeta } from '../../core/types.ts'
import { useModalFocus } from '../useModalFocus.ts'
import { IconCheck, IconClose, IconPlus } from './Icons.tsx'

export function AlbumPicker({
  albums,
  photos,
  activeAlbumId,
  onSelect,
  onCreate,
  onClose,
}: {
  albums: readonly Album[]
  photos: readonly PhotoMeta[]
  activeAlbumId: string
  onSelect: (id: string) => Promise<void>
  onCreate: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalFocus<HTMLElement>(onClose)
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const photo of photos) result.set(photo.albumId, (result.get(photo.albumId) ?? 0) + 1)
    return result
  }, [photos])

  const select = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await onSelect(id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That album could not be opened.')
      setBusy(false)
    }
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onCreate(name)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That album could not be created.')
      setBusy(false)
    }
  }

  const systemTimeZone = resolvedTimeZone()

  return (
    <div className="sheet-layer" data-testid="album-picker">
      <button
        type="button"
        className="sheet__backdrop"
        onClick={onClose}
        aria-label="Close album picker"
        tabIndex={-1}
      />
      <section
        ref={dialogRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-picker-title"
        tabIndex={-1}
      >
        <header className="sheet__header">
          <div>
            <h2 id="album-picker-title" className="sheet__title">
              Choose album
            </h2>
            <p className="sheet__sub">Your next photo goes into the selected album.</p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>

        <div className="album-list">
          {albums.map((album) => {
            const today = dayKeyOf(new Date(), album.timeZone ?? systemTimeZone)
            const albumPhotos = photos.filter((photo) => photo.albumId === album.id)
            const savedToday = albumPhotos.some((photo) => photo.dayKey === today)
            const active = album.id === activeAlbumId
            return (
              <button
                key={album.id}
                type="button"
                className="album-row"
                data-active={active}
                disabled={busy}
                onClick={() => void select(album.id)}
                data-testid="album-option"
                data-album-id={album.id}
              >
                <span className="album-row__mark">{active ? <IconCheck size={18} /> : null}</span>
                <span className="album-row__text">
                  <strong>{album.name}</strong>
                  <span>
                    {savedToday
                      ? 'Today saved'
                      : `${counts.get(album.id) ?? 0} photo${counts.get(album.id) === 1 ? '' : 's'}`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {creating ? (
          <form className="album-create" onSubmit={(event) => void create(event)}>
            <label htmlFor="new-album-name" className="visually-hidden">
              Album name
            </label>
            <input
              id="new-album-name"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Album name"
              maxLength={40}
              autoFocus
              data-testid="new-album-name"
            />
            <button type="submit" className="btn btn--primary" disabled={busy || name.trim().length === 0}>
              Create
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn--wide"
            onClick={() => setCreating(true)}
            data-testid="new-album"
          >
            <IconPlus size={18} /> New album
          </button>
        )}

        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </section>
    </div>
  )
}
