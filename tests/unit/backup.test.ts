import { describe, expect, it } from 'vitest'
import { newPhotoId } from '../../src/core/id.ts'
import { SCHEMA_VERSION, type PhotoMeta, type StoredImage } from '../../src/core/types.ts'
import {
  BackupFormatError,
  backupFilename,
  exportBackup,
  importBackup,
  parseBackup,
  parseBackupFile,
} from '../../src/storage/backup.ts'
import { deleteAllPhotos, getMaster, listMeta, putPhoto, type PhotoWrite } from '../../src/storage/photos.ts'
import { createZip, readZip, type Bytes } from '../../src/storage/zip.ts'

/** Stand-in for the canvas thumbnailer, which needs a DOM the unit env lacks. */
const fakeThumbnailer = (bytes: ArrayBuffer, mime: string): Promise<Omit<StoredImage, 'id'>> =>
  Promise.resolve({ mime, width: 24, height: 32, bytes: bytes.slice(0, Math.min(16, bytes.byteLength)) })

function pixels(seed: number, length = 512): ArrayBuffer {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out.buffer
}

function makeWrite(dayKey: string, capturedAt: number, seed: number): PhotoWrite {
  const id = newPhotoId(capturedAt)
  const master = pixels(seed)
  const meta: PhotoMeta = {
    id,
    dayKey,
    capturedAt,
    tzOffsetMinutes: -420,
    width: 1080,
    height: 1440,
    mime: 'image/jpeg',
    mirrored: true,
    source: 'camera',
    masterBytes: master.byteLength,
    thumbBytes: 16,
    schema: SCHEMA_VERSION,
  }
  return {
    meta,
    master: { id, mime: 'image/jpeg', width: 1080, height: 1440, bytes: master },
    thumb: { id, mime: 'image/jpeg', width: 24, height: 32, bytes: pixels(seed + 1, 16) },
  }
}

async function seed(count: number): Promise<PhotoWrite[]> {
  const base = Date.parse('2026-06-01T10:00:00Z')
  const writes: PhotoWrite[] = []
  for (let i = 0; i < count; i++) {
    const at = base + i * 86_400_000
    const d = new Date(at)
    const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    const write = makeWrite(dayKey, at, i + 1)
    writes.push(write)
    await putPhoto(write)
  }
  return writes
}

async function bytesOf(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer())
}

