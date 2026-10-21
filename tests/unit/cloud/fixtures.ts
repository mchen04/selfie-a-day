import { vi } from 'vitest'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { newPhotoId } from '../../../src/core/id.ts'
import { SCHEMA_VERSION, type PhotoMeta, type StoredImage } from '../../../src/core/types.ts'
import type { PhotoDTO, SyncResponse } from '../../../src/api/client.ts'
import type { PendingPhoto } from '../../../src/storage/local.ts'

export function photo(at = 1_800_000_000_000, albumId = 'selfies'): PhotoMeta {
  return { id: newPhotoId(at), albumId, dayKey: '2027-01-15', capturedAt: at, timeZone: 'UTC', tzOffsetMinutes: 0,
    width: 3, height: 4, mime: 'image/webp', mirrored: true, source: 'camera', timerSeconds: 0,
    masterBytes: 16, thumbBytes: 4, deletedAt: null, schema: SCHEMA_VERSION }
}
export function pending(userId: string, meta = photo()): PendingPhoto {
  const master: StoredImage = { id: meta.id, bytes: new ArrayBuffer(16), mime: meta.mime, width: 3, height: 4 }
  return { userId, meta, master, thumb: { ...master, bytes: new ArrayBuffer(4) }, attempts: 0, nextAttemptAt: 0, error: null }
}
export const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

export function server(initial: PhotoMeta[] = []) {
  let photos: PhotoDTO[] = initial.map((item) => ({ ...item, timerSeconds: item.timerSeconds ?? 0 }))
  let cursor = 0
  const uploadIds: string[] = []
  const mocked = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
    return Promise.resolve((() => {
    if (input === '/api/auth/me') return reply({ user: { id: 'synthetic-a', username: 'synthetic-a' } })
    if (input.startsWith('/api/sync')) return reply({ albums: [defaultAlbum()], photos, removed: [], cursor: String(++cursor), serverTime: Date.now() } satisfies SyncResponse)
    if (input.endsWith('/master')) return new Response(new Uint8Array(16), { headers: { 'Content-Type': 'image/webp' } })
    if (input.startsWith('/api/photos/') && init?.method === 'PUT') {
      const id = input.split('/').at(-1)!
      uploadIds.push(id)
      const previous = photos.find((item) => item.id === id)
      if (previous) return reply({ photo: previous, replaced: [] })
      const meta = JSON.parse((init.body as FormData).get('meta') as string) as PhotoDTO
      const replaced = photos.filter((item) => item.deletedAt === null && item.albumId === meta.albumId && item.dayKey === meta.dayKey).map((item) => item.id)
      photos = photos.map((item) => replaced.includes(item.id) ? { ...item, deletedAt: Date.now() } : item)
      const saved = { ...meta, id, masterBytes: 16, thumbBytes: 4, deletedAt: null }
      photos.push(saved)
      return reply({ photo: saved, replaced }, 201)
    }
    throw new Error(`Unexpected request: ${input}`)
    })())
  })
  vi.stubGlobal('fetch', mocked)
  return { mocked, uploadIds, setPhotos: (items: PhotoMeta[]) => { photos = items.map((item) => ({ ...item, timerSeconds: item.timerSeconds ?? 0 })) } }
}
