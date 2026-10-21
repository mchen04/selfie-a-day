import { useEffect, useRef, useState } from 'react'
import { CAPTURE_QUALITY_PRESETS } from '../../core/types.ts'
import { isValidTimeZone } from '../../core/day.ts'
import { downloadPhotos, saveDownload } from '../../storage/download.ts'
import { Reminders } from '../../push/Reminders.tsx'
import { unsubscribeDevice } from '../../push/client.ts'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { CloudStatus } from '../components/cloud/CloudStatus.tsx'
import { IconBack, IconChevronRight } from '../components/Icons.tsx'
import { Toast } from '../components/Toast.tsx'
import { useToast } from '../useToast.ts'
import { goBack, useNavigate } from '../router.ts'
import { useApp } from '../store-context.ts'

export function SettingsScreen() {
  const { allMetas, albums, activeAlbum, settings, user, pendingIds, actions } = useApp()
  const navigate = useNavigate()
  const { toast, show } = useToast()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [choosingAlbum, setChoosingAlbum] = useState(false)
  // Only the user's edits are held here, so an album that syncs in after
  // Settings opened shows its real name and time zone rather than a stale copy.
  const [draft, setDraft] = useState<{ id: string; name?: string; zone?: string }>({ id: activeAlbum.id })
  const abort = useRef<AbortController | null>(null)
  const edits = draft.id === activeAlbum.id ? draft : { id: activeAlbum.id }
  const saved = { name: activeAlbum.name, zone: activeAlbum.timeZone ?? '' }
  const form = { name: edits.name ?? saved.name, zone: edits.zone ?? saved.zone }
  const edited = form.name !== saved.name || form.zone !== saved.zone
  useEffect(() => () => abort.current?.abort(), [])

  async function attempt(action: () => Promise<unknown>) {
    setBusy(true)
    try { await action() }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) show(error instanceof Error ? error.message : 'Please try again.', 'error')
    } finally { setBusy(false); setProgress(null) }
  }

  return (
    <div className="screen" data-testid="settings-screen">
      <header className="topbar">
        <button type="button" className="iconbtn" onClick={() => goBack()} aria-label="Back to camera" data-testid="settings-back"><IconBack /></button>
        <div className="topbar__title">Settings</div>
      </header>
      <CloudStatus />
      {/* Groups run rarest first and the list starts at its end, so the reminder
          switches sit under the thumb and Log out stays furthest away. */}
      <div className="screen__scroll settings">
        <div className="settings__list">
          <section className="card settings__group" aria-label="Account">
            <div className="settings__row">
              <h2 className="settings__name">{user?.username}</h2>
              <button type="button" className="settings__action settings__action--danger" disabled={busy} data-testid="logout" onClick={() => {
                if (pendingIds.length && !window.confirm('Photos are waiting to upload. Logging out deletes them from this device. Log out?')) return
                void attempt(async () => { await unsubscribeDevice(); await actions.logout() })
              }}>Log out</button>
            </div>
          </section>
          <section className="card settings__group" aria-label="Your photos">
            <button type="button" className="settings__row settings__link" disabled={busy || !allMetas.length} data-testid="download-photos" onClick={() => void attempt(async () => {
              const controller = new AbortController()
              abort.current = controller
              setProgress('Preparing photos…')
              const file = await downloadPhotos(allMetas, albums, controller.signal, (done, total) => setProgress(`Downloading ${done} of ${total}…`))
              controller.signal.throwIfAborted()
              await saveDownload(file)
            })}>Download my photos</button>
            {progress ? <div className="settings__row download-progress" role="status"><span>{progress}</span><button className="settings__action" type="button" onClick={() => abort.current?.abort()}>Cancel</button></div> : null}
            <button type="button" className="settings__row settings__link" data-testid="open-trash" onClick={() => navigate({ name: 'trash' })}>
              <span>Trash</span><IconChevronRight size={18} />
            </button>
          </section>
          <section className="card settings__group" aria-label="Camera">
            <div className="settings__row">
              <span className="settings__label">Mirror preview</span>
              <button type="button" className="switch" role="switch" aria-checked={settings.mirrorPreview} aria-label="Mirror preview" data-testid="settings-mirror"
                onClick={() => void attempt(() => actions.updateSettings({ mirrorPreview: !settings.mirrorPreview }))}><span className="switch__knob" /></button>
            </div>
            <label className="settings__row"><span className="settings__label">Ghost</span>
              <input type="range" min="5" max="95" value={Math.round(settings.ghostOpacity * 100)} aria-label="Ghost strength"
                onChange={(event) => void attempt(() => actions.updateSettings({ ghostOpacity: Number(event.target.value) / 100 }))} />
              <span className="settings__value">{Math.round(settings.ghostOpacity * 100)}%</span>
            </label>
            <label className="settings__row"><span className="settings__label">Quality</span>
              <select className="select-input" value={settings.captureLongEdge} aria-label="Capture quality" data-testid="capture-quality"
                onChange={(event) => void attempt(() => actions.updateSettings({ captureLongEdge: Number(event.target.value) }))}>
                {CAPTURE_QUALITY_PRESETS.map((preset) => <option key={preset.longEdge} value={preset.longEdge}>{preset.label} · {preset.longEdge}px</option>)}
              </select>
            </label>
          </section>
          <section className="card settings__group" aria-label="Album">
            <button type="button" className="settings__row settings__link" onClick={() => setChoosingAlbum(true)} data-testid="settings-album-picker">
              <strong>{activeAlbum.name}</strong><span className="settings__link-hint">Switch</span><IconChevronRight size={18} />
            </button>
            <label className="settings__row"><span className="settings__label">Name</span>
              <input className="text-input" maxLength={40} value={form.name} aria-label="Album name" onChange={(event) => setDraft({ ...edits, name: event.target.value })} data-testid="album-name" />
            </label>
            <label className="settings__row"><span className="settings__label">Time zone</span>
              <select className="select-input" value={form.zone} aria-label="Time zone" onChange={(event) => setDraft({ ...edits, zone: event.target.value })} data-testid="album-timezone">
                <option value="">Follow this device</option>
                {Array.from(new Set([...(Intl.supportedValuesOf?.('timeZone') ?? []), ...(form.zone ? [form.zone] : [])])).map((zone) => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}
              </select>
            </label>
            {edited ? <button type="button" className="settings__row settings__link" disabled={busy} data-testid="save-album" onClick={() => void attempt(async () => {
              if (form.zone && !isValidTimeZone(form.zone)) throw new Error('Choose a valid time zone.')
              await actions.updateAlbum(activeAlbum.id, { name: form.name, timeZone: form.zone || null })
              setDraft({ id: activeAlbum.id })
              show('Album saved.', 'success')
            })}>Save album</button> : null}
          </section>
          <Reminders albums={albums} onError={(message) => show(message, 'error')} />
        </div>
      </div>
      {choosingAlbum ? <AlbumPicker albums={albums} photos={allMetas} activeAlbumId={activeAlbum.id} onSelect={actions.selectAlbum}
        onCreate={async (name) => { await actions.createAlbum(name) }} onClose={() => setChoosingAlbum(false)} /> : null}
      <Toast toast={toast} />
    </div>
  )
}
