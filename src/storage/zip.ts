/**
 * A minimal ZIP writer, stored (uncompressed) only.
 *
 * Download my photos produces a real `.zip` the user can open in Finder or
 * Explorer and see their photos as ordinary dated JPEGs, without this app.
 *
 * Stored, not deflated, because JPEG/WebP bytes do not compress further — the
 * CPU cost would buy roughly nothing and would risk stalling the main thread on
 * a phone.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD_SIZE = 22
const UTF8_FLAG = 0x0800
/** ZIP without ZIP64 cannot address beyond these; we refuse rather than corrupt. */
const MAX_ENTRIES = 0xffff
const MAX_TOTAL_BYTES = 0xffffffff

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Byte arrays here are always backed by a real `ArrayBuffer`, never a
 * `SharedArrayBuffer` — `Blob` will not accept the latter, and pinning the type
 * catches that at the boundary instead of at runtime.
 */
export type Bytes = Uint8Array<ArrayBuffer>

export interface ZipEntry {
  name: string
  /**
   * A `Blob` keeps the payload in the browser's blob store rather than the JS
   * heap, which is what lets a multi-gigabyte archive be built one photo at a
   * time. Pass `crc` and `size` alongside it — they cannot be derived from a
   * Blob without reading it back into memory, defeating the point.
   */
  data: Bytes | Blob
  crc?: number
  size?: number
  date?: Date
}

export class ZipError extends Error {
  override name = 'ZipError'
}

function dosDateTime(date: Date): { time: number; date: number } {
  // The DOS epoch starts in 1980; clamp rather than emit a negative year.
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

export function createZip(entries: readonly ZipEntry[]): Blob {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError(`Too many files for a standard ZIP (${entries.length} > ${MAX_ENTRIES}).`)
  }

  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: Bytes[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const isBlob = entry.data instanceof Blob
    if (isBlob && (entry.crc === undefined || entry.size === undefined)) {
      throw new ZipError(`"${entry.name}" was passed as a Blob without a precomputed crc and size.`)
    }
    const crc = entry.crc ?? crc32(entry.data as Bytes)
    const size = entry.size ?? (entry.data as Bytes).length
    const { time, date } = dosDateTime(entry.date ?? new Date())

    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, LOCAL_SIG, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, UTF8_FLAG, true)
    view.setUint16(8, 0, true) // stored
    view.setUint16(10, time, true)
    view.setUint16(12, date, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, size, true)
    view.setUint32(22, size, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    header.set(name, 30)

    const record = new Uint8Array(46 + name.length)
    const rview = new DataView(record.buffer)
    rview.setUint32(0, CENTRAL_SIG, true)
    rview.setUint16(4, 20, true)
    rview.setUint16(6, 20, true)
    rview.setUint16(8, UTF8_FLAG, true)
    rview.setUint16(10, 0, true)
    rview.setUint16(12, time, true)
    rview.setUint16(14, date, true)
    rview.setUint32(16, crc, true)
    rview.setUint32(20, size, true)
    rview.setUint32(24, size, true)
    rview.setUint16(28, name.length, true)
    rview.setUint32(42, offset, true)
    record.set(name, 46)

    parts.push(header, entry.data)
    central.push(record)
    offset += header.length + size

    if (offset > MAX_TOTAL_BYTES) {
      throw new ZipError('The download exceeds the 4 GB limit of a standard ZIP.')
    }
  }

  const centralSize = central.reduce((sum, r) => sum + r.length, 0)
  const eocd = new Uint8Array(EOCD_SIZE)
  const eview = new DataView(eocd.buffer)
  eview.setUint32(0, EOCD_SIG, true)
  eview.setUint16(8, entries.length, true)
  eview.setUint16(10, entries.length, true)
  eview.setUint32(12, centralSize, true)
  eview.setUint32(16, offset, true)

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' })
}
