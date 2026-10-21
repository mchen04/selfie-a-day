import { describe, expect, it } from 'vitest'
import { cachedUser, cacheUser, clearUserData, listGhosts, listPending, MAX_PENDING, queuePhoto, readSnapshot, writeSnapshot } from '../../../src/storage/local.ts'
import { pending, photo } from './fixtures.ts'

 describe('bounded local data', () => {
  it('does not replace a newer ghost with an older capture', async () => {
    const newest = pending('synthetic-a', photo(1_800_000_000_002))
    await queuePhoto(newest)
    await queuePhoto(pending('synthetic-a', photo(1_800_000_000_001)))
    expect((await listGhosts('synthetic-a'))[0]?.image.id).toBe(newest.meta.id)
  })
  it('replaces each album’s ghost and bounds pending captures', async () => {
    for (let i = 0; i < MAX_PENDING; i++) await queuePhoto(pending('synthetic-a', photo(1_800_000_000_000 + i)))
    expect(await listGhosts('synthetic-a')).toHaveLength(1)
    await expect(queuePhoto(pending('synthetic-a'))).rejects.toThrow(/Twenty/)
    expect(await listPending('synthetic-a')).toHaveLength(MAX_PENDING)
  })
  it('clears only the signed-out user’s data', async () => {
    await cacheUser({ id: 'synthetic-a', username: 'synthetic' })
    await queuePhoto(pending('synthetic-a')); await queuePhoto(pending('synthetic-b'))
    await writeSnapshot('synthetic-a', { photos: [photo()], albums: [], cursor: '1' })
    await clearUserData('synthetic-a')
    expect(await cachedUser()).toBeNull()
    expect(await readSnapshot('synthetic-a')).toBeNull()
    expect(await listPending('synthetic-a')).toEqual([])
    expect(await listGhosts('synthetic-a')).toEqual([])
    expect(await listPending('synthetic-b')).toHaveLength(1)
  })
})
