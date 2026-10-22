import { isValidTimeZone } from './day.ts'
import { newAlbumId } from './id.ts'
import { DEFAULT_ALBUM_ID, type Album } from './types.ts'

export const DEFAULT_ALBUM_NAME = 'Selfies'
export const MAX_ALBUM_NAME_LENGTH = 40

export function defaultAlbum(): Album {
  return {
    id: DEFAULT_ALBUM_ID,
    name: DEFAULT_ALBUM_NAME,
    timeZone: null,
    deletedAt: null,
  }
}

export function cleanAlbumName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Give this album a name.')
  if (name.length > MAX_ALBUM_NAME_LENGTH) {
    throw new Error(`Album names can be at most ${MAX_ALBUM_NAME_LENGTH} characters.`)
  }
  return name
}

export function makeAlbum(name: string, timeZone: string | null = null, now: number = Date.now()): Album {
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    throw new Error(`"${timeZone}" is not a valid timezone.`)
  }
  return {
    id: newAlbumId(now),
    name: cleanAlbumName(name),
    timeZone,
    deletedAt: null,
  }
}
