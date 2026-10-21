import { api, ApiError, photoBlob, requireUser, uploadPhoto, type User } from '../api/client.ts'
import { SCHEMA_VERSION, type Album, type PhotoMeta, type StoredImage } from '../core/types.ts'
import {
  listGhostRefs, listPending, putGhost, queuePhoto, readSnapshot, removeGhost,
  removePending, updatePending, writeSnapshot, type PendingPhoto, type Snapshot,
} from '../storage/local.ts'

export interface SyncState extends Snapshot { pending: PendingPhoto[]; syncing: boolean; error: string | null }

export class SyncEngine {
  readonly user: User
  state: SyncState = { albums: [], photos: [], cursor: '', pending: [], syncing: false, error: null }
  private active = true
  private chain: Promise<unknown> = Promise.resolve()
  private writes = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private refreshPending = false
  private readonly changed: (state: SyncState) => void

  constructor(user: User, changed: (state: SyncState) => void) {
    this.user = user
    this.changed = changed
  }

  private emit(patch: Partial<SyncState> = {}) {
    if (!this.active) return
    this.state = { ...this.state, ...patch }
    this.changed(this.state)
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      if (!this.active) throw new Error('Please sign in again.')
      return operation()
    })
    this.chain = task.catch(() => undefined)
    return task
  }

  async hydrate(): Promise<void> {
    const [snapshot, pending] = await Promise.all([readSnapshot(this.user.id), listPending(this.user.id)])
    this.emit({ ...(snapshot ?? {}), pending })
  }

  stop(): Promise<unknown> {
    this.active = false
    clearTimeout(this.retry)
    return Promise.all([this.chain, ...this.writes])
  }

  refresh(): Promise<void> {
    if (this.refreshPending || !this.active) return this.chain.then(() => undefined)
    this.refreshPending = true
    return this.run(async () => {
      this.emit({ syncing: true, error: null })
      try {
        await requireUser(this.user.id)
        if (!this.active) return
        await this.pull()
        await this.flush()
        await this.pull()
        await this.reconcileGhosts()
      } catch (error) {
        this.emit({ error: error instanceof ApiError ? error.message : 'Offline. New photos wait here until you reconnect.' })
      } finally {
        this.refreshPending = false
        this.emit({ syncing: false })
        this.scheduleRetry()
      }
    }).catch(() => { this.refreshPending = false })
  }

  private async persist() {
    if (!this.active) return
    const { albums, photos, cursor } = this.state
    await writeSnapshot(this.user.id, { albums, photos, cursor })
  }

  private async pull() {
    const full = !this.state.cursor
    const delta = await api.sync(full ? undefined : this.state.cursor)
    if (!this.active) return
    const albums = new Map((full ? [] : this.state.albums).map((album) => [album.id, album]))
    const photos = new Map((full ? [] : this.state.photos).map((photo) => [photo.id, photo]))
    for (const album of delta.albums) albums.set(album.id, { ...album, schema: SCHEMA_VERSION })
    for (const photo of delta.photos) photos.set(photo.id, { ...photo, schema: SCHEMA_VERSION })
    for (const id of delta.removed) photos.delete(id)
    this.emit({ albums: [...albums.values()].filter((album) => album.deletedAt === null), photos: [...photos.values()], cursor: delta.cursor })
    await this.persist()
  }

  enqueue(meta: PhotoMeta, master: StoredImage, thumb: StoredImage): Promise<void> {
    if (!this.active) return Promise.reject(new Error('Please sign in again.'))
    const write = (async () => {
      await queuePhoto({ userId: this.user.id, meta, master, thumb, attempts: 0, nextAttemptAt: 0, error: null })
      this.emit({ pending: await listPending(this.user.id) })
      this.scheduleRetry(0)
    })()
    this.writes.add(write)
    void write.then(() => this.writes.delete(write), () => this.writes.delete(write))
    return write
  }

  private async flush() {
    for (const entry of await listPending(this.user.id)) {
      if (!this.active || entry.userId !== this.user.id) return
      if (entry.nextAttemptAt > Date.now()) continue
      try {
        await requireUser(this.user.id)
        if (!this.active) return
        const result = await uploadPhoto(entry.meta,
          new Blob([entry.master.bytes], { type: entry.master.mime }),
          new Blob([entry.thumb.bytes], { type: entry.thumb.mime }))
        if (!this.active) return
        const replaced = new Set(result.replaced)
        const photos = this.state.photos.filter((photo) => photo.id !== result.photo.id)
          .map((photo) => replaced.has(photo.id) ? { ...photo, deletedAt: Date.now() } : photo)
        photos.push({ ...result.photo, schema: SCHEMA_VERSION })
        this.emit({ photos })
        await this.persist()
        await removePending(this.user.id, entry.meta.id)
      } catch (error) {
        if (!this.active) return
        if (error instanceof ApiError && error.status === 401) throw error
        const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
        const delay = error instanceof ApiError && error.status === 429
          ? Math.max(1000, error.retryAfter * 1000)
          : Math.min(300_000, 1000 * 2 ** Math.min(entry.attempts, 8))
        await updatePending({ ...entry, attempts: entry.attempts + 1,
          nextAttemptAt: permanent ? Number.MAX_SAFE_INTEGER : Date.now() + delay,
          error: error instanceof ApiError ? error.message : 'Waiting for a connection.' })
      }
      this.emit({ pending: await listPending(this.user.id) })
    }
  }

  private scheduleRetry(delay?: number) {
    clearTimeout(this.retry)
    if (!this.active) return
    const next = Math.min(...this.state.pending.map((entry) => entry.nextAttemptAt))
    const wait = delay ?? Math.max(1000, next - Date.now())
    if (Number.isFinite(wait) && wait < 2_147_483_647) {
      this.retry = setTimeout(() => { void this.refresh() }, wait)
    }
  }

  async retryUploads(): Promise<void> {
    await this.run(async () => {
      for (const entry of await listPending(this.user.id)) await updatePending({ ...entry, nextAttemptAt: 0 })
    })
    return this.refresh()
  }

  visiblePhotos(): PhotoMeta[] {
    return visiblePhotos(this.state)
  }

  private async reconcileGhosts() {
    if (!this.active) return
    const newest = new Map<string, PhotoMeta>()
    for (const photo of this.visiblePhotos()) if (photo.deletedAt === null && !newest.has(photo.albumId)) newest.set(photo.albumId, photo)
    const ghosts = await listGhostRefs(this.user.id)
    for (const ghost of ghosts) {
      if (newest.get(ghost.albumId)?.id !== ghost.imageId) await removeGhost(this.user.id, ghost.albumId, ghost.imageId)
    }
    for (const [albumId, photo] of newest) {
      if (!this.active) return
      if (ghosts.some((ghost) => ghost.albumId === albumId && ghost.imageId === photo.id)) continue
      const pending = this.state.pending.find((entry) => entry.meta.id === photo.id)
      const blob = pending ? null : await photoBlob(photo.id, 'master')
      const image = pending?.master ?? { id: photo.id, width: photo.width, height: photo.height, mime: photo.mime, bytes: await blob!.arrayBuffer() }
      if (this.active) await putGhost({ userId: this.user.id, albumId, capturedAt: photo.capturedAt, image })
    }
  }

  mutatePhoto(id: string, deletedAt: number | null | 'purge'): Promise<void> {
    return this.run(async () => {
      const previous = this.state.photos
      const target = this.state.photos.find((photo) => photo.id === id)
      const pending = this.state.pending.find((entry) => entry.meta.id === id || (entry.meta.albumId === target?.albumId && entry.meta.dayKey === target.dayKey))
      if (pending) throw new Error('Wait for this photo to upload before changing it.')
      this.emit({ photos: deletedAt === 'purge' ? previous.filter((photo) => photo.id !== id)
        : previous.map((photo) => photo.id === id ? { ...photo, deletedAt } : photo) })
      try {
        await requireUser(this.user.id)
        if (!this.active) return
        if (deletedAt === 'purge') await api.deletePhoto(id)
        else {
          const { photo } = await api.patchPhoto(id, deletedAt)
          this.emit({ photos: this.state.photos.map((item) => item.id === id ? { ...photo, schema: SCHEMA_VERSION } : item) })
        }
      } catch (error) {
        this.emit({ photos: previous })
        throw error
      }
      await this.persist()
      await this.pull().catch(() => undefined)
      await this.reconcileGhosts().catch(() => undefined)
    })
  }

  emptyTrash(): Promise<number> {
    return this.run(async () => {
      const previous = this.state.photos
      this.emit({ photos: previous.filter((photo) => photo.deletedAt === null) })
      let deleted: number
      try { await requireUser(this.user.id); deleted = (await api.emptyTrash()).deleted }
      catch (error) { this.emit({ photos: previous }); throw error }
      await this.persist()
      await this.pull().catch(() => undefined)
      return deleted
    })
  }

  saveAlbum(album: Album): Promise<Album> {
    return this.run(async () => {
      await requireUser(this.user.id)
      const saved = { ...(await api.album(album)).album, schema: SCHEMA_VERSION }
      this.emit({ albums: [...this.state.albums.filter((item) => item.id !== saved.id), saved] })
      await this.persist()
      await this.pull().catch(() => undefined)
      return saved
    })
  }
}

export function visiblePhotos(state: SyncState): PhotoMeta[] {
    const photos = new Map(state.photos.map((photo) => [photo.id, photo]))
    for (const entry of state.pending) {
      for (const photo of photos.values()) {
        if (photo.deletedAt === null && photo.albumId === entry.meta.albumId && photo.dayKey === entry.meta.dayKey) {
          photos.set(photo.id, { ...photo, deletedAt: entry.meta.capturedAt })
        }
      }
      photos.set(entry.meta.id, entry.meta)
    }
    return [...photos.values()].sort((a, b) => b.capturedAt - a.capturedAt || b.id.localeCompare(a.id))
}
