import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, type Harness, photoId, type SyncData, TEST_NOW } from '../support/harness'
import { photoKey } from '../../src/core/photos'

describe('albums, photo storage, trash, and delta sync in workerd', () => {
  let h: Harness
  beforeAll(async () => { h = await createHarness() })
  afterAll(async () => { await h?.dispose() })

  it('creates the default album once and sends complete DTOs', async () => {
    const user = await h.user()
    const first = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    expect(first.albums).toEqual([{ id: 'selfies', name: 'Selfies', timeZone: null, createdAt: TEST_NOW, updatedAt: TEST_NOW, deletedAt: null }])
    expect(first.serverTime).toBe(TEST_NOW)
    expect(typeof first.cursor).toBe('string')
    const next = await (await h.request(`/api/sync?since=${first.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(next.albums).toEqual([])
    expect(next.photos).toEqual([])
    expect(next.removed).toEqual([])
    expect(next.cursor).toBe(first.cursor)
    const id = photoId(1)
    const upload = await h.upload(user, id)
    expect(upload.status).toBe(201)
    expect(await upload.json()).toEqual({
      photo: { id, albumId: 'selfies', dayKey: '2026-10-21', capturedAt: TEST_NOW, timeZone: 'America/Los_Angeles', tzOffsetMinutes: 420,
        width: 100, height: 100, mime: 'image/jpeg', mirrored: true, source: 'camera', timerSeconds: 3,
        masterBytes: 8, thumbBytes: 8, deletedAt: null }, replaced: [],
    })
  })

  it('upserts albums, trims names, preserves createdAt, and enforces unique names per user', async () => {
    const user = await h.user()
    const path = `/api/albums/album-${photoId(2)}`
    const created = await h.request(path, { method: 'PUT', cookie: user.cookie, json: { name: '  Journey  ', timeZone: 'America/Los_Angeles', createdAt: TEST_NOW - 100 } })
    expect(created.status).toBe(200)
    const update = await h.request(path, { method: 'PUT', cookie: user.cookie, json: { name: 'Renamed', timeZone: null, createdAt: TEST_NOW }, now: TEST_NOW + 1 })
    expect(await update.json()).toEqual({ album: { id: `album-${photoId(2)}`, name: 'Renamed', timeZone: null, createdAt: TEST_NOW - 100, updatedAt: TEST_NOW + 1, deletedAt: null } })
    const duplicate = await h.request(`/api/albums/album-${photoId(3)}`, { method: 'PUT', cookie: user.cookie, json: { name: ' renamed ', timeZone: null, createdAt: TEST_NOW } })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'album_name_taken' })
    expect((await h.request(`/api/albums/album-${photoId(91)}`, { method: 'PUT', cookie: user.cookie, json: { name: 'Été', timeZone: null, createdAt: TEST_NOW } })).status).toBe(200)
    const unicodeDuplicate = await h.request(`/api/albums/album-${photoId(92)}`, { method: 'PUT', cookie: user.cookie, json: { name: 'été', timeZone: null, createdAt: TEST_NOW } })
    expect(unicodeDuplicate.status).toBe(409)
    expect(await unicodeDuplicate.json()).toEqual({ error: 'album_name_taken' })
    for (const body of [{ name: '', timeZone: null }, { name: 'a'.repeat(41), timeZone: null }, { name: 'Other', timeZone: 'Mars/Nope' }]) {
      expect((await h.request(path, { method: 'PUT', cookie: user.cookie, json: { ...body, createdAt: TEST_NOW } })).status).toBe(400)
    }
    expect((await h.request('/api/albums/not-an-id', { method: 'PUT', cookie: user.cookie, json: {} })).status).toBe(400)
  })

  it('keeps another user out of photo bytes, mutations, albums, and sync rows', async () => {
    const owner = await h.user()
    const other = await h.user()
    const id = photoId(4)
    const albumId = `album-${photoId(5)}`
    expect((await h.request(`/api/albums/${albumId}`, { method: 'PUT', cookie: owner.cookie, json: { name: 'Private', timeZone: null, createdAt: TEST_NOW } })).status).toBe(200)
    expect((await h.upload(owner, id, { meta: { albumId } })).status).toBe(201)
    for (const variant of ['master', 'thumb']) expect((await h.request(`/api/photos/${id}/${variant}`, { cookie: other.cookie })).status).toBe(404)
    expect((await h.request(`/api/photos/${id}`, { method: 'PATCH', cookie: other.cookie, json: { deletedAt: TEST_NOW } })).status).toBe(404)
    expect((await h.request(`/api/photos/${id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404)
    expect((await h.upload(other, photoId(6), { meta: { albumId } })).status).toBe(404)
    const albumUpdate = await h.request(`/api/albums/${albumId}`, { method: 'PUT', cookie: other.cookie, json: { name: 'Stolen', timeZone: null, createdAt: TEST_NOW } })
    expect(albumUpdate.status).toBe(404)
    expect(await albumUpdate.json()).toEqual({ error: 'not_found' })
    const data = await (await h.request('/api/sync', { cookie: other.cookie })).json<SyncData>()
    expect(data.photos).toEqual([])
    expect(data.albums.map((album) => album.id)).toEqual(['selfies'])
    expect(data.removed).toEqual([])
    const ownerData = await (await h.request('/api/sync', { cookie: owner.cookie })).json<SyncData>()
    expect(ownerData.photos.map((photo) => photo.id)).toEqual([id])
    expect((await h.request(`/api/sync?since=${ownerData.cursor}`, { cookie: other.cookie })).status).toBe(400)
    expect((await h.request('/api/trash/empty', { method: 'POST', cookie: other.cookie })).status).toBe(200)
    expect((await h.request(`/api/photos/${id}/master`, { cookie: owner.cookie })).status).toBe(200)
  })

  it('serves immutable private images with ETag, no-sniff, conditional GET, HEAD, and trash access', async () => {
    const user = await h.user()
    const id = photoId(7)
    expect((await h.upload(user, id)).status).toBe(201)
    for (const variant of ['master', 'thumb']) {
      const image = await h.request(`/api/photos/${id}/${variant}`, { cookie: user.cookie })
      expect(image.status).toBe(200)
      expect(image.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
      expect(image.headers.get('Vary')).toBe('Cookie')
      expect(image.headers.get('Content-Type')).toBe('image/jpeg')
      expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
      const cached = await h.request(`/api/photos/${id}/${variant}`, { cookie: user.cookie, headers: { 'If-None-Match': image.headers.get('ETag')! } })
      expect(cached.status).toBe(304)
      expect(await cached.text()).toBe('')
      const head = await h.request(`/api/photos/${id}/${variant}`, { method: 'HEAD', cookie: user.cookie })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    }
    expect((await h.request(`/api/photos/${id}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt: TEST_NOW } })).status).toBe(200)
    expect((await h.request(`/api/photos/${id}/master`, { cookie: user.cookie })).status).toBe(200)
    expect((await h.request(`/api/photos/${id}/master`)).status).toBe(401)
    expect((await h.request('/api/photos/../../master', { cookie: user.cookie })).status).toBe(404)
  })

  it.each([
    { master: new Uint8Array([1, 2, 3, 4]) },
    { thumb: new Uint8Array([1, 2, 3, 4]) },
    { masterMime: 'image/png' },
    { meta: { mime: 'image/webp' } },
  ])('rejects a MIME or magic mismatch %#', async (options) => {
    const user = await h.user()
    const id = photoId(8)
    expect((await h.upload(user, id, options)).status).toBe(400)
    expect(await h.env.PHOTOS.get(photoKey(user.id, id, 'master'))).toBeNull()
    expect(await h.env.PHOTOS.get(photoKey(user.id, id, 'thumb'))).toBeNull()
  })

  it('accepts WebP magic and each timer value', async () => {
    const user = await h.user()
    const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])
    for (const timerSeconds of [0, 3, 5, 10]) {
      const response = await h.upload(user, photoId(100 + timerSeconds), { master: webp, thumb: webp, masterMime: 'image/webp', thumbMime: 'image/webp', meta: { mime: 'image/webp', timerSeconds } })
      expect(response.status).toBe(201)
      const data = await response.json<{ photo: { timerSeconds: number } }>()
      expect(data.photo.timerSeconds).toBe(timerSeconds)
    }
  })

  it.each([
    { dayKey: '2026-02-30' }, { dayKey: 'tomorrow' }, { timerSeconds: 7 }, { source: 'unknown' },
    { width: 0 }, { height: -1 }, { timeZone: 'No/Such_Zone' }, { mirrored: 'true' }, { capturedAt: -1 },
  ])('rejects invalid photo metadata %#', async (meta) => {
    const user = await h.user()
    expect((await h.upload(user, photoId(9), { meta })).status).toBe(400)
  })

  it.each([{ variant: 'master', size: 4 * 1024 * 1024 + 1 }, { variant: 'thumb', size: 256 * 1024 + 1 }])('rejects an oversized $variant', async ({ variant, size }) => {
    const user = await h.user()
    const bytes = new Uint8Array(size)
    bytes.set([0xff, 0xd8, 0xff])
    const response = await h.upload(user, photoId(10), { [variant]: bytes })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
  })

  it('rejects oversized streaming bodies without a Content-Length', async () => {
    const user = await h.user()
    const response = await h.request(`/api/photos/${photoId(11)}`, { method: 'PUT', cookie: user.cookie, body: 'x'.repeat(4 * 1024 * 1024 + 256 * 1024 + 65537) })
    expect(response.status).toBe(413)
  })

  it('enforces the two GiB quota including trash before writing R2', async () => {
    const user = await h.user()
    const id = photoId(12)
    expect((await h.upload(user, id)).status).toBe(201)
    await h.sql('UPDATE photos SET master_bytes = ?, deleted_at = ? WHERE user_id = ? AND id = ?', 2 * 1024 * 1024 * 1024 - 8, TEST_NOW, user.id, id)
    const response = await h.upload(user, photoId(13))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'quota_exceeded' })
    expect(await h.env.PHOTOS.get(photoKey(user.id, photoId(13), 'master'))).toBeNull()
    expect((await h.request(`/api/photos/${id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(204)
    expect((await h.upload(user, photoId(13))).status).toBe(201)
  })

  it('enforces the 5000-photo quota including trash', async () => {
    const user = await h.user()
    await h.sql(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000)
      INSERT INTO photos (user_id,id,album_id,day_key,captured_at,time_zone,tz_offset_minutes,width,height,mime,mirrored,source,timer_seconds,master_bytes,thumb_bytes,deleted_at,purged_at,updated_at)
      SELECT ?, printf('%020d', x), 'selfies', '2026-10-01', ?, NULL, 0, 1, 1, 'image/jpeg', 0, 'camera', 0, 1, 1, ?, NULL, ? FROM n`,
    user.id, TEST_NOW, TEST_NOW, TEST_NOW)
    const response = await h.upload(user, photoId(20000))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'quota_exceeded' })
    const empty = await h.request('/api/trash/empty', { method: 'POST', cookie: user.cookie })
    expect(await empty.json()).toEqual({ deleted: 5000 })
    expect((await h.upload(user, photoId(20000))).status).toBe(201)
  })

  it('returns the stored photo on retry without changing R2 or the cursor', async () => {
    const user = await h.user()
    const id = photoId(14)
    const first = await h.upload(user, id)
    expect(first.status).toBe(201)
    const original = await first.json<{ photo: unknown }>()
    const data = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    const master = await h.env.PHOTOS.head(photoKey(user.id, id, 'master'))
    const retry = await h.request(`/api/photos/${id}`, { method: 'PUT', cookie: user.cookie, body: 'invalid retry body', now: TEST_NOW + 1 })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ photo: original.photo, replaced: [] })
    expect((await h.env.PHOTOS.head(photoKey(user.id, id, 'master')))!.etag).toBe(master!.etag)
    const next = await (await h.request(`/api/sync?since=${data.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(next.photos).toEqual([])
    expect(next.cursor).toBe(data.cursor)
  })

  it('keeps photo bytes when two identical uploads overlap', async () => {
    const user = await h.user()
    const id = photoId(140)
    const results = await Promise.all([h.upload(user, id), h.upload(user, id)])
    expect(results.map((response) => response.status).sort()).toEqual([200, 201])
    const bodies = await Promise.all(results.map((response) => response.json<{ photo: unknown }>()))
    expect(bodies[0]!.photo).toEqual(bodies[1]!.photo)
    expect((await h.request(`/api/photos/${id}/master`, { cookie: user.cookie })).status).toBe(200)
    expect((await h.request(`/api/photos/${id}/thumb`, { cookie: user.cookie })).status).toBe(200)
    const sync = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    expect(sync.photos).toHaveLength(1)
    expect(sync.photos[0]!.deletedAt).toBeNull()
  })

  it('trashes the previous same-day photo atomically and rejects conflicting restores', async () => {
    const user = await h.user()
    const first = photoId(15)
    const second = photoId(16)
    expect((await h.upload(user, first)).status).toBe(201)
    const retake = await h.upload(user, second)
    expect(retake.status).toBe(201)
    expect((await retake.json<{ replaced: string[] }>()).replaced).toEqual([first])
    const data = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    expect(data.photos.find((photo) => photo.id === first)!.deletedAt).toBe(TEST_NOW)
    expect(data.photos.find((photo) => photo.id === second)!.deletedAt).toBeNull()
    const conflict = await h.request(`/api/photos/${first}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt: null } })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'day_taken' })
    expect((await h.request(`/api/photos/${second}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt: TEST_NOW } })).status).toBe(200)
    const restore = await h.request(`/api/photos/${first}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt: null } })
    expect(restore.status).toBe(200)
    expect((await restore.json<{ photo: { deletedAt: number | null } }>()).photo.deletedAt).toBeNull()
  })

  it('removes R2 writes and rolls back the retake when the D1 batch fails', async () => {
    const user = await h.user()
    const first = photoId(17)
    const failing = photoId(18)
    expect((await h.upload(user, first)).status).toBe(201)
    await h.sql(`CREATE TRIGGER test_fail_insert BEFORE INSERT ON photos WHEN NEW.id = '${failing}' BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END`)
    try {
      expect((await h.upload(user, failing)).status).toBe(500)
      expect(await h.env.PHOTOS.get(photoKey(user.id, failing, 'master'))).toBeNull()
      expect(await h.env.PHOTOS.get(photoKey(user.id, failing, 'thumb'))).toBeNull()
      const row = await h.env.DB.prepare('SELECT deleted_at FROM photos WHERE user_id = ? AND id = ?').bind(user.id, first).first<{ deleted_at: number | null }>()
      expect(row!.deleted_at).toBeNull()
    } finally { await h.sql('DROP TRIGGER test_fail_insert') }
  })

  it('purges both R2 objects and reports the tombstone once per progressing cursor', async () => {
    const user = await h.user()
    const id = photoId(19)
    expect((await h.upload(user, id)).status).toBe(201)
    const before = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    expect((await h.request(`/api/photos/${id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(204)
    expect(await h.env.PHOTOS.get(photoKey(user.id, id, 'master'))).toBeNull()
    expect(await h.env.PHOTOS.get(photoKey(user.id, id, 'thumb'))).toBeNull()
    expect((await h.request(`/api/photos/${id}/master`, { cookie: user.cookie })).status).toBe(404)
    const next = await (await h.request(`/api/sync?since=${before.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(next.removed).toEqual([id])
    expect(next.photos).toEqual([])
    expect((await h.request(`/api/photos/${id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(204)
    const once = await (await h.request(`/api/sync?since=${next.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(once.removed).toEqual([])
    const full = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    expect(full.photos).toEqual([])
    expect(full.removed).toEqual([])
  })

  it('does not skip writes or album changes within the same millisecond', async () => {
    const user = await h.user()
    let data = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    const observed: string[] = []
    for (let index = 0; index < 4; index++) {
      const id = photoId(30 + index)
      expect((await h.upload(user, id, { meta: { dayKey: `2026-10-${20 + index}` } })).status).toBe(201)
      const next = await (await h.request(`/api/sync?since=${data.cursor}`, { cookie: user.cookie })).json<SyncData>()
      expect(next.photos.map((photo) => photo.id)).toEqual([id])
      observed.push(...next.photos.map((photo) => photo.id))
      expect(next.cursor).not.toBe(data.cursor)
      data = next
    }
    expect(new Set(observed).size).toBe(4)
    expect((await h.request('/api/albums/selfies', { method: 'PUT', cookie: user.cookie, json: { name: 'Changed', timeZone: null, createdAt: TEST_NOW } })).status).toBe(200)
    const after = await (await h.request(`/api/sync?since=${data.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(after.albums.map((album) => album.name)).toEqual(['Changed'])
    expect(after.photos).toEqual([])
    expect((await h.request('/api/sync?since=broken', { cookie: user.cookie })).status).toBe(400)
  })

  it('empties only the current user trash', async () => {
    const owner = await h.user()
    const other = await h.user()
    const id = photoId(40)
    for (const user of [owner, other]) {
      expect((await h.upload(user, id)).status).toBe(201)
      expect((await h.request(`/api/photos/${id}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt: TEST_NOW } })).status).toBe(200)
    }
    const result = await h.request('/api/trash/empty', { method: 'POST', cookie: owner.cookie })
    expect(await result.json()).toEqual({ deleted: 1 })
    expect((await h.request(`/api/photos/${id}/thumb`, { cookie: owner.cookie })).status).toBe(404)
    expect((await h.request(`/api/photos/${id}/thumb`, { cookie: other.cookie })).status).toBe(200)
    expect(await (await h.request('/api/trash/empty', { method: 'POST', cookie: owner.cookie })).json()).toEqual({ deleted: 0 })
  })

  it('purges trash older than 30 days using the scheduled time, with a strict boundary', async () => {
    const user = await h.user()
    const old = photoId(41)
    const boundary = photoId(42)
    const active = photoId(43)
    const scheduledTime = TEST_NOW + 10 * 86400000
    for (const [id, dayKey] of [[old, '2026-10-01'], [boundary, '2026-10-02'], [active, '2026-10-03']]) {
      expect((await h.upload(user, id!, { meta: { dayKey } })).status).toBe(201)
    }
    for (const [id, deletedAt] of [[old, scheduledTime - 30 * 86400000 - 1], [boundary, scheduledTime - 30 * 86400000]] as const) {
      expect((await h.request(`/api/photos/${id}`, { method: 'PATCH', cookie: user.cookie, json: { deletedAt } })).status).toBe(200)
    }
    const before = await (await h.request('/api/sync', { cookie: user.cookie })).json<SyncData>()
    const run = await h.request(`/__test/scheduled?at=${scheduledTime}`)
    expect(run.status).toBe(204)
    expect((await h.request(`/api/photos/${old}/master`, { cookie: user.cookie })).status).toBe(404)
    expect((await h.request(`/api/photos/${boundary}/master`, { cookie: user.cookie })).status).toBe(200)
    expect((await h.request(`/api/photos/${active}/master`, { cookie: user.cookie })).status).toBe(200)
    const row = await h.env.DB.prepare('SELECT purged_at, updated_at FROM photos WHERE user_id = ? AND id = ?').bind(user.id, old).first()
    expect(row).toEqual({ purged_at: scheduledTime, updated_at: scheduledTime })
    const after = await (await h.request(`/api/sync?since=${before.cursor}`, { cookie: user.cookie })).json<SyncData>()
    expect(after.removed).toEqual([old])
  })
})
