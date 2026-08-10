import { describe, expect, it } from 'vitest'
import { STORE_META, withTransaction } from '../../src/storage/db.ts'

describe('withTransaction', () => {
  it('returns the callback result once the transaction commits', async () => {
    const value = await withTransaction(STORE_META, 'readwrite', (tx) => {
      tx.objectStore(STORE_META).put({ a: 1 }, 'k')
      return 'done'
    })
    expect(value).toBe('done')
  })

  /**
   * The auto-commit footgun. IndexedDB commits a transaction as soon as the
   * microtask queue drains with no pending request, so an `await` on anything
   * that is not an IndexedDB request silently ends it. Reporting success there
   * would tell someone their photo was saved when nothing was written.
   */
  it('refuses to report success when the callback outlives the transaction', async () => {
    await expect(
      withTransaction(STORE_META, 'readwrite', async (tx) => {
        // A timer, not an IndexedDB request: the transaction commits first.
        await new Promise((resolve) => setTimeout(resolve, 10))
        tx.objectStore(STORE_META).put({ a: 2 }, 'k')
        return 'should not be reported'
      }),
    ).rejects.toThrow(/closed before the operation finished/i)
  })
})
