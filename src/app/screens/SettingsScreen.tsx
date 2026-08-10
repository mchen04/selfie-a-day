import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeThumbnail } from '../../camera/encode.ts'
import { isStandalone } from '../../camera/support.ts'
import { resolvedTimeZone } from '../../core/day.ts'
import { CAPTURE_QUALITY_PRESETS } from '../../core/types.ts'
import { backupFilename, exportBackup, importBackup, parseBackupFile } from '../../storage/backup.ts'
import { deleteAllPhotos } from '../../storage/photos.ts'
import { formatBytes, getStorageStatus, requestPersistence, type StorageStatus } from '../../storage/persistence.ts'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import {
  IconBack,
  IconChevronDown,
  IconExport,
  IconImport,
  IconShield,
  IconTrash,
} from '../components/Icons.tsx'
import { Toast } from '../components/Toast.tsx'
import { useToast } from '../useToast.ts'
import { goBack, useNavigate } from '../router.ts'
import { useApp } from '../store-context.ts'

const APP_VERSION = __APP_VERSION__

export function SettingsScreen() {
  const { allMetas, trashedMetas, albums, activeAlbum, settings, actions } = useApp()
  const navigate = useNavigate()
  const { toast, show } = useToast()
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [choosingAlbum, setChoosingAlbum] = useState(false)
  const [albumDraft, setAlbumDraft] = useState({
    id: activeAlbum.id,
    name: activeAlbum.name,
    timeZone: activeAlbum.timeZone ?? '',
  })
  const [importProblems, setImportProblems] = useState<string[]>([])
  const importRef = useRef<HTMLInputElement | null>(null)

  const refreshStorage = useCallback(() => {
    void getStorageStatus().then(setStorage)
  }, [])

  useEffect(refreshStorage, [refreshStorage])

  const storedBytes = [...allMetas, ...trashedMetas].reduce(
    (sum, meta) => sum + meta.masterBytes + meta.thumbBytes,
    0,
  )
  const systemTimeZone = resolvedTimeZone()
  const timeZones = useMemo(() => supportedTimeZones(activeAlbum.timeZone), [activeAlbum.timeZone])
  const albumForm =
    albumDraft.id === activeAlbum.id
      ? albumDraft
      : { id: activeAlbum.id, name: activeAlbum.name, timeZone: activeAlbum.timeZone ?? '' }

  const onExport = useCallback(async () => {
    if (allMetas.length === 0) {
      show('There are no photos to back up yet.', 'error')
      return
    }

    /**
     * Recording the export is bookkeeping, not part of the export. It must not
     * sit on the success path: a throw here used to be caught as a *share*
     * failure and fall through to the download, handing the user the same file
     * twice — or be reported as "the backup could not be created" after the
     * file had already been saved. Failing to record it only means the backup
     * reminder reappears.
     */
    const recordExported = () => {
      void actions.updateSettings({ lastExportAt: Date.now() }).catch(() => undefined)
    }

    setBusy('export')
    try {
      const { blob } = await exportBackup((done, total) => setProgress(`Packing ${done} of ${total}…`))
      const filename = backupFilename()
      const file = new File([blob], filename, { type: 'application/zip' })

      // An installed iOS web app has no visible Downloads folder, so a plain
      // <a download> silently goes nowhere. The share sheet is the only path
      // that reliably lands the file somewhere the user can find it.
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Selfie a Day backup' })
          recordExported()
          show('Backup shared.', 'success')
          return
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          // Sharing is unavailable or failed; fall through to the download.
        }
      }

      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        recordExported()
        show(`Saved ${filename}`, 'success')
      } finally {
        // Give the browser a beat to start the download before releasing.
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'The backup could not be created.', 'error')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }, [actions, allMetas.length, show])

  const onSaveAlbum = useCallback(async () => {
    setBusy('album')
    try {
      await actions.updateAlbum(activeAlbum.id, {
        name: albumForm.name,
        timeZone: albumForm.timeZone || null,
      })
      show('Album settings saved.', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'The album could not be updated.', 'error')
    } finally {
      setBusy(null)
    }
  }, [actions, activeAlbum.id, albumForm.name, albumForm.timeZone, show])

  const onImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return

      setBusy('import')
      try {
        // Stream from the File: a large backup must not be read into the heap
        // in one piece, which is the failure export was rewritten to avoid.
        const parsed = await parseBackupFile(file)
        const result = await importBackup(parsed, {
          makeThumbnail,
          onProgress: (done, total) => setProgress(`Restoring ${done} of ${total}…`),
        })
        // A partial restore must say what actually happened. The reasons were
        // being computed and thrown away, so a restore that hit quota, or that
        // kept newer photos, read as "could not be read" — sending the user to
        // re-download a backup that was fine.
        if (result.skipped > 0) {
          setImportProblems(result.problems)
          show(
            `Restored ${result.imported}, kept or skipped ${result.skipped}. See the details below.`,
            'error',
          )
        } else {
          setImportProblems([])
          show(`Restored ${result.imported} photo${result.imported === 1 ? '' : 's'}.`, 'success')
        }
      } catch (err) {
        show(err instanceof Error ? err.message : 'That file could not be restored.', 'error')
      } finally {
        // Always re-read: a restore that failed part-way through still wrote
        // rows, and leaving the timeline and the ghost stale would hide them.
        await actions.reload()
        refreshStorage()
        setBusy(null)
        setProgress(null)
      }
    },
    [actions, refreshStorage, show],
  )

  const onRequestPersistence = useCallback(async () => {
    const granted = await requestPersistence()
    refreshStorage()
    show(
      granted === true
        ? 'This browser will now keep your photos.'
        : granted === false
          ? 'This browser declined. Keep a backup — it is the reliable protection.'
          : 'This browser does not offer persistent storage.',
      granted === true ? 'success' : 'info',
    )
  }, [refreshStorage, show])

  const onWipe = useCallback(async () => {
    if (!confirmWipe) {
      setConfirmWipe(true)
      return
    }
    setBusy('wipe')
    try {
      await deleteAllPhotos()
      show('All photos deleted from this device.', 'success')
    } catch (err) {
      // Telling someone their photos are gone when they are not is worse than
      // the failure itself — they would stop looking for them.
      show(err instanceof Error ? err.message : 'The photos could not be deleted.', 'error')
    } finally {
      await actions.reload()
      refreshStorage()
      setBusy(null)
      setConfirmWipe(false)
    }
  }, [actions, confirmWipe, refreshStorage, show])

  return (
    <div className="screen" data-testid="settings-screen">
      <header className="topbar">
        <button type="button" className="iconbtn" onClick={() => goBack()} aria-label="Back to camera" data-testid="settings-back">
          <IconBack />
        </button>
        <div className="topbar__title">Settings</div>
      </header>

      <div className="screen__scroll settings">
        <section className="card stack">
          <h2 className="section__title">Active album</h2>
          <button
            type="button"
            className="album-settings__switch"
            onClick={() => setChoosingAlbum(true)}
            data-testid="settings-album-picker"
          >
            <span>
              <strong>{activeAlbum.name}</strong>
              <small>{allMetas.filter((photo) => photo.albumId === activeAlbum.id).length} photos</small>
            </span>
            <span className="album-settings__switch-action">
              Switch <IconChevronDown size={16} />
            </span>
          </button>

          <label className="field">
            <span className="field__label">Album name</span>
            <input
              className="text-input"
              value={albumForm.name}
              onChange={(event) => setAlbumDraft({ ...albumForm, name: event.target.value })}
              maxLength={40}
              data-testid="album-name-input"
            />
          </label>

          <label className="field">
            <span className="field__label">Day timezone</span>
            <select
              className="select-input"
              value={albumForm.timeZone}
              onChange={(event) => setAlbumDraft({ ...albumForm, timeZone: event.target.value })}
              data-testid="album-timezone-select"
            >
              <option value="">Automatic — {systemTimeZone.replaceAll('_', ' ')}</option>
              {timeZones.map((timeZone) => (
                <option key={timeZone} value={timeZone}>
                  {timeZone.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <p className="tiny muted">
            This decides when a new day starts for future photos. Existing dates never move.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--wide"
            onClick={() => void onSaveAlbum()}
            disabled={busy !== null || albumForm.name.trim().length === 0}
            data-testid="save-album-settings"
          >
            {busy === 'album' ? 'Saving…' : 'Save album settings'}
          </button>
        </section>

        <section className="card stack">
          <h2 className="section__title">Alignment</h2>

          <Row label="Ghost strength" hint="How strongly yesterday shows through.">
            <input
              type="range"
              min={5}
              max={95}
              step={5}
              value={Math.round(settings.ghostOpacity * 100)}
              onChange={(e) => void actions.updateSettings({ ghostOpacity: Number(e.target.value) / 100 })}
              aria-label="Ghost strength"
              data-testid="settings-ghost-opacity"
            />
          </Row>

          <Row label="Guides" hint="Thirds for framing, eye line for faces.">
            <Segmented
              value={settings.gridStyle}
              options={[
                { value: 'thirds', label: 'Thirds' },
                { value: 'crosshair', label: 'Eye line' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(gridStyle) => void actions.updateSettings({ gridStyle })}
              testId="settings-grid"
            />
          </Row>

          <Row
            label="Mirror the preview"
            hint="You see yourself as in a mirror, and that is what gets saved. Older photos keep their own orientation; the ghost adapts."
          >
            <Switch
              checked={settings.mirrorPreview}
              onChange={(mirrorPreview) => void actions.updateSettings({ mirrorPreview })}
              label="Mirror the preview"
              testId="settings-mirror"
            />
          </Row>
        </section>

        <section className="card stack">
          <h2 className="section__title">Photo quality</h2>
          <Segmented
            value={String(settings.captureLongEdge)}
            options={CAPTURE_QUALITY_PRESETS.map((p) => ({
              value: String(p.longEdge),
              label: p.label,
            }))}
            onChange={(value) => void actions.updateSettings({ captureLongEdge: Number(value) })}
            testId="settings-quality"
          />
          <p className="tiny muted">
            {CAPTURE_QUALITY_PRESETS.find((p) => p.longEdge === settings.captureLongEdge)?.note ??
              'Higher quality uses more space.'}
          </p>
        </section>

        <section className="card stack">
          <h2 className="section__title">Storage on this device</h2>
          <dl className="facts" data-testid="storage-facts">
            <div>
              <dt>Photos</dt>
              <dd>{allMetas.length}</dd>
            </div>
            <div>
              <dt>Space used</dt>
              <dd>{formatBytes(storedBytes)}</dd>
            </div>
            <div>
              <dt>In Trash</dt>
              <dd>{trashedMetas.length}</dd>
            </div>
            <div>
              <dt>Kept permanently</dt>
              <dd data-testid="persistence-state">
                {storage === null
                  ? '…'
                  : storage.persisted === true
                    ? 'Yes'
                    : storage.persisted === false
                      ? 'Not guaranteed'
                      : 'Unknown'}
              </dd>
            </div>
          </dl>

          {storage?.persisted !== true ? (
            <>
              <p className="tiny muted">
                Browsers can clear website storage to reclaim space, and Safari is stricter than
                most. Asking for permanent storage helps where it is supported — a backup is what
                protects you everywhere.
              </p>
              <button
                type="button"
                className="btn btn--wide"
                onClick={() => void onRequestPersistence()}
                data-testid="request-persistence"
              >
                <IconShield size={18} /> Ask to keep photos permanently
              </button>
            </>
          ) : null}
        </section>

        <section className="card stack">
          <h2 className="section__title">Trash</h2>
          <p className="tiny muted">
            Removed photos stay recoverable for 30 days, then their stored image is deleted.
          </p>
          <button
            type="button"
            className="btn btn--wide"
            onClick={() => navigate({ name: 'trash' })}
            data-testid="review-trash"
          >
            <IconTrash size={18} /> Review Trash
            {trashedMetas.length > 0 ? ` (${trashedMetas.length})` : ''}
          </button>
        </section>

        <section className="card stack">
          <h2 className="section__title">Backup</h2>
          <p className="tiny muted">
            A backup is a plain .zip of your photos plus a small manifest. You can open it anywhere,
            with or without this app.
          </p>
          <p className="tiny muted">
            On iPhone, a web app added to the Home Screen gets its own separate storage — photos
            taken here in Safari will not appear inside the installed app. Export first, install,
            then restore, and nothing is lost.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--wide"
            onClick={() => void onExport()}
            disabled={busy !== null}
            data-testid="export-backup"
          >
            <IconExport size={18} /> {busy === 'export' ? (progress ?? 'Packing…') : 'Export all photos'}
          </button>
          <button
            type="button"
            className="btn btn--wide"
            onClick={() => importRef.current?.click()}
            disabled={busy !== null}
            data-testid="import-backup"
          >
            <IconImport size={18} /> {busy === 'import' ? (progress ?? 'Restoring…') : 'Restore from backup'}
          </button>
          {importProblems.length > 0 ? (
            <div className="card card--inset" data-testid="import-problems">
              <p className="tiny muted">What the restore did not bring back:</p>
              <ul className="problems">
                {importProblems.slice(0, 8).map((problem) => (
                  <li key={problem} className="tiny">
                    {problem}
                  </li>
                ))}
                {importProblems.length > 8 ? (
                  <li className="tiny muted">and {importProblems.length - 8} more…</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="visually-hidden"
            onChange={(event) => void onImportFile(event)}
            data-testid="import-input"
            tabIndex={-1}
            aria-hidden="true"
          />
        </section>

        <section className="card stack">
          <h2 className="section__title">Privacy</h2>
          <p className="tiny muted" data-testid="privacy-statement">
            Every photo is stored only in this browser, on this device. Nothing is uploaded, there
            is no account, and the app makes no network requests once it has loaded. Deleting the
            app data or the browser&apos;s website data removes the photos permanently — which is
            why export exists.
          </p>
          <p className="tiny muted">
            Version {APP_VERSION}
            {isStandalone() ? ' · installed' : ' · in browser'}
          </p>
        </section>

        <section className="card stack">
          <h2 className="section__title">Danger zone</h2>
          <button
            type="button"
            className="btn btn--danger btn--wide"
            onClick={() => void onWipe()}
            disabled={busy !== null || allMetas.length + trashedMetas.length === 0}
            data-testid="delete-all"
          >
            <IconTrash size={18} />
            {confirmWipe
              ? `Really delete all ${allMetas.length + trashedMetas.length}? Tap again`
              : 'Delete all photos'}
          </button>
        </section>
      </div>

      <Toast toast={toast} />

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

function supportedTimeZones(current: string | null): string[] {
  const extendedIntl = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[]
  }
  const fallback = [
    'UTC',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Kolkata',
    'Australia/Sydney',
    'Pacific/Auckland',
  ]
  const zones = extendedIntl.supportedValuesOf?.('timeZone') ?? fallback
  return [...new Set(current ? [current, ...zones] : zones)]
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="row">
      <div className="row__text">
        <span className="row__label">{label}</span>
        {hint ? <span className="row__hint">{hint}</span> : null}
      </div>
      <div className="row__control">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  testId?: string
}) {
  return (
    <div className="segmented" role="group" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          data-active={option.value === value}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  testId?: string
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-testid={testId}
    >
      <span className="switch__knob" />
    </button>
  )
}
