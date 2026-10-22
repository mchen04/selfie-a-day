import { crc32, ZipError, type Bytes } from '../../src/storage/zip.ts'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD_SIZE = 22

/** Reads a stored-method ZIP as createZip writes it (no archive comment) into name -> bytes, verifying every checksum. */
export function readZip(bytes: Bytes): Map<string, Bytes> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = bytes.length - EOCD_SIZE
  if (eocd < 0 || view.getUint32(eocd, true) !== EOCD_SIG) throw new ZipError('Not a ZIP file: end-of-archive record missing.')
  const count = view.getUint16(eocd + 10, true)
  let pointer = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const out = new Map<string, Bytes>()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pointer, true) !== CENTRAL_SIG) throw new ZipError(`Corrupt ZIP: bad directory entry ${i + 1} of ${count}.`)
    const method = view.getUint16(pointer + 10, true)
    const size = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const localOffset = view.getUint32(pointer + 42, true)
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength))
    if (method !== 0) throw new ZipError(`"${name}" is compressed; only stored entries are written.`)
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new ZipError(`Corrupt ZIP: "${name}" has no local header.`)
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const data = bytes.subarray(start, start + size)
    if (crc32(data) !== view.getUint32(pointer + 16, true)) throw new ZipError(`"${name}" failed its checksum.`)
    out.set(name, data)
    pointer += 46 + nameLength + view.getUint16(pointer + 30, true) + view.getUint16(pointer + 32, true)
  }
  return out
}
