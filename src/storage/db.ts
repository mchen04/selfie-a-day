/**
 * IndexedDB access and the schema migration ladder.
 *
 * Storage layout — stores split by read cost rather than by entity:
 *
 *   photos   metadata only, ~150 bytes each. The timeline reads all of it.
 *   thumbs   small previews, read lazily per visible cell.
 *   masters  full-size bytes, read only for a single photo, the ghost, or export.
 *   albums   tiny records that define independent daily journeys.
 *
 * A capture writes all three inside one transaction, so a photo is either fully
 * present or fully absent; there is no state where the timeline shows a cell
 * that cannot be opened.
 */

import { defaultAlbum } from '../core/albums.ts'
import { DEFAULT_ALBUM_ID, SCHEMA_VERSION, type PhotoMeta } from '../core/types.ts'

export const DB_NAME = 'selfie-a-day'
export const DB_VERSION = 2

export const STORE_PHOTOS = 'photos'
export const STORE_THUMBS = 'thumbs'
export const STORE_MASTERS = 'masters'
export const STORE_META = 'meta'
export const STORE_ALBUMS = 'albums'

export const INDEX_DAY = 'by_day'
export const INDEX_CAPTURED_AT = 'by_capturedAt'
export const INDEX_ALBUM_DAY = 'by_album_day'
export const INDEX_ALBUM_CREATED_AT = 'by_album_createdAt'

/**
 * Migration `i` upgrades a database at version `i` to version `i + 1`.
 * Never edit a shipped entry — append a new one. An installed PWA can be many
 * versions behind, and the ladder is the only thing that gets it home.
 */
type Migration = (db: IDBDatabase, tx: IDBTransaction) => void

const MIGRATIONS: readonly Migration[] = [
  // 0 -> 1: initial schema.
  (db) => {
    const photos = db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' })
    // Non-unique on purpose: one photo per day is a product rule enforced in the
    // repository, not a schema rule. Keeping it loose leaves room to allow more
    // than one per day later without a destructive migration.
    photos.createIndex(INDEX_DAY, 'dayKey', { unique: false })
    photos.createIndex(INDEX_CAPTURED_AT, 'capturedAt', { unique: false })

    db.createObjectStore(STORE_THUMBS, { keyPath: 'id' })
    db.createObjectStore(STORE_MASTERS, { keyPath: 'id' })
    db.createObjectStore(STORE_META)
  },
  // 1 -> 2: split the original single timeline into a default album.
  (db, tx) => {
    const albums = db.createObjectStore(STORE_ALBUMS, { keyPath: 'id' })
    albums.createIndex(INDEX_ALBUM_CREATED_AT, 'createdAt', { unique: false })
    albums.put(defaultAlbum())

    const photos = tx.objectStore(STORE_PHOTOS)
    photos.createIndex(INDEX_ALBUM_DAY, ['albumId', 'dayKey'], { unique: false })

    const request = photos.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const previous = cursor.value as Partial<PhotoMeta>
      cursor.update({
        ...previous,
        albumId: DEFAULT_ALBUM_ID,
        timeZone: null,
        deletedAt: null,
        schema: SCHEMA_VERSION,
      })
      cursor.continue()
    }
  },
]

if (MIGRATIONS.length !== DB_VERSION) {
  throw new Error(
    `Schema ladder is inconsistent: DB_VERSION=${DB_VERSION} but ${MIGRATIONS.length} migrations exist.`,
  )
}

export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError'
}

export class StorageFullError extends Error {
  override name = 'StorageFullError'
}

/**
 * Turn a raw IndexedDB failure into something a user can act on.
 *
 * A quota failure is the one storage error with an obvious remedy, and the raw
 * DOMException text ("The quota has been exceeded.") does not suggest it. Being
 * told what to do is the difference between deleting the app and freeing space.
 */
function describeStorageError(value: unknown, fallback: string): Error {
  const name = value instanceof DOMException || value instanceof Error ? value.name : ''
  if (name === 'QuotaExceededError') {
    return new StorageFullError(
      'This device is out of space for photos. Export a backup, then delete a few older photos to make room.',
    )
  }
  return toError(value, fallback)
}

/** IndexedDB and `catch` both hand back `unknown`; callers deserve an Error. */
function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  // Anything non-primitive would stringify to "[object Object]", which tells a
  // user nothing; the caller's fallback message is more useful than that.
  return new Error(typeof value === 'string' && value ? value : fallback)
}

