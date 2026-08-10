import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CaptureResult } from '../camera/capture.ts'
import { DEFAULT_SETTINGS, type Settings } from '../core/types.ts'
import { deletePhoto, listMeta, putPhoto } from '../storage/photos.ts'
import { loadSettings, saveSettings } from '../storage/settings.ts'
import { AppContext, type AppContextValue, type AppState } from './store-context.ts'

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    status: 'loading',
    storageError: null,
    metas: [],
    settings: DEFAULT_SETTINGS,
  })

  /**
   * The authoritative settings value for writes.
   *
   * Persistence must not read its value out of a `setState` updater. React only
   * runs an updater synchronously on the eager-state path — when the hook has no
   * queued work — so a second call arriving before the first commits would run
   * its updater later, and the value written to disk would be whatever the
   * variable held beforehand. With `DEFAULT_SETTINGS` as that initial value the
   * failure is silent and severe: `onboardingCompleteAt` goes back to null and
   * the user is dumped into onboarding on next launch.
   *
   * Merging against a ref makes the persisted value deterministic and identical
   * to the rendered one, and keeps the updater pure.
   */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)

  const reload = useCallback(async () => {
    try {
      const [metas, settings] = await Promise.all([listMeta(), loadSettings()])
      settingsRef.current = settings
      setState({ status: 'ready', storageError: null, metas, settings })
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        storageError:
          err instanceof Error ? err.message : 'Photo storage could not be opened on this device.',
      }))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const savePhoto = useCallback(async (result: CaptureResult) => {
    await putPhoto({ meta: result.meta, master: result.master, thumb: result.thumb })
    // Re-read rather than splice locally: the write may have replaced an
    // existing photo for the same day, and the store is the authority on that.
    const metas = await listMeta()
    setState((prev) => ({ ...prev, metas, storageError: null }))
  }, [])

  const removePhoto = useCallback(async (id: string) => {
    await deletePhoto(id)
    const metas = await listMeta()
    setState((prev) => ({ ...prev, metas }))
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const previous = settingsRef.current
    const next: Settings = { ...previous, ...patch }
    settingsRef.current = next
    setState((prev) => ({ ...prev, settings: next }))

    try {
      await saveSettings(next)
    } catch (err) {
      // Every call site fires this without awaiting, so a silent failure would
      // leave the screen showing a setting that is not on disk and will not
      // survive a reload. Snapping the control back is the honest signal.
      settingsRef.current = previous
      setState((prev) => ({ ...prev, settings: previous }))
      throw err
    }
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({ ...state, actions: { savePhoto, removePhoto, updateSettings, reload } }),
    [state, savePhoto, removePhoto, updateSettings, reload],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
