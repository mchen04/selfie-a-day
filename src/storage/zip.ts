/**
 * A minimal ZIP writer and reader, stored (uncompressed) only.
 *
 * Export produces a real `.zip` the user can open in Finder or Explorer and see
 * their photos as ordinary dated JPEGs. That matters more than it sounds: the
 * loudest complaint about every app in this category is photos being stranded
 * inside an app that stopped working. A backup that is useless without the app
 * that wrote it is not a backup.
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
      throw new ZipError('Backup exceeds the 4 GB limit of a standard ZIP.')
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

/** Read a stored-method ZIP into name -> bytes. */
export function readZip(bytes: Bytes): Map<string, Bytes> {
  try {
    return readZipUnchecked(bytes)
  } catch (err) {
    // DataView reads past the end throw RangeError. A user handed a truncated
    // file deserves "the backup file is damaged", not a stack trace.
    if (err instanceof RangeError) {
      throw new ZipError('This ZIP is incomplete or damaged — the file may not have finished copying.')
    }
    throw err
  }
}

function readZipUnchecked(bytes: Bytes): Map<string, Bytes> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let eocd = -1
  const earliest = Math.max(0, bytes.length - EOCD_SIZE - 0xffff)
  for (let i = bytes.length - EOCD_SIZE; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file: end-of-archive record missing.')

  const count = view.getUint16(eocd + 10, true)
  let pointer = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const out = new Map<string, Bytes>()

  for (let i = 0; i < count; i++) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== CENTRAL_SIG) {
      throw new ZipError(`Corrupt ZIP: bad directory entry ${i + 1} of ${count}.`)
    }
    const method = view.getUint16(pointer + 10, true)
    const compressedSize = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    const localOffset = view.getUint32(pointer + 42, true)
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength))

    if (method !== 0) {
      throw new ZipError(`"${name}" is compressed; this backup reader only supports stored entries.`)
    }
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new ZipError(`Corrupt ZIP: "${name}" has no local header.`)
    }

    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(start, start + compressedSize)

    const expectedCrc = view.getUint32(pointer + 16, true)
    if (crc32(data) !== expectedCrc) {
      throw new ZipError(`"${name}" failed its checksum — the backup file is damaged.`)
    }

    out.set(name, data)
    pointer += 46 + nameLength + extraLength + commentLength
  }

  return out
}

export interface ZipIndexEntry {
  name: string
  /** Offset of this entry's local file header within the archive. */
  localOffset: number
  size: number
  crc: number
}

/**
 * Read only the central directory, from the end of the archive.
 *
 * A ZIP's index lives at the tail, so an archive of any size can be catalogued
 * from a few kilobytes. That is what lets a restore stream: the caller pulls one
 * photo at a time instead of materialising a multi-hundred-megabyte backup —
 * the same failure `exportBackup` was rewritten to avoid, and the reason import
 * must not be left as its asymmetric twin.
 */
export async function readZipIndex(archive: Blob): Promise<ZipIndexEntry[]> {
  const tailLength = Math.min(archive.size, EOCD_SIZE + 0xffff)
  const tail = new Uint8Array(await archive.slice(archive.size - tailLength).arrayBuffer())
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

  let eocd = -1
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file: end-of-archive record missing.')

  const count = tailView.getUint16(eocd + 10, true)
  const directorySize = tailView.getUint32(eocd + 12, true)
  const directoryOffset = tailView.getUint32(eocd + 16, true)

  const directory = new Uint8Array(
    await archive.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer(),
  )
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)
  const decoder = new TextDecoder()
  const entries: ZipIndexEntry[] = []

  let pointer = 0
  for (let i = 0; i < count; i++) {
    if (pointer + 46 > directory.length || view.getUint32(pointer, true) !== CENTRAL_SIG) {
      throw new ZipError(`Corrupt ZIP: bad directory entry ${i + 1} of ${count}.`)
    }
    const method = view.getUint16(pointer + 10, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const name = decoder.decode(directory.subarray(pointer + 46, pointer + 46 + nameLength))
    if (method !== 0) {
      throw new ZipError(`"${name}" is compressed; this backup reader only supports stored entries.`)
    }
    entries.push({
      name,
      crc: view.getUint32(pointer + 16, true),
      size: view.getUint32(pointer + 20, true),
      localOffset: view.getUint32(pointer + 42, true),
    })
    pointer +=
      46 + nameLength + view.getUint16(pointer + 30, true) + view.getUint16(pointer + 32, true)
  }

  return entries
}

/** Read and verify a single entry's bytes, without touching the rest. */
export async function readZipEntry(archive: Blob, entry: ZipIndexEntry): Promise<Bytes> {
  const header = new Uint8Array(
    await archive.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer(),
  )
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (view.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipError(`Corrupt ZIP: "${entry.name}" has no local header.`)
  }

  const start = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
  const data = new Uint8Array(await archive.slice(start, start + entry.size).arrayBuffer())
  if (crc32(data) !== entry.crc) {
    throw new ZipError(`"${entry.name}" failed its checksum — the backup file is damaged.`)
  }
  return data
}
