import { api, ApiError, cacheThumbnail, photoBlob, requireUser, uploadPhoto, type User } from '../api/client.ts'
import type { Album, PhotoMeta, StoredImage } from '../core/types.ts'
import {
  listGhostRefs, listPending, putGhost, queuePhoto, readSnapshot, removeGhost,
  removePending, updatePending, writeSnapshot, type PendingPhoto, type Snapshot,
} from '../storage/local.ts'

export interface SyncState extends Snapshot { pending: PendingPhoto[]; syncing: boolean; error: string | null }
const READ_INTERRUPTED = new Error('Read interrupted')
const WAITING_FOR_CONNECTION = 'Waiting for a connection.'

export class SyncEngine {
  readonly user: User
  state: SyncState = { albums: [], photos: [], cursor: '', pending: [], syncing: false, error: null }
  private active = true
  private chain: Promise<unknown> = Promise.resolve()
  private writes = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private refreshPending = false
  private refreshRequested = false
  private uploadRequested = false
  private uploadBlocked = false
  private readController: AbortController | null = null
  private sessionController = new AbortController()
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
    this.sessionController.abort()
    this.readController?.abort(READ_INTERRUPTED)
    clearTimeout(this.retry)
    return Promise.all([this.chain, ...this.writes])
  }

  refresh(session?: ReturnType<typeof api.me>): Promise<void> {
    if (!this.active) return this.chain.then(() => undefined)
    this.refreshRequested = true
    return this.synchronize(session)
  }

  private requestUpload(): Promise<void> {
    if (!this.active || this.uploadBlocked) return this.chain.then(() => undefined)
    this.uploadRequested = true
    this.readController?.abort(READ_INTERRUPTED)
    return this.synchronize()
  }

  private async read(operation: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController()
    this.readController = controller
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(READ_INTERRUPTED), { once: true })
    })
    try { await Promise.race([operation(controller.signal), interrupted]) }
    finally { this.readController = null; controller.abort(READ_INTERRUPTED) }
  }

  private synchronize(session?: ReturnType<typeof api.me>): Promise<void> {
    if (this.refreshPending) return this.chain.then(() => undefined)
    this.refreshPending = true
    return this.run(async () => {
      this.emit({ syncing: true, error: null })
      try {
        while (this.active && (this.refreshRequested || this.uploadRequested)) {
          try {
            const pulled = !this.uploadRequested
            if (pulled) {
              this.refreshRequested = false
              const shared = session !== undefined
              const verified = requireUser(this.user.id, session ?? api.me(this.sessionController.signal), this.sessionController.signal)
              session = undefined
              await this.read(async (signal) => {
                if (!shared) await verified
                signal.throwIfAborted()
                await this.pull(verified, signal)
              })
            }
            const uploaded = await this.flushUploads()
            if (!this.active) return
            await this.read(async (signal) => {
              // A refresh that uploaded nothing already has the server's state.
              if (uploaded || !pulled) await this.pull(undefined, signal)
              await this.reconcileGhosts(signal)
            })
          } catch (error) {
            if (this.uploadRequested && error === READ_INTERRUPTED) continue
            if (error instanceof ApiError && error.code === 'user_mismatch') {
              this.emit({ error: error.message })
              this.refreshRequested = true
              continue
            }
            throw error
          }
        }
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

  private async savePhotos(photos: PhotoMeta[]) {
    if (!this.active) return
    await writeSnapshot(this.user.id, { albums: this.state.albums, photos, cursor: this.state.cursor })
    this.emit({ photos })
  }

  private async pull(verified?: Promise<void>, signal?: AbortSignal) {
    let full = !this.state.cursor
    let delta
    try { delta = (await Promise.all([api.sync(full ? undefined : this.state.cursor, signal), verified]))[0] }
    catch (error) {
      signal?.throwIfAborted()
      if (full || !(error instanceof ApiError) || error.status !== 400 || error.code !== 'invalid_cursor') throw error
      if (!this.active) return
      this.emit({ cursor: '' })
      await this.persist()
      full = true
      delta = (await Promise.all([api.sync(undefined, signal), verified]))[0]
    }
    signal?.throwIfAborted()
    if (!this.active) return
    const albums = new Map((full ? [] : this.state.albums).map((album) => [album.id, album]))
    const photos = new Map((full ? [] : this.state.photos).map((photo) => [photo.id, photo]))
    for (const album of delta.albums) albums.set(album.id, album)
    for (const photo of delta.photos) photos.set(photo.id, photo)
    for (const id of delta.removed) photos.delete(id)
    this.emit({ albums: [...albums.values()].filter((album) => album.deletedAt === null), photos: [...photos.values()], cursor: delta.cursor })
    await this.persist()
  }

  enqueue(meta: PhotoMeta, master: StoredImage, thumb: StoredImage): Promise<void> {
    if (!this.active) return Promise.reject(new Error('Please sign in again.'))
    const write = (async () => {
      await queuePhoto({ userId: this.user.id, meta, master, thumb, attempts: 0, nextAttemptAt: 0, error: null })
      this.emit({ pending: await listPending(this.user.id) })
      void this.requestUpload()
    })()
    this.writes.add(write)
    void write.then(() => this.writes.delete(write), () => this.writes.delete(write))
    return write
  }

  /** Uploads what is due; resolves to how many photos the server accepted. */
  private async flushUploads(): Promise<number> {
    let uploaded = 0
    do {
      await Promise.all(this.writes)
      this.uploadRequested = false
      uploaded += await this.flush()
    } while (this.active && this.uploadRequested)
    return uploaded
  }

  private async flush(): Promise<number> {
    let uploaded = 0
    for (const entry of await listPending(this.user.id)) {
      if (!this.active || this.uploadBlocked || entry.userId !== this.user.id) return uploaded
      if (entry.nextAttemptAt > Date.now()) continue
      try {
        const result = await uploadPhoto(entry.userId, entry.meta,
          new Blob([entry.master.bytes], { type: entry.master.mime }),
          new Blob([entry.thumb.bytes], { type: entry.thumb.mime }))
        if (!this.active) return uploaded
        uploaded++
        const replaced = new Set(result.replaced)
        const photos = this.state.photos.filter((photo) => photo.id !== result.photo.id)
          .map((photo) => replaced.has(photo.id) ? { ...photo, deletedAt: Date.now() } : photo)
        photos.push(result.photo)
        this.emit({ photos })
        await this.persist()
        await removePending(this.user.id, entry.meta.id)
        cacheThumbnail(entry.meta.id)
      } catch (error) {
        if (!this.active) return uploaded
        if (error instanceof ApiError && error.code === 'user_mismatch') {
          this.uploadBlocked = true
          this.uploadRequested = false
          throw error
        }
        if (error instanceof ApiError && error.status === 401) throw error
        const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
        const delay = error instanceof ApiError && error.status === 429
          ? Math.max(1000, error.retryAfter * 1000)
          : Math.min(300_000, 1000 * 2 ** Math.min(entry.attempts, 8))
        await updatePending({ ...entry, attempts: entry.attempts + 1,
          nextAttemptAt: permanent ? Number.MAX_SAFE_INTEGER : Date.now() + delay,
          error: error instanceof ApiError ? error.message : WAITING_FOR_CONNECTION })
      }
      this.emit({ pending: await listPending(this.user.id) })
    }
    return uploaded
  }

  private scheduleRetry() {
    clearTimeout(this.retry)
    if (!this.active || this.uploadBlocked) return
    const next = Math.min(...this.state.pending.map((entry) => entry.nextAttemptAt))
    const wait = Math.max(1000, next - Date.now())
    if (Number.isFinite(wait) && wait < 2_147_483_647) {
      this.retry = setTimeout(() => { void this.requestUpload() }, wait)
    }
  }

  /**
   * The connection is back (or the app is back in front while online): photos
   * that were only waiting for a connection upload now, not after their
   * backoff, which grows to minutes over a long offline spell. Rejected and
   * rate-limited uploads keep their schedule.
   */
  async reconnect(): Promise<void> {
    if (!this.active) return
    if (!this.uploadBlocked) {
      await this.run(async () => {
        for (const entry of await listPending(this.user.id)) {
          if (entry.error === WAITING_FOR_CONNECTION && entry.nextAttemptAt > Date.now()) await updatePending({ ...entry, nextAttemptAt: 0 })
        }
      }).catch(() => undefined)
    }
    return this.refresh()
  }

  async retryUploads(): Promise<void> {
    if (this.uploadBlocked) return this.refresh()
    const write = (async () => {
      for (const entry of await listPending(this.user.id)) await updatePending({ ...entry, nextAttemptAt: 0 })
    })()
    this.writes.add(write)
    try { await write }
    finally { this.writes.delete(write) }
    return this.requestUpload()
  }

  visiblePhotos(): PhotoMeta[] {
    return visiblePhotos(this.state)
  }

  private async reconcileGhosts(signal?: AbortSignal) {
    signal?.throwIfAborted()
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
      const blob = pending ? null : await photoBlob(photo.id, 'master', signal)
      const image = pending?.master ?? { id: photo.id, width: photo.width, height: photo.height, mime: photo.mime, bytes: await blob!.arrayBuffer() }
      signal?.throwIfAborted()
      if (this.active) await putGhost({ userId: this.user.id, albumId, capturedAt: photo.capturedAt, image })
    }
  }

  mutatePhoto(id: string, deletedAt: number | null | 'purge'): Promise<void> {
    return this.run(async () => {
      const previous = this.state.photos
      const target = this.state.photos.find((photo) => photo.id === id)
      const pending = this.state.pending.find((entry) => entry.meta.id === id || (entry.meta.albumId === target?.albumId && entry.meta.dayKey === target.dayKey))
      if (pending) throw new Error('Wait for this photo to upload before changing it.')
      if (!this.active) return
      if (deletedAt === 'purge') {
        await api.deletePhoto(this.user.id, id)
        await this.savePhotos(previous.filter((photo) => photo.id !== id))
      } else {
        const { photo } = await api.patchPhoto(this.user.id, id, deletedAt)
        await this.savePhotos(previous.map((item) => item.id === id ? photo : item))
      }
      await this.pull().catch(() => undefined)
      await this.reconcileGhosts().catch(() => undefined)
    })
  }

  emptyTrash(): Promise<number> {
    return this.run(async () => {
      const previous = this.state.photos
      const { deleted } = await api.emptyTrash(this.user.id)
      await this.savePhotos(previous.filter((photo) => photo.deletedAt === null))
      await this.pull().catch(() => undefined)
      return deleted
    })
  }

  saveAlbum(album: Album): Promise<Album> {
    return this.run(async () => {
      const { album: saved } = await api.album(this.user.id, album)
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
