import type { User } from '../api/client.ts'
import type { Album, PhotoMeta, StoredImage } from '../core/types.ts'
import { promisifyRequest, STORE_GHOSTS, STORE_META, STORE_OUTBOX, withTransaction } from './db.ts'

export interface Snapshot { albums: Album[]; photos: PhotoMeta[]; cursor: string }
export interface PendingPhoto {
  userId: string
  meta: PhotoMeta
  master: StoredImage
  thumb: StoredImage
  attempts: number
  nextAttemptAt: number
  error: string | null
}
export interface Ghost { userId: string; albumId: string; capturedAt: number; image: StoredImage }
export const MAX_PENDING = 20

export function readValue<T>(key: string): Promise<T | null> {
  return withTransaction(STORE_META, 'readonly', async (tx) =>
    (await promisifyRequest(tx.objectStore(STORE_META).get(key) as IDBRequest<T | undefined>)) ?? null)
}

export function writeValue(key: string, value: unknown): Promise<void> {
  return withTransaction(STORE_META, 'readwrite', (tx) => { tx.objectStore(STORE_META).put(value, key) })
}

export const userKey = (userId: string, key: string) => `user:${userId}:${key}`
export const cachedUser = () => readValue<User>('user')
export const cacheUser = (user: User) => writeValue('user', { id: user.id, username: user.username })
export const forgetCachedUser = () => withTransaction(STORE_META, 'readwrite', (tx) => { tx.objectStore(STORE_META).delete('user') })
export const readSnapshot = (userId: string) => readValue<Snapshot>(userKey(userId, 'snapshot'))
export const writeSnapshot = (userId: string, snapshot: Snapshot) => writeValue(userKey(userId, 'snapshot'), snapshot)

export async function listPending(userId: string): Promise<PendingPhoto[]> {
  return withTransaction(STORE_OUTBOX, 'readonly', async (tx) => {
    const rows = await promisifyRequest(tx.objectStore(STORE_OUTBOX).index('by_user').getAll(userId) as IDBRequest<PendingPhoto[]>)
    return rows.filter((row) => row.userId === userId).sort((a, b) => a.meta.capturedAt - b.meta.capturedAt)
  })
}

export const getPending = (userId: string, id: string) => withTransaction(STORE_OUTBOX, 'readonly', async (tx) =>
  (await promisifyRequest(tx.objectStore(STORE_OUTBOX).get([userId, id]) as IDBRequest<PendingPhoto | undefined>)) ?? null)

export async function queuePhoto(photo: PendingPhoto): Promise<void> {
  return withTransaction([STORE_OUTBOX, STORE_GHOSTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_OUTBOX)
    const count = await promisifyRequest(store.index('by_user').count(photo.userId))
    if (count >= MAX_PENDING) {
      throw new Error('Twenty photos are waiting. Connect to upload them before taking more.')
    }
    store.put(photo)
    const ghosts = tx.objectStore(STORE_GHOSTS)
    const previous = await promisifyRequest(ghosts.get([photo.userId, photo.meta.albumId]) as IDBRequest<Ghost | undefined>)
    if (!previous || previous.capturedAt <= photo.meta.capturedAt) ghosts.put({ userId: photo.userId, albumId: photo.meta.albumId, capturedAt: photo.meta.capturedAt, image: photo.master } satisfies Ghost)
  })
}

export const updatePending = (photo: PendingPhoto) => withTransaction(STORE_OUTBOX, 'readwrite', (tx) => {
  tx.objectStore(STORE_OUTBOX).put(photo)
})
export const removePending = (userId: string, id: string) => withTransaction(STORE_OUTBOX, 'readwrite', (tx) => {
  tx.objectStore(STORE_OUTBOX).delete([userId, id])
})

export const listGhosts = (userId: string) => withTransaction(STORE_GHOSTS, 'readonly', async (tx) => {
  const ghosts = await promisifyRequest(tx.objectStore(STORE_GHOSTS).index('by_user').getAll(userId) as IDBRequest<Ghost[]>)
  return ghosts.filter((ghost) => ghost.userId === userId)
})
export const listGhostRefs = (userId: string) => withTransaction(STORE_GHOSTS, 'readonly', (tx) =>
  new Promise<Array<{ albumId: string; imageId: string }>>((resolve, reject) => {
    const rows: Array<{ albumId: string; imageId: string }> = []
    const request = tx.objectStore(STORE_GHOSTS).index('by_image').openKeyCursor(IDBKeyRange.bound([userId, ''], [userId, '\uffff']))
    request.onerror = () => reject(request.error ?? new Error('Could not read ghosts.'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(rows); return }
      rows.push({ albumId: (cursor.primaryKey as string[])[1]!, imageId: (cursor.key as string[])[1]! })
      cursor.continue()
    }
  }))
export const putGhost = (ghost: Ghost) => withTransaction(STORE_GHOSTS, 'readwrite', async (tx) => {
  const store = tx.objectStore(STORE_GHOSTS)
  const previous = await promisifyRequest(store.get([ghost.userId, ghost.albumId]) as IDBRequest<Ghost | undefined>)
  if (!previous || previous.capturedAt <= ghost.capturedAt) store.put(ghost)
})
export const removeGhost = (userId: string, albumId: string, expectedId: string) => withTransaction(STORE_GHOSTS, 'readwrite', async (tx) => {
  const store = tx.objectStore(STORE_GHOSTS)
  const current = await promisifyRequest(store.get([userId, albumId]) as IDBRequest<Ghost | undefined>)
  if (current?.image.id === expectedId) store.delete([userId, albumId])
})

export async function localImage(userId: string, id: string, kind: 'master' | 'thumb'): Promise<StoredImage | null> {
  const pending = await getPending(userId, id)
  if (pending) return pending[kind]
  if (kind === 'thumb') return null
  return withTransaction(STORE_GHOSTS, 'readonly', async (tx) =>
    (await promisifyRequest(tx.objectStore(STORE_GHOSTS).index('by_image').get([userId, id]) as IDBRequest<Ghost | undefined>))?.image ?? null)
}

export async function clearUserData(userId: string): Promise<void> {
  await withTransaction([STORE_META, STORE_OUTBOX, STORE_GHOSTS], 'readwrite', async (tx) => {
    const kv = tx.objectStore(STORE_META)
    const keys = await promisifyRequest(kv.getAllKeys())
    for (const key of keys) if (typeof key === 'string' && key.startsWith(`user:${userId}:`)) kv.delete(key)
    const user = await promisifyRequest(kv.get('user') as IDBRequest<User | undefined>)
    if (user?.id === userId) kv.delete('user')
    for (const name of [STORE_OUTBOX, STORE_GHOSTS]) {
      const store = tx.objectStore(name)
      const rowKeys = await promisifyRequest(store.getAllKeys())
      for (const key of rowKeys) if (Array.isArray(key) && key[0] === userId) store.delete(key)
    }
  })
}
