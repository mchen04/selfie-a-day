import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CaptureResult } from '../camera/capture.ts'
import { defaultAlbum } from '../core/albums.ts'
import { DEFAULT_SETTINGS, type Album, type PhotoMeta, type Settings } from '../core/types.ts'
import {
  createAlbum as createAlbumRecord,
  ensureDefaultAlbum,
  listAlbums,
  updateAlbum as updateAlbumRecord,
} from '../storage/albums.ts'
import {
  deletePhotoPermanently as deletePhotoPermanentlyRecord,
  emptyTrash as emptyTrashRecords,
  listMeta,
  purgeExpiredTrash,
  putPhoto,
  restorePhoto as restorePhotoRecord,
  trashPhoto as trashPhotoRecord,
} from '../storage/photos.ts'
import { loadSettings, saveSettings } from '../storage/settings.ts'
import { AppContext, type AppContextValue, type AppState } from './store-context.ts'

function activeMetas(allMetas: readonly PhotoMeta[], albumId: string): PhotoMeta[] {
  return allMetas.filter((meta) => meta.albumId === albumId)
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    status: 'loading',
    storageError: null,
    metas: [],
    allMetas: [],
    trashedMetas: [],
    undoTrash: null,
    albums: [defaultAlbum()],
    activeAlbum: defaultAlbum(),
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
      await purgeExpiredTrash()
      const [allMetas, trashedMetas, loadedAlbums, loadedSettings] = await Promise.all([
        listMeta(),
        listMeta({ onlyDeleted: true }),
        listAlbums(),
        loadSettings(),
      ])
      const albums = loadedAlbums.length > 0 ? loadedAlbums : [await ensureDefaultAlbum()]
      const activeAlbum =
        albums.find((album) => album.id === loadedSettings.activeAlbumId) ?? albums[0]!
      const settings =
        activeAlbum.id === loadedSettings.activeAlbumId
          ? loadedSettings
          : { ...loadedSettings, activeAlbumId: activeAlbum.id }
      settingsRef.current = settings
      setState({
        status: 'ready',
        storageError: null,
        metas: activeMetas(allMetas, activeAlbum.id),
        allMetas,
        trashedMetas,
        undoTrash: null,
        albums,
        activeAlbum,
        settings,
      })
      if (settings !== loadedSettings) await saveSettings(settings)
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
    const [allMetas, trashedMetas] = await Promise.all([
      listMeta(),
      listMeta({ onlyDeleted: true }),
    ])
    setState((prev) => ({
      ...prev,
      metas: activeMetas(allMetas, prev.activeAlbum.id),
      allMetas,
      trashedMetas,
      storageError: null,
    }))
  }, [])

  const trashPhoto = useCallback(async (id: string) => {
    const trashed = await trashPhotoRecord(id)
    const [allMetas, trashedMetas] = await Promise.all([
      listMeta(),
      listMeta({ onlyDeleted: true }),
    ])
    setState((prev) => ({
      ...prev,
      metas: activeMetas(allMetas, prev.activeAlbum.id),
      allMetas,
      trashedMetas,
      undoTrash: trashed,
    }))
  }, [])

  const restorePhoto = useCallback(async (id: string) => {
    await restorePhotoRecord(id)
    const [allMetas, trashedMetas] = await Promise.all([
      listMeta(),
      listMeta({ onlyDeleted: true }),
    ])
    setState((prev) => ({
      ...prev,
      metas: activeMetas(allMetas, prev.activeAlbum.id),
      allMetas,
      trashedMetas,
      undoTrash: prev.undoTrash?.id === id ? null : prev.undoTrash,
    }))
  }, [])

  const deletePhotoPermanently = useCallback(async (id: string) => {
    await deletePhotoPermanentlyRecord(id)
    const trashedMetas = await listMeta({ onlyDeleted: true })
    setState((prev) => ({
      ...prev,
      trashedMetas,
      undoTrash: prev.undoTrash?.id === id ? null : prev.undoTrash,
    }))
  }, [])

  const emptyTrash = useCallback(async (): Promise<number> => {
    const removed = await emptyTrashRecords()
    setState((prev) => ({ ...prev, trashedMetas: [], undoTrash: null }))
    return removed
  }, [])

  const dismissUndo = useCallback(() => {
    setState((prev) => ({ ...prev, undoTrash: null }))
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const previous = settingsRef.current
    const next: Settings = { ...previous, ...patch }
    settingsRef.current = next
    setState((prev) => {
      const activeAlbum =
        prev.albums.find((album) => album.id === next.activeAlbumId) ?? prev.activeAlbum
      return {
        ...prev,
        settings: next,
        activeAlbum,
        metas: activeMetas(prev.allMetas, activeAlbum.id),
      }
    })

    try {
      await saveSettings(next)
    } catch (err) {
      // Every call site fires this without awaiting, so a silent failure would
      // leave the screen showing a setting that is not on disk and will not
      // survive a reload. Snapping the control back is the honest signal.
      settingsRef.current = previous
      setState((prev) => {
        const activeAlbum =
          prev.albums.find((album) => album.id === previous.activeAlbumId) ?? prev.activeAlbum
        return {
          ...prev,
          settings: previous,
          activeAlbum,
          metas: activeMetas(prev.allMetas, activeAlbum.id),
        }
      })
      throw err
    }
  }, [])

  const selectAlbum = useCallback(
    async (id: string) => {
      await updateSettings({ activeAlbumId: id })
    },
    [updateSettings],
  )

  const createAlbum = useCallback(
    async (name: string): Promise<Album> => {
      const album = await createAlbumRecord(name)
      setState((prev) => ({ ...prev, albums: [...prev.albums, album] }))
      await updateSettings({ activeAlbumId: album.id })
      return album
    },
    [updateSettings],
  )

  const updateAlbum = useCallback(
    async (
      id: string,
      patch: { name?: string; timeZone?: string | null },
    ): Promise<Album> => {
      const album = await updateAlbumRecord(id, patch)
      setState((prev) => ({
        ...prev,
        albums: prev.albums.map((item) => (item.id === id ? album : item)),
        activeAlbum: prev.activeAlbum.id === id ? album : prev.activeAlbum,
      }))
      return album
    },
    [],
  )

  const value = useMemo<AppContextValue>(
    () => ({
      ...state,
      actions: {
        savePhoto,
        trashPhoto,
        restorePhoto,
        deletePhotoPermanently,
        emptyTrash,
        dismissUndo,
        selectAlbum,
        createAlbum,
        updateAlbum,
        updateSettings,
        reload,
      },
    }),
    [
      state,
      savePhoto,
      trashPhoto,
      restorePhoto,
      deletePhotoPermanently,
      emptyTrash,
      dismissUndo,
      selectAlbum,
      createAlbum,
      updateAlbum,
      updateSettings,
      reload,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
