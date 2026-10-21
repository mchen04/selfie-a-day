import { useEffect, useRef, useState } from 'react'
import { CAPTURE_QUALITY_PRESETS } from '../../core/types.ts'
import { isValidTimeZone } from '../../core/day.ts'
import { downloadPhotos, saveDownload } from '../../storage/download.ts'
import { Reminders } from '../../push/Reminders.tsx'
import { unsubscribeDevice } from '../../push/client.ts'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { IconBack } from '../components/Icons.tsx'
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
  const [draft, setDraft] = useState({ id: activeAlbum.id, name: activeAlbum.name, zone: activeAlbum.timeZone ?? '' })
  const abort = useRef<AbortController | null>(null)
  const form = draft.id === activeAlbum.id ? draft : { id: activeAlbum.id, name: activeAlbum.name, zone: activeAlbum.timeZone ?? '' }
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
      <div className="screen__scroll settings">
        <Reminders albums={albums} onError={(message) => show(message, 'error')} />
        <section className="card stack">
          <button className="album-settings__switch" type="button" onClick={() => setChoosingAlbum(true)} data-testid="settings-album-picker">
            <strong>{activeAlbum.name}</strong><span>Switch album</span>
          </button>
          <label className="field"><span className="field__label">Album name</span>
            <input className="text-input" maxLength={40} value={form.name} onChange={(event) => setDraft({ ...form, name: event.target.value })} data-testid="album-name" />
          </label>
          <label className="field"><span className="field__label">Day boundary</span>
            <select className="text-input" value={form.zone} onChange={(event) => setDraft({ ...form, zone: event.target.value })} data-testid="album-timezone">
              <option value="">Follow this device</option>
              {Array.from(new Set([...(Intl.supportedValuesOf?.('timeZone') ?? []), ...(form.zone ? [form.zone] : [])])).map((zone) => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          <button type="button" className="btn" disabled={busy} data-testid="save-album" onClick={() => void attempt(async () => {
            if (form.zone && !isValidTimeZone(form.zone)) throw new Error('Choose a valid time zone.')
            await actions.updateAlbum(activeAlbum.id, { name: form.name, timeZone: form.zone || null })
            show('Album saved.', 'success')
          })}>Save album</button>
        </section>
        <section className="card stack">
          <button type="button" className="btn" role="switch" aria-checked={settings.mirrorPreview} data-testid="settings-mirror"
            onClick={() => void attempt(() => actions.updateSettings({ mirrorPreview: !settings.mirrorPreview }))}>Mirror preview</button>
          <label className="field"><span className="field__label">Ghost strength · {Math.round(settings.ghostOpacity * 100)}%</span>
            <input type="range" min="5" max="95" value={Math.round(settings.ghostOpacity * 100)} aria-label="Ghost strength"
              onChange={(event) => void attempt(() => actions.updateSettings({ ghostOpacity: Number(event.target.value) / 100 }))} />
          </label>
          <label className="field"><span className="field__label">Capture quality</span>
            <select className="text-input" value={settings.captureLongEdge} data-testid="capture-quality"
              onChange={(event) => void attempt(() => actions.updateSettings({ captureLongEdge: Number(event.target.value) }))}>
              {CAPTURE_QUALITY_PRESETS.map((preset) => <option key={preset.longEdge} value={preset.longEdge}>{preset.label} · {preset.longEdge}px</option>)}
            </select>
          </label>
        </section>
        <section className="card stack">
          <button type="button" className="btn" disabled={busy || !allMetas.length} data-testid="download-photos" onClick={() => void attempt(async () => {
            const controller = new AbortController()
            abort.current = controller
            setProgress('Preparing photos…')
            const file = await downloadPhotos(allMetas, albums, controller.signal, (done, total) => setProgress(`Downloading ${done} of ${total}…`))
            controller.signal.throwIfAborted()
            await saveDownload(file)
          })}>Download my photos</button>
          {progress ? <div className="download-progress" role="status"><span>{progress}</span><button className="btn" type="button" onClick={() => abort.current?.abort()}>Cancel</button></div> : null}
          <button type="button" className="btn" data-testid="open-trash" onClick={() => navigate({ name: 'trash' })}>Trash</button>
        </section>
        <section className="card stack">
          <h2 className="section__title">{user?.username}</h2>
          <button type="button" className="btn" disabled={busy} data-testid="logout" onClick={() => {
            if (pendingIds.length && !window.confirm('Photos are waiting to upload. Logging out deletes them from this device. Log out?')) return
            void attempt(async () => { await unsubscribeDevice(); await actions.logout() })
          }}>Log out</button>
        </section>
      </div>
      {choosingAlbum ? <AlbumPicker albums={albums} photos={allMetas} activeAlbumId={activeAlbum.id} onSelect={actions.selectAlbum}
        onCreate={async (name) => { await actions.createAlbum(name) }} onClose={() => setChoosingAlbum(false)} /> : null}
      <Toast toast={toast} />
    </div>
  )
}
