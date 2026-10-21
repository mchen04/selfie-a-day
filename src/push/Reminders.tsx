import { useEffect, useRef, useState } from 'react'
import { api, type PushPreference } from '../api/client.ts'
import type { Album } from '../core/types.ts'
import { deviceTimeZone, pushState, subscribeDevice } from './client.ts'
import '../styles/push.css'

const reasons = {
  unsupported: 'This browser does not support reminders.',
  'not-installed': 'Add to Home Screen to get reminders',
  denied: 'Notifications are blocked. Allow them in iOS Settings or your browser settings.',
}

export function Reminders({ albums, onError }: { albums: Album[]; onError: (message: string) => void }) {
  const [prefs, setPrefs] = useState<Record<string, PushPreference>>({})
  const [state, setState] = useState(pushState)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const saving = useRef(new Set<string>())
  const mounted = useRef(false)
  const reason = state in reasons ? reasons[state as keyof typeof reasons] : null

  useEffect(() => {
    mounted.current = true
    const refresh = () => setState(pushState())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    void api.pushPrefs().then(({ prefs: saved }) => {
      if (mounted.current) {
        setPrefs(Object.fromEntries(saved.map((pref) => [pref.albumId, pref])))
        setLoaded(true)
      }
    }).catch(() => { if (mounted.current) setLoadError(true) })
    return () => {
      mounted.current = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  async function save(album: Album, previous: PushPreference, patch: Partial<PushPreference>) {
    if (saving.current.has(album.id)) return
    saving.current.add(album.id)
    setPending([...saving.current])
    const next = { ...previous, ...patch, timeZone: album.timeZone ?? deviceTimeZone() }
    setPrefs((current) => ({ ...current, [album.id]: next }))
    try {
      if (next.enabled) await subscribeDevice()
      const { pref } = await api.savePushPrefs(next)
      if (mounted.current) setPrefs((current) => ({ ...current, [album.id]: pref }))
    } catch (error) {
      if (mounted.current) {
        setPrefs((current) => ({ ...current, [album.id]: previous }))
        onError(error instanceof Error ? error.message : 'Could not save reminders. Try again.')
      }
    } finally {
      saving.current.delete(album.id)
      if (mounted.current) {
        setPending([...saving.current])
        setState(pushState())
      }
    }
  }

  return (
    <section className="card reminders" aria-labelledby="reminders-title" data-testid="reminders">
      <h2 className="section__title" id="reminders-title">Reminders</h2>
      {reason ? <p className="tiny muted" id="reminders-reason">{reason}</p> : null}
      {loadError ? <p className="tiny muted" role="alert">Could not load reminders. Reopen Settings to try again.</p> : null}
      {albums.filter((album) => album.deletedAt === null).map((album) => {
        const pref = prefs[album.id] ?? { albumId: album.id, enabled: false, time: '09:00', timeZone: album.timeZone ?? deviceTimeZone() }
        const disabled = !!reason || !loaded || pending.includes(album.id)
        return (
          <div className="reminder-row" key={album.id} data-testid={`reminder-${album.id}`} aria-busy={pending.includes(album.id)}>
            <span className="reminder-row__name" title={album.name}>{album.name}</span>
            <input type="time" className="reminder-row__time" aria-label={`Reminder time for ${album.name}`} value={pref.time} disabled={disabled}
              aria-describedby={reason ? 'reminders-reason' : undefined}
              onChange={(event) => { if (event.target.validity.valid && event.target.value) void save(album, pref, { time: event.target.value }) }} />
            <button type="button" className="reminder-switch" role="switch" aria-label={`Reminders for ${album.name}`} aria-checked={!reason && pref.enabled}
              disabled={disabled} aria-describedby={reason ? 'reminders-reason' : undefined} data-testid={`reminder-toggle-${album.id}`}
              onClick={() => void save(album, pref, { enabled: !pref.enabled })}><span /></button>
          </div>
        )
      })}
    </section>
  )
}
