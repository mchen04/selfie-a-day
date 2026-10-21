import { describe, expect, it } from 'vitest'
import { DB_NAME, DB_VERSION, openDatabase, SCHEMA_MIGRATIONS, promisifyRequest } from '../../src/storage/db.ts'

describe('cloud storage upgrade', () => {
  for (const version of [1, 2]) {
    it(`drops all legacy stores and pixels from v${version}`, async () => {
      const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, version)
        request.onupgradeneeded = () => {
          for (const name of ['photos', 'masters', 'thumbs', 'meta', 'albums']) request.result.createObjectStore(name)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Cannot seed legacy storage'))
      })
      const tx = legacy.transaction(['photos', 'masters', 'thumbs'], 'readwrite')
      tx.objectStore('photos').put({ id: 'legacy' }, 'legacy')
      tx.objectStore('masters').put(new ArrayBuffer(64), 'legacy')
      tx.objectStore('thumbs').put(new ArrayBuffer(8), 'legacy')
      await new Promise<void>((resolve) => { tx.oncomplete = () => resolve() })
      legacy.close()
      const upgraded = await openDatabase(DB_NAME, DB_VERSION, SCHEMA_MIGRATIONS)
      expect([...upgraded.objectStoreNames]).toEqual(['ghosts', 'kv', 'outbox'])
      for (const name of upgraded.objectStoreNames) {
        expect(await promisifyRequest(upgraded.transaction(name).objectStore(name).count())).toBe(0)
      }
      upgraded.close()
    })
  }
})
