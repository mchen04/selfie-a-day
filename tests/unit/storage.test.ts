import { describe, expect, it } from 'vitest'
import { dayKeyOf } from '../../src/core/day.ts'
import { newPhotoId } from '../../src/core/id.ts'
import { SCHEMA_VERSION, type PhotoMeta } from '../../src/core/types.ts'
import {
  deleteAllPhotos,
  deletePhoto,
  getMaster,
  getThumb,
  listMeta,
  putPhoto,
  putPhotos,
  type PhotoWrite,
} from '../../src/storage/photos.ts'

/**
 * The ghost is whatever the app would show: the newest row from listMeta().
 * Asserting through that path rather than a dedicated helper keeps the test
 * honest about what the screen actually reads.
 */
async function ghostSource() {
  return (await listMeta())[0] ?? null
}

function bytes(n: number, fill = 7): ArrayBuffer {
  return new Uint8Array(n).fill(fill).buffer
}

function makeWrite(dayKey: string, capturedAt: number, opts: Partial<PhotoMeta> = {}): PhotoWrite {
  const id = opts.id ?? newPhotoId(capturedAt)
  const meta: PhotoMeta = {
    id,
    dayKey,
    capturedAt,
    tzOffsetMinutes: 0,
    width: 1080,
    height: 1440,
    mime: 'image/jpeg',
    mirrored: true,
    source: 'camera',
    masterBytes: 1000,
    thumbBytes: 100,
    schema: SCHEMA_VERSION,
    ...opts,
  }
  return {
    meta,
    master: { id, mime: meta.mime, width: 1080, height: 1440, bytes: bytes(1000) },
    thumb: { id, mime: meta.mime, width: 240, height: 320, bytes: bytes(100, 3) },
  }
}

describe('photo repository', () => {
  it('stores and reads back a photo with its pixels intact', async () => {
    const write = makeWrite('2026-08-09', Date.parse('2026-08-09T10:00:00Z'))
    await putPhoto(write)

    const metas = await listMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0]?.dayKey).toBe('2026-08-09')

    const master = await getMaster(write.meta.id)
    expect(master?.bytes.byteLength).toBe(1000)
    expect(new Uint8Array(master!.bytes)[0]).toBe(7)

    const thumb = await getThumb(write.meta.id)
    expect(thumb?.bytes.byteLength).toBe(100)
    expect(new Uint8Array(thumb!.bytes)[0]).toBe(3)
  })

  it('returns metadata newest first', async () => {
    await putPhoto(makeWrite('2026-08-07', Date.parse('2026-08-07T10:00:00Z')))
    await putPhoto(makeWrite('2026-08-09', Date.parse('2026-08-09T10:00:00Z')))
    await putPhoto(makeWrite('2026-08-08', Date.parse('2026-08-08T10:00:00Z')))

    const metas = await listMeta()
    expect(metas.map((m) => m.dayKey)).toEqual(['2026-08-09', '2026-08-08', '2026-08-07'])
  })

  it('derives the ghost from the most recent capture', async () => {
    await putPhoto(makeWrite('2026-08-07', Date.parse('2026-08-07T10:00:00Z')))
    await putPhoto(makeWrite('2026-08-09', Date.parse('2026-08-09T10:00:00Z')))
    expect((await ghostSource())?.dayKey).toBe('2026-08-09')
  })

  it('replaces the existing photo when the same day is captured again', async () => {
    const first = makeWrite('2026-08-09', Date.parse('2026-08-09T09:00:00Z'))
    await putPhoto(first)
    const second = makeWrite('2026-08-09', Date.parse('2026-08-09T21:00:00Z'))
    await putPhoto(second)

    const metas = await listMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0]?.id).toBe(second.meta.id)

    // The superseded photo's pixels must be gone too, not orphaned in storage.
    expect(await getMaster(first.meta.id)).toBeNull()
    expect(await getThumb(first.meta.id)).toBeNull()
    expect((await listMeta()).filter((m) => m.dayKey === '2026-08-09')).toHaveLength(1)
  })

  it('re-derives the ghost after the newest photo is deleted', async () => {
    const older = makeWrite('2026-08-08', Date.parse('2026-08-08T10:00:00Z'))
    const newest = makeWrite('2026-08-09', Date.parse('2026-08-09T10:00:00Z'))
    await putPhoto(older)
    await putPhoto(newest)
    expect((await ghostSource())?.id).toBe(newest.meta.id)

    await deletePhoto(newest.meta.id)

    expect((await ghostSource())?.id).toBe(older.meta.id)
    expect(await getMaster(newest.meta.id)).toBeNull()
    expect(await getThumb(newest.meta.id)).toBeNull()
  })

  it('leaves no ghost at all once every photo is deleted', async () => {
    const only = makeWrite('2026-08-09', Date.parse('2026-08-09T10:00:00Z'))
    await putPhoto(only)
    await deletePhoto(only.meta.id)
    expect(await ghostSource()).toBeNull()
    expect(await listMeta()).toHaveLength(0)
  })

  it('writes a batch atomically', async () => {
    const writes = Array.from({ length: 30 }, (_, i) =>
      makeWrite(`2026-07-${String(i + 1).padStart(2, '0')}`, Date.parse('2026-07-01T10:00:00Z') + i * 86_400_000),
    )
    await putPhotos(writes)

    const metas = await listMeta()
    expect(metas).toHaveLength(30)
    // Byte totals come from metadata alone — Settings never reads pixels to
    // report how much space the library uses.
    expect(metas.reduce((sum, m) => sum + m.masterBytes + m.thumbBytes, 0)).toBe(30 * 1100)
  })

  it('deduplicates by day inside a batch import', async () => {
    const a = makeWrite('2026-08-09', Date.parse('2026-08-09T09:00:00Z'))
    const b = makeWrite('2026-08-09', Date.parse('2026-08-09T18:00:00Z'))
    await putPhotos([a, b])

    const metas = await listMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0]?.id).toBe(b.meta.id)
  })

  it('clears everything on request', async () => {
    await putPhoto(makeWrite('2026-08-09', Date.now()))
    await deleteAllPhotos()
    expect(await listMeta()).toHaveLength(0)
    expect(await ghostSource()).toBeNull()
  })

  it('handles a 200-photo timeline', async () => {
    const base = Date.parse('2026-01-01T10:00:00Z')
    const writes = Array.from({ length: 200 }, (_, i) =>
      makeWrite(dayKeyOf(new Date(base + i * 86_400_000)), base + i * 86_400_000),
    )
    await putPhotos(writes)

    const metas = await listMeta()
    expect(metas).toHaveLength(200)
    // Newest first, and strictly ordered.
    for (let i = 1; i < metas.length; i++) {
      expect(metas[i - 1]!.capturedAt).toBeGreaterThan(metas[i]!.capturedAt)
    }
  })
})
