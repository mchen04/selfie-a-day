export const DB_NAME = 'selfie-a-day'
const DB_VERSION = 3
export const STORE_META = 'kv'
export const STORE_OUTBOX = 'outbox'
export const STORE_GHOSTS = 'ghosts'

/**
 * Versions 1 and 2 held the local-only library, which the account's server copy
 * replaces, so opening version 3 drops every store and starts the account cache
 * empty. A version 4 must migrate from 3 instead: the outbox holds unsent photos.
 */
function upgrade(db: IDBDatabase): void {
  for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name)
  db.createObjectStore(STORE_META)
  db.createObjectStore(STORE_OUTBOX, { keyPath: ['userId', 'meta.id'] }).createIndex('by_user', 'userId')
  const ghosts = db.createObjectStore(STORE_GHOSTS, { keyPath: ['userId', 'albumId'] })
  ghosts.createIndex('by_user', 'userId')
  ghosts.createIndex('by_image', ['userId', 'image.id'])
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
      'This device is out of space for photos. Free some space, then try again.',
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!indexedDBAvailable()) {
      reject(
        new StorageUnavailableError(
          'IndexedDB is not available. Private browsing or a locked-down configuration can cause this.',
        ),
      )
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => upgrade(request.result)

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
  dbPromise ??= openDatabase().catch((err: unknown) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

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
