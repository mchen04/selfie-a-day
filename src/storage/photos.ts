import { DEFAULT_ALBUM_ID, SCHEMA_VERSION, type PhotoMeta, type StoredImage } from '../core/types.ts'
import {
  INDEX_ALBUM_DAY,
  INDEX_CAPTURED_AT,
  STORE_MASTERS,
  STORE_META,
  STORE_PHOTOS,
  STORE_THUMBS,
  promisifyRequest,
  withTransaction,
} from './db.ts'

export interface PhotoWrite {
  meta: PhotoMeta
  master: StoredImage
  thumb: StoredImage
}

const ALL_PHOTO_STORES = [STORE_PHOTOS, STORE_THUMBS, STORE_MASTERS]
export const TRASH_RETENTION_MS = 30 * 86_400_000

function normalizeMeta(meta: PhotoMeta): PhotoMeta {
  return {
    ...meta,
    albumId: typeof meta.albumId === 'string' && meta.albumId ? meta.albumId : DEFAULT_ALBUM_ID,
    timeZone: typeof meta.timeZone === 'string' ? meta.timeZone : null,
    deletedAt: typeof meta.deletedAt === 'number' ? meta.deletedAt : null,
    schema: SCHEMA_VERSION,
  }
}

/** Photo metadata newest first, optionally scoped to one album or the trash. */
export async function listMeta(
  options: { albumId?: string; includeDeleted?: boolean; onlyDeleted?: boolean } = {},
): Promise<PhotoMeta[]> {
  return withTransaction(STORE_PHOTOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_PHOTOS).index(INDEX_CAPTURED_AT)
    const rows = await promisifyRequest(index.getAll() as IDBRequest<PhotoMeta[]>)
    const filtered = rows
      .reverse()
      .map(normalizeMeta)
      .filter((meta) => {
        if (options.albumId && meta.albumId !== options.albumId) return false
        if (options.onlyDeleted) return meta.deletedAt !== null
        return options.includeDeleted || meta.deletedAt === null
      })
    if (options.onlyDeleted) {
      filtered.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
    }
    return filtered
  })
}

export async function getMeta(id: string): Promise<PhotoMeta | null> {
  return withTransaction(STORE_PHOTOS, 'readonly', async (tx) => {
    const row = await promisifyRequest(
      tx.objectStore(STORE_PHOTOS).get(id) as IDBRequest<PhotoMeta | undefined>,
    )
    return row ? normalizeMeta(row) : null
  })
}

export async function getMaster(id: string): Promise<StoredImage | null> {
  return withTransaction(STORE_MASTERS, 'readonly', async (tx) => {
    const row = await promisifyRequest(
      tx.objectStore(STORE_MASTERS).get(id) as IDBRequest<StoredImage | undefined>,
    )
    return row ?? null
  })
}

export async function getThumb(id: string): Promise<StoredImage | null> {
  return withTransaction(STORE_THUMBS, 'readonly', async (tx) => {
    const row = await promisifyRequest(
      tx.objectStore(STORE_THUMBS).get(id) as IDBRequest<StoredImage | undefined>,
    )
    return row ?? null
  })
}

/**
 * Write one photo inside an open transaction, superseding that day's existing
 * photo if there is one.
 *
 * One photo per day is the product's premise, so a re-take supersedes rather
 * than accumulates, and the delete happens in the same transaction as the write
 * — there is no instant where the day has no photo.
 */
async function writeInto(
  tx: IDBTransaction,
  write: PhotoWrite,
  options: { keepNewer?: boolean } = {},
): Promise<boolean> {
  const photos = tx.objectStore(STORE_PHOTOS)
  const normalized = { ...write, meta: normalizeMeta(write.meta) }
  const existing = (await promisifyRequest(
    photos.index(INDEX_ALBUM_DAY).getAll([normalized.meta.albumId, normalized.meta.dayKey]),
  )) as PhotoMeta[]
  const active = existing.map(normalizeMeta).filter((meta) => meta.deletedAt === null)

  // A restore must never overwrite work done after the backup was taken.
  // Deleting one photo asks for a two-tap confirm; a restore could otherwise
  // destroy an unbounded number of them behind a single tap and a green toast.
  if (
    options.keepNewer &&
    active.some((e) => e.id !== normalized.meta.id && e.capturedAt > normalized.meta.capturedAt)
  ) {
    return false
  }

  for (const previous of active) {
    if (previous.id === normalized.meta.id) continue
    photos.delete(previous.id)
    tx.objectStore(STORE_THUMBS).delete(previous.id)
    tx.objectStore(STORE_MASTERS).delete(previous.id)
  }

  photos.put(normalized.meta)
  tx.objectStore(STORE_THUMBS).put(normalized.thumb)
  tx.objectStore(STORE_MASTERS).put(normalized.master)
  return true
}

