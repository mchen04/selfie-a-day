import { afterEach, expect, it, vi } from 'vitest'
import { downloadPhotos } from '../../../src/storage/download.ts'
import { readZip } from '../../../src/storage/zip.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { photo } from './fixtures.ts'

afterEach(() => vi.unstubAllGlobals())

it('downloads masters into a normal ZIP with progress', async () => {
  const images = [photo(), photo(1_800_000_000_001)]
  const request = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } })))
  vi.stubGlobal('fetch', request)
  const progress = vi.fn()
  const archive = await downloadPhotos(images, [defaultAlbum()], new AbortController().signal, progress)
  const files = readZip(new Uint8Array(await archive.arrayBuffer()))
  expect(files.size).toBe(2)
  expect([...files.keys()].every((name) => name.startsWith('Selfies-selfies/'))).toBe(true)
  expect([...files.values()].map((bytes) => [...bytes])).toEqual([[1, 2, 3], [1, 2, 3]])
  expect(progress.mock.calls).toEqual([[1, 2], [2, 2]])
  expect(request.mock.calls).toHaveLength(2)
})

it('cancels before reading any master', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const controller = new AbortController()
  controller.abort()
  await expect(downloadPhotos([photo()], [defaultAlbum()], controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' })
  expect(request).not.toHaveBeenCalled()
})

it('names the ZIP for today on this device, not the UTC date (an evening export in Los Angeles)', async () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-11-03T05:00:00Z')) // Mon 2 Nov, 21:00 PST
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/webp' } }))))
    const archive = await downloadPhotos([photo()], [defaultAlbum()], new AbortController().signal, () => {})
    expect(archive.name).toBe('selfie-a-day-2026-11-02.zip')
  } finally {
    vi.useRealTimers()
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})
