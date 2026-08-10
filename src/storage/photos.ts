import type { PhotoMeta, StoredImage } from '../core/types.ts'
import {
  INDEX_CAPTURED_AT,
  INDEX_DAY,
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

/** Every photo's metadata, newest first. */
export async function listMeta(): Promise<PhotoMeta[]> {
  return withTransaction(STORE_PHOTOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_PHOTOS).index(INDEX_CAPTURED_AT)
    const rows = await promisifyRequest(index.getAll() as IDBRequest<PhotoMeta[]>)
    return rows.reverse()
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
  const existing = (await promisifyRequest(
    photos.index(INDEX_DAY).getAll(write.meta.dayKey),
  )) as PhotoMeta[]

  // A restore must never overwrite work done after the backup was taken.
  // Deleting one photo asks for a two-tap confirm; a restore could otherwise
  // destroy an unbounded number of them behind a single tap and a green toast.
  if (
    options.keepNewer &&
    existing.some((e) => e.id !== write.meta.id && e.capturedAt > write.meta.capturedAt)
  ) {
    return false
  }

  for (const previous of existing) {
    if (previous.id === write.meta.id) continue
    photos.delete(previous.id)
    tx.objectStore(STORE_THUMBS).delete(previous.id)
    tx.objectStore(STORE_MASTERS).delete(previous.id)
  }

  photos.put(write.meta)
  tx.objectStore(STORE_THUMBS).put(write.thumb)
  tx.objectStore(STORE_MASTERS).put(write.master)
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
    tx.objectStore(STORE_PHOTOS).delete(id)
    tx.objectStore(STORE_THUMBS).delete(id)
    tx.objectStore(STORE_MASTERS).delete(id)
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
