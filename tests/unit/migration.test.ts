import { describe, expect, it } from 'vitest'
import { newPhotoId } from '../../src/core/id.ts'
import { SCHEMA_VERSION, type PhotoMeta } from '../../src/core/types.ts'
import {
  DB_NAME,
  DB_VERSION,
  SCHEMA_MIGRATIONS,
  STORE_MASTERS,
  STORE_PHOTOS,
  STORE_THUMBS,
  openDatabase,
  promisifyRequest,
} from '../../src/storage/db.ts'

function metaFor(dayKey: string, capturedAt: number): PhotoMeta {
  return {
    id: newPhotoId(capturedAt),
    dayKey,
    capturedAt,
    tzOffsetMinutes: 0,
    width: 1080,
    height: 1440,
    mime: 'image/jpeg',
    mirrored: true,
    source: 'camera',
    masterBytes: 42,
    thumbBytes: 8,
    schema: SCHEMA_VERSION,
  }
}

function write(db: IDBDatabase, meta: PhotoMeta): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PHOTOS, STORE_THUMBS, STORE_MASTERS], 'readwrite')
    tx.objectStore(STORE_PHOTOS).put(meta)
    tx.objectStore(STORE_THUMBS).put({ id: meta.id, mime: meta.mime, width: 24, height: 32, bytes: new ArrayBuffer(8) })
    tx.objectStore(STORE_MASTERS).put({ id: meta.id, mime: meta.mime, width: 1080, height: 1440, bytes: new ArrayBuffer(42) })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('write failed'))
  })
}

async function readAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  const tx = db.transaction(store, 'readonly')
  return await promisifyRequest(tx.objectStore(store).getAll() as IDBRequest<unknown[]>)
}

describe('schema ladder', () => {
  it('has exactly one migration per shipped version', () => {
    // The module also asserts this at import time; stating it as a test makes
    // the failure legible instead of a mysterious import crash.
    expect(SCHEMA_MIGRATIONS).toHaveLength(DB_VERSION)
  })

  it('creates the expected stores and indexes on a first run', async () => {
    const db = await openDatabase(DB_NAME, DB_VERSION, SCHEMA_MIGRATIONS)
    expect([...db.objectStoreNames].sort()).toEqual(['masters', 'meta', 'photos', 'thumbs'])

    const tx = db.transaction(STORE_PHOTOS, 'readonly')
    expect([...tx.objectStore(STORE_PHOTOS).indexNames].sort()).toEqual(['by_capturedAt', 'by_day'])
    db.close()
  })

  /**
   * The test the whole app rests on: a user who installed months ago opens a
   * new version, the schema climbs a rung, and their photos are still there.
   * An upgrade path that has never actually run is a claim, not a guarantee.
   */
  it('preserves every photo across a schema upgrade', async () => {
    const v1 = await openDatabase(DB_NAME, 1, SCHEMA_MIGRATIONS)
    const metas = [
      metaFor('2026-08-07', Date.parse('2026-08-07T10:00:00Z')),
      metaFor('2026-08-08', Date.parse('2026-08-08T10:00:00Z')),
      metaFor('2026-08-09', Date.parse('2026-08-09T10:00:00Z')),
    ]
    for (const meta of metas) await write(v1, meta)
    expect(await readAll(v1, STORE_PHOTOS)).toHaveLength(3)
    v1.close()

    // A plausible future rung: add an index to an existing store.
    let ranUpgrade = false
    const futureLadder = [
      ...SCHEMA_MIGRATIONS,
      (_db: IDBDatabase, tx: IDBTransaction) => {
        ranUpgrade = true
        tx.objectStore(STORE_PHOTOS).createIndex('by_source', 'source', { unique: false })
      },
    ]

    const v2 = await openDatabase(DB_NAME, 2, futureLadder)
    expect(ranUpgrade).toBe(true)
    expect(v2.version).toBe(2)

    const photos = (await readAll(v2, STORE_PHOTOS)) as PhotoMeta[]
    expect(photos).toHaveLength(3)
    expect(photos.map((p) => p.dayKey).sort()).toEqual(['2026-08-07', '2026-08-08', '2026-08-09'])
    expect(await readAll(v2, STORE_MASTERS)).toHaveLength(3)
    expect(await readAll(v2, STORE_THUMBS)).toHaveLength(3)

    const tx = v2.transaction(STORE_PHOTOS, 'readonly')
    expect([...tx.objectStore(STORE_PHOTOS).indexNames]).toContain('by_source')
    v2.close()
  })

  it('runs every intervening rung when upgrading across two versions at once', async () => {
    // Someone who skipped a release must not skip a migration.
    const v1 = await openDatabase(DB_NAME, 1, SCHEMA_MIGRATIONS)
    await write(v1, metaFor('2026-08-09', Date.parse('2026-08-09T10:00:00Z')))
    v1.close()

    const ran: number[] = []
    const ladder = [
      ...SCHEMA_MIGRATIONS,
      (_db: IDBDatabase, tx: IDBTransaction) => {
        ran.push(2)
        tx.objectStore(STORE_PHOTOS).createIndex('by_source', 'source', { unique: false })
      },
      (db: IDBDatabase) => {
        ran.push(3)
        db.createObjectStore('notes', { keyPath: 'id' })
      },
    ]

    const v3 = await openDatabase(DB_NAME, 3, ladder)
    expect(ran).toEqual([2, 3])
    expect(await readAll(v3, STORE_PHOTOS)).toHaveLength(1)
    expect([...v3.objectStoreNames]).toContain('notes')
    v3.close()
  })

  it('refuses to open when a rung is missing rather than corrupting data', async () => {
    const v1 = await openDatabase(DB_NAME, 1, SCHEMA_MIGRATIONS)
    v1.close()
    await expect(openDatabase(DB_NAME, 3, SCHEMA_MIGRATIONS)).rejects.toThrow()
  })
})
