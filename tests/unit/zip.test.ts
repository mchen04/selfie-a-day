import { describe, expect, it } from 'vitest'
import { createZip, crc32, readZip, ZipError, type Bytes } from '../../src/storage/zip.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function toBytes(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer())
}

function randomBytes(n: number, seed = 1): Bytes {
  // Deterministic pseudo-random so a failure is reproducible.
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

describe('crc32', () => {
  it('matches the standard test vector', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('createZip / readZip', () => {
  it('round-trips text and binary entries', async () => {
    const photo = randomBytes(5000)
    const zip = createZip([
      { name: 'manifest.json', data: encoder.encode('{"format":"test"}') },
      { name: 'photos/2026-08-09.jpg', data: photo },
    ])

    const files = readZip(await toBytes(zip))
    expect([...files.keys()].sort()).toEqual(['manifest.json', 'photos/2026-08-09.jpg'])
    expect(decoder.decode(files.get('manifest.json'))).toBe('{"format":"test"}')
    expect([...files.get('photos/2026-08-09.jpg')!]).toEqual([...photo])
  })

  it('produces a file starting with the ZIP local-header signature', async () => {
    const bytes = await toBytes(createZip([{ name: 'a.txt', data: encoder.encode('hi') }]))
    // "PK\x03\x04" — this is what makes the export openable by Finder/Explorer.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('handles an empty archive', async () => {
    const files = readZip(await toBytes(createZip([])))
    expect(files.size).toBe(0)
  })

  it('handles a zero-byte entry', async () => {
    const files = readZip(await toBytes(createZip([{ name: 'empty.bin', data: new Uint8Array(0) }])))
    expect(files.get('empty.bin')?.length).toBe(0)
  })

  it('preserves non-ASCII names via the UTF-8 flag', async () => {
    const name = 'photos/2026-08-09-café-日本.jpg'
    const files = readZip(await toBytes(createZip([{ name, data: encoder.encode('x') }])))
    expect(files.has(name)).toBe(true)
  })

  it('round-trips many entries', async () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      name: `photos/photo-${i}.jpg`,
      data: randomBytes(64 + i, i + 1),
    }))
    const files = readZip(await toBytes(createZip(entries)))
    expect(files.size).toBe(200)
    expect([...files.get('photos/photo-199.jpg')!]).toEqual([...entries[199]!.data])
  })

  it('detects a corrupted payload through the checksum', async () => {
    const bytes = await toBytes(createZip([{ name: 'photo.jpg', data: randomBytes(400) }]))
    // Flip a byte inside the stored data, past the 30-byte local header + name.
    const target = 30 + 'photo.jpg'.length + 10
    bytes[target] = bytes[target]! ^ 0xff
    expect(() => readZip(bytes)).toThrow(ZipError)
    expect(() => readZip(bytes)).toThrow(/checksum/i)
  })
})
