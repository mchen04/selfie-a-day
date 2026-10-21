import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, onSignedOut, type User } from '../api/client.ts'
import type { CaptureResult } from '../camera/capture.ts'
import { defaultAlbum, makeAlbum } from '../core/albums.ts'
import { DEFAULT_SETTINGS, type Album, type Settings } from '../core/types.ts'
import { cacheUser, cachedUser, clearUserData, forgetCachedUser } from '../storage/local.ts'
import { loadSettings, saveSettings } from '../storage/settings.ts'
import { SyncEngine, visiblePhotos, type SyncState } from '../sync/engine.ts'
import { AppContext, type AppContextValue } from './store-context.ts'

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'signed-out'>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [sync, setSync] = useState<SyncState | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [undoTrash, setUndoTrash] = useState<AppContextValue['undoTrash']>(null)
  const engine = useRef<SyncEngine | null>(null)
  const settingsRef = useRef(DEFAULT_SETTINGS)
  const clearing = useRef<Promise<void> | null>(null)

  const clearSession = useCallback(async (discard = false) => {
    if (clearing.current) return clearing.current
    const current = engine.current
    engine.current = null
    setUser(null)
    setSync(null)
    setUndoTrash(null)
    setStatus('loading')
    setSettings(DEFAULT_SETTINGS)
    settingsRef.current = DEFAULT_SETTINGS
    const task = (async () => {
      if (current) {
        await current.stop()
        if (discard) await clearUserData(current.user.id)
      }
      await forgetCachedUser()
      for (const key of Object.keys(localStorage)) if (key.startsWith('sad.camera.')) localStorage.removeItem(key)
    })()
    clearing.current = task
    try { await task; setStatus('signed-out') }
    catch (error) { setStorageError('Could not clear device storage. Reload to try again.'); setStatus('error'); throw error }
    finally { if (clearing.current === task) clearing.current = null }
  }, [])

  const openAccount = useCallback(async (nextUser: User) => {
    await clearing.current
    if (engine.current?.user.id === nextUser.id) return
    const old = engine.current
    if (old) await old.stop()
    const next = new SyncEngine(nextUser, setSync)
    engine.current = next
    await cacheUser(nextUser)
    const prefs = await loadSettings(nextUser.id)
    if (engine.current !== next) return
    settingsRef.current = prefs
    setSettings(prefs)
    await next.hydrate()
    if (engine.current !== next) return
    setUser(nextUser)
    setStorageError(null)
    setStatus('ready')
    void next.refresh()
  }, [])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = onSignedOut(() => { if (!cancelled) void clearSession().catch(() => undefined) })
    void (async () => {
      try {
        const cached = await cachedUser()
        if (cancelled) return
        if (cached) await openAccount(cached)
        try {
          const { user: current } = await api.me()
          if (!cancelled) await openAccount(current)
        } catch (error) {
          if (cancelled) return
          if (error instanceof ApiError && error.status === 401) return
          if (!cached) { setStatus('signed-out'); setStorageError('Connect to sign in. Your saved photos stay in your account.') }
        }
      } catch (error) {
        if (!cancelled) { setStatus('error'); setStorageError(error instanceof Error ? error.message : 'Could not open device storage.') }
      }
    })()
    const refresh = () => { if (!document.hidden) void engine.current?.refresh() }
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      void engine.current?.stop()
      engine.current = null
    }
  }, [clearSession, openAccount])

  const currentEngine = useCallback(() => {
    if (!engine.current) throw new Error('Please sign in again.')
    return engine.current
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const current = currentEngine()
    const previous = settingsRef.current
    const next = { ...previous, ...patch }
    settingsRef.current = next
    setSettings(next)
    try { await saveSettings(next, current.user.id) }
    catch (error) { settingsRef.current = previous; setSettings(previous); throw error }
  }, [currentEngine])

  const savePhoto = useCallback(async (result: CaptureResult) => {
    await currentEngine().enqueue(result.meta, result.master, result.thumb)
  }, [currentEngine])

  const logout = useCallback(async () => {
    const current = currentEngine()
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager?.getSubscription()
      if (subscription) {
        await api.removeSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
    }
    await api.logout()
    if (engine.current === current) await clearSession(true)
  }, [clearSession, currentEngine])

  const actions = useMemo<AppContextValue['actions']>(() => ({
    savePhoto, updateSettings,
    signIn: async (username, password, create) => {
      const response = await (create ? api.signup(username, password) : api.login(username, password))
      await openAccount(response.user)
    },
    logout,
    retrySync: () => currentEngine().retryUploads(),
    reload: () => currentEngine().refresh(),
    selectAlbum: (id) => updateSettings({ activeAlbumId: id }),
    createAlbum: async (name) => {
      const album = await currentEngine().saveAlbum(makeAlbum(name))
      await updateSettings({ activeAlbumId: album.id })
      return album
    },
    updateAlbum: async (id, patch) => {
      const album = currentEngine().state.albums.find((item) => item.id === id)
      if (!album) throw new Error('This album is no longer available.')
      return currentEngine().saveAlbum({ ...album, ...patch })
    },
    trashPhoto: async (id) => {
      const current = currentEngine()
      const photo = current.state.photos.find((item) => item.id === id)
      await current.mutatePhoto(id, Date.now())
      setUndoTrash(photo ? { ...photo, deletedAt: Date.now() } : null)
    },
    restorePhoto: async (id) => { await currentEngine().mutatePhoto(id, null); setUndoTrash(null) },
    deletePhotoPermanently: (id) => currentEngine().mutatePhoto(id, 'purge'),
    emptyTrash: () => currentEngine().emptyTrash(),
    dismissUndo: () => setUndoTrash(null),
  }), [savePhoto, updateSettings, openAccount, logout, currentEngine])

  const value = useMemo<AppContextValue>(() => {
    const albums: Album[] = sync?.albums ?? []
    const activeAlbum = albums.find((album) => album.id === settings.activeAlbumId) ?? albums[0] ?? defaultAlbum()
    const photos = sync ? visiblePhotos(sync) : []
    const allMetas = photos.filter((photo) => photo.deletedAt === null)
    return {
      status, user, storageError, settings, actions, albums, activeAlbum, allMetas, undoTrash,
      metas: allMetas.filter((photo) => photo.albumId === activeAlbum.id),
      trashedMetas: photos.filter((photo) => photo.deletedAt !== null),
      pendingIds: sync?.pending.map((entry) => entry.meta.id) ?? [],
      syncing: sync?.syncing ?? false,
      syncError: sync?.pending.find((entry) => entry.error)?.error ?? sync?.error ?? null,
    }
  }, [status, user, storageError, settings, actions, sync, undoTrash])
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