describe('backup export', () => {
  it('names the file by date', () => {
    expect(backupFilename(new Date(2026, 7, 9))).toBe('selfie-a-day-backup-2026-08-09.zip')
  })

  it('includes a manifest, a README and one image file per photo', async () => {
    await seed(3)
    const { blob, manifest } = await exportBackup()
    const files = readZip(await bytesOf(blob))

    expect(manifest.photoCount).toBe(3)
    expect(files.has('manifest.json')).toBe(true)
    expect(files.has('README.txt')).toBe(true)
    // Dated, ordinary image files — usable without this app at all.
    const photoNames = [...files.keys()].filter((n) => n.startsWith('photos/'))
    expect(photoNames).toHaveLength(3)
    expect(photoNames.every((n) => n.endsWith('.jpg'))).toBe(true)
  })

  it('reports progress for every photo', async () => {
    await seed(4)
    const seen: number[] = []
    await exportBackup((done, total) => {
      expect(total).toBe(4)
      seen.push(done)
    })
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('exports the exact stored bytes', async () => {
    const [write] = await seed(1)
    const { blob } = await exportBackup()
    const files = readZip(await bytesOf(blob))
    const exported = [...files.entries()].find(([name]) => name.startsWith('photos/'))![1]
    expect([...exported]).toEqual([...new Uint8Array(write!.master.bytes)])
  })
})

describe('backup round trip', () => {
  it('restores every photo after the device has been wiped', async () => {
    const originals = await seed(5)
    const { blob } = await exportBackup()
    const archive = await bytesOf(blob)

    await deleteAllPhotos()
    expect(await listMeta()).toHaveLength(0)

    const result = await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })
    expect(result).toMatchObject({ imported: 5, skipped: 0 })
    expect(result.problems).toEqual([])

    const restored = await listMeta()
    expect(restored).toHaveLength(5)
    expect(restored.map((m) => m.dayKey).sort()).toEqual(originals.map((w) => w.meta.dayKey).sort())
  })

  it('restores pixels byte-for-byte, not just metadata', async () => {
    const [original] = await seed(1)
    const archive = await bytesOf((await exportBackup()).blob)
    await deleteAllPhotos()
    await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })

    const restored = (await listMeta())[0]!
    const master = await getMaster(restored.id)
    expect([...new Uint8Array(master!.bytes)]).toEqual([...new Uint8Array(original!.master.bytes)])
  })

  it('preserves capture time, timezone and mirroring', async () => {
    const [original] = await seed(1)
    const archive = await bytesOf((await exportBackup()).blob)
    await deleteAllPhotos()
    await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })

    const restored = (await listMeta())[0]!
    expect(restored.capturedAt).toBe(original!.meta.capturedAt)
    expect(restored.tzOffsetMinutes).toBe(original!.meta.tzOffsetMinutes)
    expect(restored.mirrored).toBe(original!.meta.mirrored)
    expect(restored.width).toBe(original!.meta.width)
    expect(restored.height).toBe(original!.meta.height)
  })

  it('is idempotent — importing the same backup twice does not duplicate days', async () => {
    await seed(3)
    const archive = await bytesOf((await exportBackup()).blob)

    await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })
    await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })

    expect(await listMeta()).toHaveLength(3)
  })

  it('merges into an existing library, leaving untouched days alone', async () => {
    await seed(2)
    const archive = await bytesOf((await exportBackup()).blob)
    await deleteAllPhotos()

    const later = makeWrite('2026-12-25', Date.parse('2026-12-25T10:00:00Z'), 99)
    await putPhoto(later)

    await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })
    const metas = await listMeta()
    expect(metas).toHaveLength(3)
    expect(metas[0]?.dayKey).toBe('2026-12-25')
  })

  /**
   * The case the test above does NOT cover, and which used to lose data: the
   * backup and the device both hold a photo for the same day. Restoring must
   * not throw away the newer one. Deleting a single photo asks for a two-tap
   * confirm; a restore could otherwise destroy an unbounded number behind one
   * tap and a green toast.
   */
  it('keeps a photo taken after the backup instead of overwriting it', async () => {
    const original = makeWrite('2026-08-11', Date.parse('2026-08-11T09:00:00Z'), 1)
    await putPhoto(original)
    const archive = await bytesOf((await exportBackup()).blob)
    await deleteAllPhotos()

    const newer = makeWrite('2026-08-11', Date.parse('2026-08-11T20:00:00Z'), 2)
    await putPhoto(newer)

    const result = await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })

    const after = await listMeta()
    expect(after).toHaveLength(1)
    expect(after[0]!.capturedAt, 'the newer photo must survive a restore').toBe(newer.meta.capturedAt)
    expect(after[0]!.id).toBe(newer.meta.id)

    // And the user is told, rather than the loss being hidden behind a success.
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.problems[0]).toMatch(/kept the photo already on this device/i)
  })

  it('still restores when the backup copy is the newer one', async () => {
    const older = makeWrite('2026-08-11', Date.parse('2026-08-11T08:00:00Z'), 1)
    await putPhoto(older)

    const newer = makeWrite('2026-08-11', Date.parse('2026-08-11T21:00:00Z'), 2)
    await putPhoto(newer)
    const archive = await bytesOf((await exportBackup()).blob)

    await deleteAllPhotos()
    await putPhoto(older)

    const result = await importBackup(parseBackup(archive), { makeThumbnail: fakeThumbnailer })
    const after = await listMeta()
    expect(after).toHaveLength(1)
    expect(after[0]!.capturedAt).toBe(newer.meta.capturedAt)
    expect(result.imported).toBe(1)
  })

  it('counts manifest entries it could not read, instead of reporting a clean restore', async () => {
    const good = {
      id: newPhotoId(),
      dayKey: '2026-08-09',
      capturedAt: Date.now(),
      tzOffsetMinutes: 0,
      width: 1080,
      height: 1440,
      mime: 'image/jpeg',
      mirrored: true,
      source: 'camera',
      file: 'photos/2026-08-09.jpg',
    }
    const encoder = new TextEncoder()
    const zip = await bytesOf(
      createZip([
        {
          name: 'manifest.json',
          data: encoder.encode(
            JSON.stringify({
              format: 'selfie-a-day/backup',
              formatVersion: 1,
              photos: [good, { dayKey: 'not-a-day', file: 'photos/x.jpg' }],
            }),
          ),
        },
        { name: 'photos/2026-08-09.jpg', data: new Uint8Array(32).fill(5) },
      ]),
    )

    const parsed = parseBackup(zip)
    expect(parsed.rejected).toBe(1)

    const result = await importBackup(parsed, { makeThumbnail: fakeThumbnailer })
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.problems.join(' ')).toMatch(/unreadable/i)
  })

  it('writes in batches across a large restore', async () => {
    await seed(60)
    const archive = await bytesOf((await exportBackup()).blob)
    await deleteAllPhotos()

    const result = await importBackup(parseBackup(archive), {
      makeThumbnail: fakeThumbnailer,
      batchSize: 7,
    })
    expect(result.imported).toBe(60)
    expect(await listMeta()).toHaveLength(60)
  })
})

