import { cleanAlbumName, defaultAlbum, makeAlbum } from '../core/albums.ts'
import { isValidTimeZone } from '../core/day.ts'
import { SCHEMA_VERSION, type Album } from '../core/types.ts'
import {
  INDEX_ALBUM_CREATED_AT,
  STORE_ALBUMS,
  promisifyRequest,
  withTransaction,
} from './db.ts'

function normalizeAlbum(value: Album): Album {
  return {
    ...value,
    timeZone: value.timeZone && isValidTimeZone(value.timeZone) ? value.timeZone : null,
    deletedAt: typeof value.deletedAt === 'number' ? value.deletedAt : null,
    schema: SCHEMA_VERSION,
  }
}

export async function listAlbums(options: { includeDeleted?: boolean } = {}): Promise<Album[]> {
  return withTransaction(STORE_ALBUMS, 'readonly', async (tx) => {
    const rows = await promisifyRequest(
      tx.objectStore(STORE_ALBUMS).index(INDEX_ALBUM_CREATED_AT).getAll() as IDBRequest<Album[]>,
    )
    return rows.map(normalizeAlbum).filter((album) => options.includeDeleted || album.deletedAt === null)
  })
}

export async function getAlbum(id: string): Promise<Album | null> {
  return withTransaction(STORE_ALBUMS, 'readonly', async (tx) => {
    const row = await promisifyRequest(
      tx.objectStore(STORE_ALBUMS).get(id) as IDBRequest<Album | undefined>,
    )
    return row ? normalizeAlbum(row) : null
  })
}

export async function createAlbum(
  name: string,
  timeZone: string | null = null,
  now: number = Date.now(),
): Promise<Album> {
  const album = makeAlbum(name, timeZone, now)
  await withTransaction(STORE_ALBUMS, 'readwrite', (tx) => {
    tx.objectStore(STORE_ALBUMS).add(album)
  })
  return album
}

export async function updateAlbum(
  id: string,
  patch: { name?: string; timeZone?: string | null },
  now: number = Date.now(),
): Promise<Album> {
  return withTransaction(STORE_ALBUMS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_ALBUMS)
    const current = await promisifyRequest(store.get(id) as IDBRequest<Album | undefined>)
    if (!current || current.deletedAt !== null) throw new Error('That album no longer exists.')

    const timeZone = patch.timeZone === undefined ? current.timeZone : patch.timeZone
    if (timeZone !== null && !isValidTimeZone(timeZone)) {
      throw new Error(`"${timeZone}" is not a valid timezone.`)
    }
    const album: Album = {
      ...current,
      name: patch.name === undefined ? current.name : cleanAlbumName(patch.name),
      timeZone,
      updatedAt: now,
      schema: SCHEMA_VERSION,
    }
    store.put(album)
    return album
  })
}

/** Add albums from a backup without overwriting local names or timezone choices. */
export async function ensureAlbums(albums: readonly Album[]): Promise<void> {
  if (albums.length === 0) return
  await withTransaction(STORE_ALBUMS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_ALBUMS)
    for (const album of albums) {
      const existing = await promisifyRequest(store.get(album.id) as IDBRequest<Album | undefined>)
      if (!existing) store.add(normalizeAlbum(album))
    }
  })
}

export async function ensureDefaultAlbum(): Promise<Album> {
  const fallback = defaultAlbum()
  await ensureAlbums([fallback])
  return (await getAlbum(fallback.id)) ?? fallback
}
