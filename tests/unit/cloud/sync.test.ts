import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../../../src/api/client.ts'
import { SyncEngine } from '../../../src/sync/engine.ts'
import { listGhosts, listPending, queuePhoto, readSnapshot, writeSnapshot } from '../../../src/storage/local.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { resolveTimer } from '../../../src/camera/preferences.ts'
import { pending, photo, reply, server } from './fixtures.ts'

const engines: SyncEngine[] = []
function engine(userId = 'synthetic-a') {
  const result = new SyncEngine({ id: userId, username: userId }, () => {})
  engines.push(result)
  return result
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((item) => item.stop()))
  vi.unstubAllGlobals()
})

describe('sync', () => {
  it('sends a capture PUT followed by one delta sync without a session check', async () => {
    await writeSnapshot('synthetic-a', { albums: [defaultAlbum()], photos: [], cursor: 'cached' })
    const { mocked, uploadIds } = server()
    const current = engine()
    await current.hydrate()
    const capture = pending('synthetic-a')
    await current.enqueue(capture.meta, capture.master, capture.thumb)
    await vi.waitFor(() => expect(current.state.pending).toHaveLength(0))
    await vi.waitFor(() => expect(current.state.syncing).toBe(false))
    expect(mocked.mock.calls.map(([url]) => url)).toEqual([`/api/photos/${capture.meta.id}`, '/api/sync?since=cached'])
    expect(new Headers(mocked.mock.calls[0]![1]?.headers).get('X-Selfie-User')).toBe('synthetic-a')
    expect(uploadIds).toEqual([capture.meta.id])
  })

  it('uploads before an in-flight refresh returns its sync response', async () => {
    const { mocked, uploadIds } = server()
    const respond = mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let held = false
    mocked.mockImplementation(async (url, init) => {
      if (url.startsWith('/api/sync') && !held) { held = true; entered!(); await waiting }
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh()
    await blocked
    const capture = pending('synthetic-a')
    try {
      await current.enqueue(capture.meta, capture.master, capture.thumb)
      await vi.waitFor(() => expect(uploadIds).toEqual([capture.meta.id]), { timeout: 500 })
    } finally { release!() }
    await refreshing
    expect(current.state.photos.map((item) => item.id)).toContain(capture.meta.id)
  })

  it('keeps a rejected capture with its owner and stops this engine from uploading again', async () => {
    const first = pending('synthetic-a'), second = pending('synthetic-a', photo(first.meta.capturedAt + 1))
    const { mocked, uploadIds } = server()
    const respond = mocked.getMockImplementation()!
    mocked.mockImplementation((url, init) => {
      if (init?.method === 'PUT') return Promise.resolve(reply({ error: 'user_mismatch' }, 409))
      if (url === '/api/auth/me') return Promise.resolve(reply({ user: { id: 'synthetic-b', username: 'synthetic-b' } }))
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    await current.enqueue(first.meta, first.master, first.thumb)
    await vi.waitFor(() => expect(mocked.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true))
    await vi.waitFor(() => expect(current.state.syncing).toBe(false))
    await current.enqueue(second.meta, second.master, second.thumb)
    await current.retryUploads()
    expect(mocked.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    expect(uploadIds).toEqual([])
    expect((await listPending('synthetic-a')).map((entry) => entry.userId)).toEqual(['synthetic-a', 'synthetic-a'])
    expect(await listPending('synthetic-b')).toEqual([])
  })

  it.each(['first pull', 'second pull', 'ghost download', 'upload'])('joins a capture to the refresh during %s without duplicate checks before its PUT', async (phase) => {
    const original = photo(), capture = pending('synthetic-a', photo(original.capturedAt + 1))
    if (phase === 'upload') await queuePhoto(pending('synthetic-a', original))
    const { mocked, uploadIds } = server(phase === 'ghost download' ? [original] : [])
    const respond = mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let pulls = 0, held = false
    mocked.mockImplementation(async (url, init) => {
      if (url.startsWith('/api/sync')) pulls++
      const hold = phase === 'first pull' ? pulls === 1 && url.startsWith('/api/sync')
        : phase === 'second pull' ? pulls === 2 && url.startsWith('/api/sync')
          : phase === 'ghost download' ? url.endsWith('/master') : init?.method === 'PUT'
      if (hold && !held) { held = true; entered!(); await waiting }
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh(Promise.resolve({ user: current.user }))
    await blocked
    const start = mocked.mock.calls.length
    try {
      await current.enqueue(capture.meta, capture.master, capture.thumb)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally { release!() }
    await refreshing
    const calls = mocked.mock.calls.slice(start)
    const upload = calls.findIndex(([url, init]) => url.endsWith(capture.meta.id) && init?.method === 'PUT')
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(calls.slice(0, upload).filter(([url]) => url.startsWith('/api/sync')).length).toBeLessThanOrEqual(1)
    expect(calls.slice(0, upload).filter(([url]) => url === '/api/auth/me')).toHaveLength(0)
    expect(calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(0)
    expect(uploadIds.filter((id) => id === capture.meta.id)).toHaveLength(1)
    expect(await listPending('synthetic-a')).toEqual([])
  })

  it('uploads before a refresh queued during a ghost download starts another cycle', async () => {
    const original = photo(), capture = pending('synthetic-a', photo(original.capturedAt + 1))
    const { mocked } = server([original])
    const respond = mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let held = false
    mocked.mockImplementation(async (url, init) => {
      if (url.endsWith('/master') && !held) { held = true; entered!(); await waiting }
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh(Promise.resolve({ user: current.user }))
    await blocked
    const queued = current.refresh()
    const start = mocked.mock.calls.length
    try { await current.enqueue(capture.meta, capture.master, capture.thumb) }
    finally { release!() }
    await Promise.all([refreshing, queued])
    const calls = mocked.mock.calls.slice(start)
    const upload = calls.findIndex(([url, init]) => url.endsWith(capture.meta.id) && init?.method === 'PUT')
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(calls.slice(0, upload).filter(([url]) => url.startsWith('/api/sync')).length).toBeLessThanOrEqual(1)
    expect(calls.slice(0, upload).filter(([url]) => url === '/api/auth/me')).toHaveLength(0)
    expect(await listPending('synthetic-a')).toEqual([])
  })

  it('keeps a joined capture in the outbox if the account changes during the refresh', async () => {
    const original = photo(), capture = pending('synthetic-a', photo(original.capturedAt + 1))
    const { mocked, uploadIds, setUser } = server([original])
    const respond = mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    mocked.mockImplementation(async (url, init) => {
      if (url.endsWith('/master')) { entered!(); await waiting }
      if (url === '/api/auth/me') return reply({ user: { id: 'synthetic-b', username: 'synthetic-b' } })
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh(Promise.resolve({ user: current.user }))
    await blocked
    setUser({ id: 'synthetic-b', username: 'synthetic-b' })
    try { await current.enqueue(capture.meta, capture.master, capture.thumb) }
    finally { release!() }
    await refreshing
    expect(uploadIds).toEqual([])
    expect((await listPending('synthetic-a')).map((entry) => entry.meta.id)).toEqual([capture.meta.id])
  })

  it('pulls a newer untimed retake when refresh arrives during a ghost download', async () => {
    const timed = { ...photo(), timerSeconds: 10 }
    const untimed = { ...photo(timed.capturedAt + 1000), timerSeconds: 0 }
    const remote = server([timed])
    const respond = remote.mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: ((response: Response) => void) | undefined
    const downloading = new Promise<void>((resolve) => { entered = resolve })
    const delayed = new Promise<Response>((resolve) => { release = resolve })
    let held = false
    remote.mocked.mockImplementation((url, init) => {
      if (url.endsWith('/master') && !held) { held = true; entered!(); return delayed }
      return respond(url, init)
    })
    const current = engine()
    await current.hydrate()
    const first = current.refresh()
    await downloading
    expect(resolveTimer(null, current.visiblePhotos()[0]!)).toBe(10)
    remote.setPhotos([{ ...timed, deletedAt: untimed.capturedAt }, untimed])
    const second = current.refresh()
    const third = current.refresh()
    release!(new Response(new Uint8Array(16)))
    await Promise.all([first, second, third])
    const latest = current.visiblePhotos().find((item) => item.deletedAt === null)!
    expect(latest.id).toBe(untimed.id)
    expect(resolveTimer({ seconds: 3, at: timed.capturedAt - 1 }, latest)).toBe(0)
    expect(remote.mocked.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(2)
  })
  it('replaces an invalid cursor with one full snapshot and keeps pending captures', async () => {
    const stale = photo(), currentPhoto = photo(stale.capturedAt + 1)
    const entry = pending('synthetic-a', photo(stale.capturedAt + 2))
    entry.nextAttemptAt = Number.MAX_SAFE_INTEGER
    await queuePhoto(entry)
    await writeSnapshot('synthetic-a', { albums: [defaultAlbum()], photos: [stale], cursor: 'stale' })
    server([currentPhoto])
    const original = api.sync
    const sync = vi.spyOn(api, 'sync')
    sync.mockImplementation((cursor) => cursor === 'stale' ? Promise.reject(new ApiError(400, 'invalid_cursor')) : original(cursor))
    const current = engine()
    await current.hydrate(); await current.refresh()
    expect(sync.mock.calls.map(([cursor]) => cursor)).toEqual(['stale', undefined, '1'])
    expect(current.state.photos.map((item) => item.id)).toEqual([currentPhoto.id])
    expect(await listPending('synthetic-a')).toHaveLength(1)
    expect((await readSnapshot('synthetic-a'))?.cursor).toBe('2')
    expect(current.state.error).toBeNull()
  })

  it('does not loop when the full snapshot also rejects its cursor', async () => {
    await writeSnapshot('synthetic-a', { albums: [], photos: [], cursor: 'stale' })
    server()
    const sync = vi.spyOn(api, 'sync').mockRejectedValue(new ApiError(400, 'invalid_cursor'))
    const current = engine()
    await current.hydrate(); await current.refresh()
    expect(sync.mock.calls.map(([cursor]) => cursor)).toEqual(['stale', undefined])
    expect((await readSnapshot('synthetic-a'))?.cursor).toBe('')
  })
  it('cancels a queued refresh cleanly when the account closes', async () => {
    const { mocked } = server()
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh()
    await current.stop()
    await expect(refreshing).resolves.toBeUndefined()
    expect(mocked).not.toHaveBeenCalled()
  })
  it('keeps a new offline ghost when an older master download finishes later', async () => {
    const original = photo(), next = pending('synthetic-a', photo(original.capturedAt + 1))
    const { mocked } = server([original])
    const response = mocked.getMockImplementation()!
    let entered: (() => void) | undefined
    let release: ((response: Response) => void) | undefined
    const downloading = new Promise<void>((resolve) => { entered = resolve })
    const delayed = new Promise<Response>((resolve) => { release = resolve })
    mocked.mockImplementation((url, init) => {
      if (url.endsWith('/master')) { entered!(); return delayed }
      return response(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh()
    await downloading
    await current.enqueue(next.meta, next.master, next.thumb)
    release!(new Response(new Uint8Array(16)))
    await refreshing
    expect((await listGhosts('synthetic-a'))[0]?.image.id).toBe(next.meta.id)
  })
  it('uploads a capture while the session check is still pending', async () => {
    const { mocked } = server()
    const response = mocked.getMockImplementation()!
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { release = resolve })
    mocked.mockImplementation(async (url, init) => {
      if (url === '/api/auth/me') await waiting
      return response(url, init)
    })
    const current = engine()
    await current.hydrate()
    const refreshing = current.refresh()
    const capture = pending('synthetic-a')
    await current.enqueue(capture.meta, capture.master, capture.thumb)
    try { await vi.waitFor(async () => expect(await listPending('synthetic-a')).toHaveLength(0), { timeout: 500 }) }
    finally { release!() }
    await refreshing
    expect(await listPending('synthetic-a')).toHaveLength(0)
  })
  it('hydrates metadata and requests a delta with its cached cursor', async () => {
    const first = photo()
    await writeSnapshot('synthetic-a', { albums: [defaultAlbum()], photos: [first], cursor: 'cached cursor' })
    const { mocked } = server([first])
    const current = engine()
    await current.hydrate()
    expect(current.state.photos).toHaveLength(1)
    await current.refresh()
    expect(mocked.mock.calls.map((call) => call[0])).toContain('/api/sync?since=cached%20cursor')
    expect((await readSnapshot('synthetic-a'))?.cursor).toBe('2')
  })
  it('merges changed rows and removes purged ids without losing unchanged photos', async () => {
    const a = photo(), b = photo(1_800_000_000_001), c = photo(1_800_000_000_002)
    await writeSnapshot('synthetic-a', { albums: [defaultAlbum()], photos: [a, b], cursor: 'before' })
    const { mocked } = server()
    mocked.mockImplementation((url) => Promise.resolve(url === '/api/auth/me' ? reply({ user: { id: 'synthetic-a', username: 'synthetic-a' } }) : url.endsWith('/master') ? new Response(new Uint8Array(4)) : reply({ albums: [], photos: [c], removed: [a.id], cursor: 'after', serverTime: 1 })))
    const current = engine()
    await current.hydrate()
    await current.refresh()
    expect(current.state.photos.map((item) => item.id).sort()).toEqual([b.id, c.id].sort())
    expect(current.state.cursor).toBe('after')
  })
  it('uploads only this user’s entries and removes successful captures from the outbox', async () => {
    const mine = pending('synthetic-a'), theirs = pending('synthetic-b')
    await queuePhoto(mine); await queuePhoto(theirs)
    const { uploadIds } = server()
    const current = engine()
    await current.hydrate(); await current.refresh()
    expect(uploadIds).toEqual([mine.meta.id])
    expect(await listPending('synthetic-a')).toEqual([])
    expect(await listPending('synthetic-b')).toHaveLength(1)
  })
  it('never uploads cached captures after the cookie changes to another user', async () => {
    await queuePhoto(pending('synthetic-a'))
    const { mocked, uploadIds } = server()
    const response = mocked.getMockImplementation()!
    mocked.mockImplementation((url, init) => url === '/api/auth/me'
      ? Promise.resolve(reply({ user: { id: 'synthetic-b', username: 'synthetic-b' } })) : response(url, init))
    const current = engine()
    await current.hydrate(); await current.refresh()
    expect(uploadIds).toEqual([])
    expect(await listPending('synthetic-a')).toHaveLength(1)
    expect(current.state.photos).toEqual([])
  })
  it('backs off after a failed upload and retries the same id', async () => {
    const entry = pending('synthetic-a')
    await queuePhoto(entry)
    const { mocked, uploadIds } = server()
    const success = mocked.getMockImplementation()!
    let fail = true
    mocked.mockImplementation(async (url, init) => {
      if (init?.method === 'PUT' && fail) { fail = false; throw new TypeError('offline') }
      return success(url, init)
    })
    const current = engine()
    await current.hydrate(); await current.refresh()
    const waiting = (await listPending('synthetic-a'))[0]!
    expect(waiting.attempts).toBe(1)
    expect(waiting.nextAttemptAt).toBeGreaterThan(Date.now())
    await current.refresh()
    expect(uploadIds).toEqual([])
    await current.retryUploads()
    expect(uploadIds).toEqual([entry.meta.id])
    expect(await listPending('synthetic-a')).toHaveLength(0)
  })
  it('keeps the same id after a lost upload response', async () => {
    const entry = pending('synthetic-a')
    await queuePhoto(entry)
    const { mocked, uploadIds } = server()
    const success = mocked.getMockImplementation()!
    let loseResponse = true
    mocked.mockImplementation(async (url, init) => {
      const result = await success(url, init)
      if (init?.method === 'PUT' && loseResponse) { loseResponse = false; throw new TypeError('response lost') }
      return result
    })
    const current = engine()
    await current.hydrate(); await current.refresh(); await current.retryUploads()
    expect(uploadIds).toEqual([entry.meta.id, entry.meta.id])
    expect(current.visiblePhotos().filter((item) => item.deletedAt === null)).toHaveLength(1)
  })
  it('applies retake replacements and keeps only the newest ghost per album', async () => {
    const old = photo(), next = photo(old.capturedAt + 1)
    await queuePhoto(pending('synthetic-a', next))
    server([old])
    const current = engine()
    await current.hydrate(); await current.refresh()
    expect(current.state.photos.find((item) => item.id === old.id)?.deletedAt).not.toBeNull()
    expect(current.visiblePhotos().filter((item) => item.deletedAt === null).map((item) => item.id)).toEqual([next.id])
    expect((await listGhosts('synthetic-a')).map((item) => item.image.id)).toEqual([next.id])
  })
  it('rolls back an optimistic restore on day_taken', async () => {
    const trashed = { ...photo(), deletedAt: 100 }
    server([trashed])
    vi.spyOn(api, 'patchPhoto').mockRejectedValue(new Error('This day already has a photo.'))
    const current = engine()
    await current.hydrate(); await current.refresh()
    await expect(current.mutatePhoto(trashed.id, null)).rejects.toThrow(/already/)
    expect(current.state.photos[0]?.deletedAt).toBe(100)
  })
  it('keeps a restored photo in Trash until the server accepts it and reload can read it', async () => {
    const trashed = { ...photo(), deletedAt: 100 }
    const { setPhotos } = server([trashed])
    let accept: (() => void) | undefined
    let entered: (() => void) | undefined
    const requested = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { accept = resolve })
    vi.spyOn(api, 'patchPhoto').mockImplementation(async () => {
      entered!()
      await waiting
      const restored = { ...trashed, deletedAt: null }
      setPhotos([restored])
      return { photo: restored }
    })
    let reloaded: Promise<void> | undefined
    const next = engine()
    const current = new SyncEngine({ id: 'synthetic-a', username: 'synthetic-a' }, (state) => {
      if (state.photos.some((item) => item.id === trashed.id && item.deletedAt === null)) {
        reloaded ??= next.hydrate()
      }
    })
    engines.push(current)
    await current.hydrate(); await current.refresh()
    const restoring = current.mutatePhoto(trashed.id, null)
    await requested
    try {
      expect(current.visiblePhotos()[0]?.deletedAt).toBe(100)
    } finally {
      accept!()
      await restoring
    }
    await reloaded
    expect(next.visiblePhotos()[0]?.deletedAt).toBeNull()
  })
  it('rolls back failed trash, permanent delete, and empty actions', async () => {
    const original = photo()
    server([original])
    const current = engine()
    await current.hydrate(); await current.refresh()
    vi.spyOn(api, 'patchPhoto').mockRejectedValue(new TypeError('offline'))
    await expect(current.mutatePhoto(original.id, 100)).rejects.toThrow()
    expect(current.state.photos[0]?.deletedAt).toBeNull()
    vi.spyOn(api, 'deletePhoto').mockRejectedValue(new TypeError('offline'))
    await expect(current.mutatePhoto(original.id, 'purge')).rejects.toThrow()
    expect(current.state.photos).toHaveLength(1)
    current.state.photos = [{ ...original, deletedAt: 100 }]
    vi.spyOn(api, 'emptyTrash').mockRejectedValue(new TypeError('offline'))
    await expect(current.emptyTrash()).rejects.toThrow()
    expect(current.state.photos[0]?.deletedAt).toBe(100)
  })
  it('removes obsolete ghosts after a delta changes the newest active photo', async () => {
    const original = photo(), next = photo(original.capturedAt + 1)
    const remote = server([original])
    const current = engine()
    await current.hydrate(); await current.refresh()
    remote.setPhotos([original, next])
    await current.refresh()
    expect((await listGhosts('synthetic-a')).map((item) => item.image.id)).toEqual([next.id])
  })
})
