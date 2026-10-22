import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach } from 'vitest'
import { forgetCachedDatabase } from '../../src/storage/db.ts'

declare const jsdom: { window: Window }

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: jsdom.window[name] })
}

// A fresh IndexedDB per test keeps storage tests from leaking into each other.
// Without this, a photo written by one test looks like pre-existing data to the
// next one and the migration and replacement tests stop proving anything.
beforeEach(() => {
  forgetCachedDatabase()
  globalThis.indexedDB = new IDBFactory()
})