describe('backup validation', () => {
  const encoder = new TextEncoder()

  it('rejects a ZIP that is not a Selfie a Day backup', async () => {
    const zip = await bytesOf(createZip([{ name: 'hello.txt', data: encoder.encode('hi') }]))
    expect(() => parseBackup(zip)).toThrow(BackupFormatError)
  })

  it('rejects a manifest written by a newer format version', async () => {
    const zip = createZip([
      {
        name: 'manifest.json',
        data: encoder.encode(
          JSON.stringify({ format: 'selfie-a-day/backup', formatVersion: 99, photos: [] }),
        ),
      },
    ])
    const bytes = await bytesOf(zip)
    expect(() => parseBackup(bytes)).toThrow(/newer version/i)
  })

  it('rejects a damaged manifest', async () => {
    const zip = await bytesOf(createZip([{ name: 'manifest.json', data: encoder.encode('{not json') }]))
    expect(() => parseBackup(zip)).toThrow(/not valid JSON/i)
  })

  it('reports a photo listed in the manifest but missing from the ZIP', async () => {
    const zip = createZip([
      {
        name: 'manifest.json',
        data: encoder.encode(
          JSON.stringify({
            format: 'selfie-a-day/backup',
            formatVersion: 1,
            photos: [
              {
                id: newPhotoId(),
                dayKey: '2026-08-09',
                capturedAt: Date.now(),
                tzOffsetMinutes: 0,
                width: 1080,
                height: 1440,
                mime: 'image/jpeg',
                mirrored: true,
                source: 'camera',
                file: 'photos/2026-08-09.jpg',
              },
            ],
          }),
        ),
      },
    ])

    const result = await importBackup(parseBackup(await bytesOf(zip)), {
      makeThumbnail: fakeThumbnailer,
    })
    expect(result).toMatchObject({ imported: 0, skipped: 1 })
    expect(result.problems[0]).toMatch(/missing from the ZIP/i)
  })

  it('drops malformed manifest entries instead of importing garbage', async () => {
    const zip = createZip([
      {
        name: 'manifest.json',
        data: encoder.encode(
          JSON.stringify({
            format: 'selfie-a-day/backup',
            formatVersion: 1,
            photos: [
              { dayKey: 'nonsense', file: 'photos/x.jpg', capturedAt: 1, width: 1, height: 1, mime: 'image/jpeg' },
              { dayKey: '2026-08-09', file: 'photos/y.jpg', capturedAt: 1, width: 0, height: 1, mime: 'image/jpeg' },
              { dayKey: '2026-08-09', file: 'photos/z.jpg', capturedAt: 1, width: 1, height: 1, mime: 'text/plain' },
            ],
          }),
        ),
      },
    ])
    const parsed = parseBackup(await bytesOf(zip))
    expect(parsed.manifest.photos).toHaveLength(0)
  })
})

describe('streaming restore', () => {
  it('parses and restores from a Blob without materialising the archive', async () => {
    const originals = await seed(4)
    const { blob } = await exportBackup()
    await deleteAllPhotos()

    // parseBackupFile reads only the archive's tail plus the manifest up front.
    const parsed = await parseBackupFile(blob)
    expect(parsed.manifest.photoCount).toBe(4)
    expect(parsed.rejected).toBe(0)

    const result = await importBackup(parsed, { makeThumbnail: fakeThumbnailer })
    expect(result).toMatchObject({ imported: 4, skipped: 0 })

    const restored = await listMeta()
    expect(restored.map((m) => m.dayKey).sort()).toEqual(originals.map((w) => w.meta.dayKey).sort())
  })

  it('catalogues a large archive without reading the photos', async () => {
    // Realistic photo sizes: the point of streaming is that a 100 KB photo is
    // not touched until it is needed. With toy payloads the manifest and the
    // 64 KB tail scan dominate and the property is unobservable.
    const base = Date.parse('2026-03-01T10:00:00Z')
    for (let i = 0; i < 6; i++) {
      const at = base + i * 86_400_000
      const d = new Date(at)
      const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
      const write = makeWrite(dayKey, at, i + 1)
      const big = pixels(i + 1, 120_000)
      await putPhoto({
        ...write,
        meta: { ...write.meta, masterBytes: big.byteLength },
        master: { ...write.master, bytes: big },
      })
    }
    const { blob } = await exportBackup()
    expect(blob.size).toBeGreaterThan(700_000)

    // Count how much of the archive is actually pulled into memory. A plain
    // object is enough: parseBackupFile only needs size/slice/arrayBuffer.
    let sliced = 0
    const counting = {
      size: blob.size,
      slice: (start?: number, end?: number): Blob => {
        const part = blob.slice(start, end)
        sliced += part.size
        return part
      },
      arrayBuffer: () => blob.arrayBuffer(),
    } as unknown as Blob

    const parsed = await parseBackupFile(counting)
    // Cataloguing costs the tail and the manifest, not the photos.
    expect(sliced).toBeLessThan(blob.size)
    expect(parsed.manifest.photoCount).toBe(6)
  })

  it('reports a damaged archive rather than throwing a raw error', async () => {
    const junk = new Blob([new Uint8Array(200).fill(9)])
    await expect(parseBackupFile(junk)).rejects.toThrow(BackupFormatError)
  })
})
