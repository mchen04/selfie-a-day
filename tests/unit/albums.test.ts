import { describe, expect, it } from 'vitest'
import { cleanAlbumName, makeAlbum } from '../../src/core/albums.ts'

describe('album input', () => {
  it('trims names and preserves the time zone', () => {
    expect(makeAlbum('  Training  ', 'America/New_York', 100)).toMatchObject({ name: 'Training', timeZone: 'America/New_York', deletedAt: null })
  })
  it('rejects blank names, long names, and invalid zones', () => {
    expect(() => cleanAlbumName('  ')).toThrow(/name/)
    expect(() => cleanAlbumName('a'.repeat(41))).toThrow(/40/)
    expect(() => makeAlbum('Face', 'Moon/Sea')).toThrow(/timezone/)
  })
})