export function indexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    // Accessing indexedDB throws outright in some locked-down configurations.
    return false
  }
}

/**
 * Open a database at `version`, climbing the ladder from whatever version is
 * already on disk.
 *
 * Parameterised rather than hard-wired so tests can exercise a real upgrade —
 * write at version N, reopen at N+1 with an extra rung, and prove the photos
 * are still there. An upgrade path that has never actually been run is a claim,
 * not a guarantee, and this is the one code path where being wrong costs a user
 * their entire history.
 */
export function openDatabase(
  name: string,
  version: number,
  migrations: readonly Migration[],
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!indexedDBAvailable()) {
      reject(
        new StorageUnavailableError(
          'IndexedDB is not available. Private browsing or a locked-down configuration can cause this.',
        ),
      )
      return
    }

    const request = indexedDB.open(name, version)

    request.onupgradeneeded = (event) => {
      const db = request.result
      const tx = request.transaction
      if (!tx) throw new Error('Upgrade transaction missing')
      for (let v = event.oldVersion; v < (event.newVersion ?? version); v++) {
        const migrate = migrations[v]
        if (!migrate) throw new Error(`No migration from schema version ${v}`)
        migrate(db, tx)
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // A newer tab wants to upgrade the schema; yield so it is not blocked.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }

    request.onerror = () => reject(request.error ?? new Error('Failed to open database'))
    request.onblocked = () =>
      reject(new Error('Database upgrade blocked by another open tab of this app.'))
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDB(): Promise<IDBDatabase> {
  dbPromise ??= openDatabase(DB_NAME, DB_VERSION, MIGRATIONS).catch((err: unknown) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

/** The shipped ladder, exposed so tests can extend it with a future rung. */
export const SCHEMA_MIGRATIONS = MIGRATIONS

/**
 * Drop the cached connection so the next call opens a fresh one.
 *
 * Used both by tests (to re-run the ladder against a clean database) and at
 * runtime when the browser has closed the connection underneath us.
 */
export function forgetCachedDatabase(): void {
  dbPromise = null
}

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * Open a transaction, reopening the database once if the connection has been
 * closed underneath us.
 *
 * The browser can close a connection at any time — under storage pressure, or
 * when a tab is restored from the back/forward cache. Without this, the cached
 * handle would reject every write for the rest of the session.
 */
async function beginTransaction(
  storeNames: string | string[],
  mode: IDBTransactionMode,
): Promise<IDBTransaction> {
  const db = await openDB()
  try {
    return db.transaction(storeNames, mode)
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== 'InvalidStateError') {
      throw toError(err, 'Could not open a database transaction')
    }
    forgetCachedDatabase()
    const reopened = await openDB()
    return reopened.transaction(storeNames, mode)
  }
}

/**
 * Run `fn` inside one transaction and resolve only once that transaction has
 * actually committed. Resolving on the request callback instead would report
 * success for writes that the transaction later aborts — which for this app
 * means telling someone their photo is saved when it is not.
 */
export async function withTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = await beginTransaction(storeNames, mode)
  const failure = mode === 'readwrite' ? 'The photo could not be saved.' : 'Could not read from photo storage.'

  return await new Promise<T>((resolve, reject) => {
    let result: T
    let produced = false
    let settled = false

    // Named `action`, not `fn` — `fn` is already the caller's callback.
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }

    tx.oncomplete = () =>
      settle(() => {
        // If the callback has not finished, the transaction auto-committed out
        // from under it — an `await` inside it resolved from something other
        // than an IndexedDB request. Resolving here would report a successful
        // save for a transaction that may have written nothing, which is the
        // exact failure this wrapper exists to prevent.
        if (!produced) {
          reject(
            new Error(
              'The database transaction closed before the operation finished, so nothing was saved.',
            ),
          )
          return
        }
        resolve(result)
      })
    tx.onerror = () => settle(() => reject(describeStorageError(tx.error, failure)))
    tx.onabort = () => settle(() => reject(describeStorageError(tx.error, failure)))

    void (async () => {
      try {
        result = await fn(tx)
        produced = true
      } catch (err) {
        settle(() => {
          try {
            tx.abort()
          } catch {
            // Already finished; the original error is the useful one.
          }
          reject(describeStorageError(err, failure))
        })
      }
    })()
  })
}