/** Persist a capture atomically, replacing any existing photo for the same day. */
export async function putPhoto(write: PhotoWrite): Promise<void> {
  await withTransaction(ALL_PHOTO_STORES, 'readwrite', (tx) => writeInto(tx, write))
}

/**
 * Bulk write for import. Returns the ids actually written.
 *
 * With `keepNewer`, a photo already on the device that was taken *after* the
 * one being written wins, and its id is absent from the result — so the caller
 * can tell the user what was kept rather than silently discarding their work.
 */
export async function putPhotos(
  writes: readonly PhotoWrite[],
  options: { keepNewer?: boolean } = {},
): Promise<string[]> {
  if (writes.length === 0) return []
  return withTransaction(ALL_PHOTO_STORES, 'readwrite', async (tx) => {
    const written: string[] = []
    for (const write of writes) {
      if (await writeInto(tx, write, options)) written.push(write.meta.id)
    }
    return written
  })
}

export async function deletePhoto(id: string): Promise<void> {
  return withTransaction(ALL_PHOTO_STORES, 'readwrite', (tx) => {
    deletePermanentlyIn(tx, id)
  })
}

function deletePermanentlyIn(tx: IDBTransaction, id: string): void {
  tx.objectStore(STORE_PHOTOS).delete(id)
  tx.objectStore(STORE_THUMBS).delete(id)
  tx.objectStore(STORE_MASTERS).delete(id)
}

export async function trashPhoto(id: string, deletedAt: number = Date.now()): Promise<PhotoMeta> {
  return withTransaction(STORE_PHOTOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PHOTOS)
    const row = await promisifyRequest(store.get(id) as IDBRequest<PhotoMeta | undefined>)
    if (!row) throw new Error('That photo no longer exists.')
    const meta = { ...normalizeMeta(row), deletedAt }
    store.put(meta)
    return meta
  })
}

export async function restorePhoto(id: string): Promise<PhotoMeta> {
  return withTransaction(STORE_PHOTOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PHOTOS)
    const row = await promisifyRequest(store.get(id) as IDBRequest<PhotoMeta | undefined>)
    if (!row) throw new Error('That photo is no longer in Trash.')
    const meta = normalizeMeta(row)
    if (meta.deletedAt === null) return meta

    const sameDay = (await promisifyRequest(
      store.index(INDEX_ALBUM_DAY).getAll([meta.albumId, meta.dayKey]),
    )) as PhotoMeta[]
    if (sameDay.some((photo) => photo.id !== id && normalizeMeta(photo).deletedAt === null)) {
      throw new Error('This album already has a photo for that day. Move it to Trash first.')
    }

    const restored = { ...meta, deletedAt: null }
    store.put(restored)
    return restored
  })
}

export async function deletePhotoPermanently(id: string): Promise<void> {
  await deletePhoto(id)
}

export async function emptyTrash(): Promise<number> {
  return withTransaction(ALL_PHOTO_STORES, 'readwrite', async (tx) => {
    const rows = (await promisifyRequest(
      tx.objectStore(STORE_PHOTOS).getAll() as IDBRequest<PhotoMeta[]>,
    ))
      .map(normalizeMeta)
      .filter((meta) => meta.deletedAt !== null)
    for (const meta of rows) deletePermanentlyIn(tx, meta.id)
    return rows.length
  })
}

export async function purgeExpiredTrash(now: number = Date.now()): Promise<number> {
  const cutoff = now - TRASH_RETENTION_MS
  return withTransaction(ALL_PHOTO_STORES, 'readwrite', async (tx) => {
    const rows = (await promisifyRequest(
      tx.objectStore(STORE_PHOTOS).getAll() as IDBRequest<PhotoMeta[]>,
    ))
      .map(normalizeMeta)
      .filter((meta) => meta.deletedAt !== null && meta.deletedAt <= cutoff)
    for (const meta of rows) deletePermanentlyIn(tx, meta.id)
    return rows.length
  })
}

/** Wipe photos but keep settings. Used by "delete everything" in Settings. */
export async function deleteAllPhotos(): Promise<void> {
  return withTransaction(ALL_PHOTO_STORES, 'readwrite', (tx) => {
    for (const store of ALL_PHOTO_STORES) tx.objectStore(store).clear()
  })
}

export async function readMetaValue<T>(key: string): Promise<T | null> {
  return withTransaction(STORE_META, 'readonly', async (tx) => {
    const row = await promisifyRequest(tx.objectStore(STORE_META).get(key) as IDBRequest<T | undefined>)
    return row ?? null
  })
}

export async function writeMetaValue(key: string, value: unknown): Promise<void> {
  return withTransaction(STORE_META, 'readwrite', (tx) => {
    tx.objectStore(STORE_META).put(value, key)
  })
}
