import { describe, expect, it } from 'vitest'
import { DEFAULT_ALBUM_ID } from '../../src/core/types.ts'
import { createAlbum, listAlbums, updateAlbum } from '../../src/storage/albums.ts'

describe('album repository', () => {
  it('starts with the migrated Selfies album', async () => {
    const albums = await listAlbums()
    expect(albums).toHaveLength(1)
    expect(albums[0]).toMatchObject({ id: DEFAULT_ALBUM_ID, name: 'Selfies', timeZone: null })
  })

  it('creates, renames and pins an album timezone', async () => {
    const album = await createAlbum('  Physique  ', null, 100)
    expect(album.name).toBe('Physique')

    const updated = await updateAlbum(
      album.id,
      { name: 'Training', timeZone: 'America/New_York' },
      200,
    )
    expect(updated).toMatchObject({
      name: 'Training',
      timeZone: 'America/New_York',
      createdAt: 100,
      updatedAt: 200,
    })

    expect((await listAlbums()).map((item) => item.name)).toEqual(['Selfies', 'Training'])
  })

  it('rejects blank names and invalid timezones', async () => {
    await expect(createAlbum('   ')).rejects.toThrow(/name/i)
    await expect(createAlbum('Face', 'Moon/Sea_of_Tranquility')).rejects.toThrow(/timezone/i)
  })
})
