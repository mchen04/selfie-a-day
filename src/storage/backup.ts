import { isDayKey } from '../core/day.ts'
import { isPhotoId, newPhotoId } from '../core/id.ts'
import { SCHEMA_VERSION, type PhotoMeta, type StoredImage } from '../core/types.ts'
import { getMaster, listMeta, putPhotos, type PhotoWrite } from './photos.ts'
import {
  createZip,
  crc32,
  readZip,
  readZipEntry,
  readZipIndex,
  ZipError,
  type Bytes,
  type ZipEntry,
} from './zip.ts'

export const BACKUP_FORMAT = 'selfie-a-day/backup'
export const BACKUP_FORMAT_VERSION = 1

const MANIFEST_NAME = 'manifest.json'
const README_NAME = 'README.txt'
const PHOTO_DIR = 'photos/'

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
}

export interface BackupManifestEntry {
  id: string
  dayKey: string
  capturedAt: number
  tzOffsetMinutes: number
  width: number
  height: number
  mime: string
  mirrored: boolean
  source: string
  file: string
}

export interface BackupManifest {
  format: string
  formatVersion: number
  schema: number
  exportedAt: number
  photoCount: number
  photos: BackupManifestEntry[]
}

const README = `Selfie a Day — backup
=====================

Everything in this archive came off one device and never touched a server.

  photos/       your photos, one per day, named by the date they were taken.
                These are ordinary image files. You can open, copy, print or
                keep them without this app, forever.
  manifest.json the capture time, timezone and orientation of each photo, so
                the app can restore your timeline exactly.

To restore: open Selfie a Day, go to Settings, choose "Restore from backup"
and pick this .zip file.

If this app ever disappears, the photos/ folder is still just your photos.
`

function extensionFor(mime: string): string {
  return EXTENSIONS[mime] ?? 'bin'
}

/**
 * Build a restorable archive of every photo.
 *
 * Thumbnails are omitted and regenerated on import: they are derived data, and
 * leaving them out makes the archive roughly a third smaller with no loss.
 *
 * Each master is turned into a Blob and its checksum taken as it is read, so
 * only one photo's bytes are ever in the JS heap. Accumulating them instead put
 * the whole library in memory — measured at 624 MB of heap and a 1.3 s frozen
 * main thread for a 617 MB library. Export is the *only* protection against
 * losing a decade of photos, and the app actively nags people towards it, so it
 * failing first for the longest-standing user is precisely the wrong failure.
 */
export async function exportBackup(
  onProgress?: (done: number, total: number) => void,
): Promise<{ blob: Blob; manifest: BackupManifest }> {
  const metas = await listMeta()
  // Oldest first so the archive reads chronologically in a file browser.
  const ordered = [...metas].reverse()

  const entries: ZipEntry[] = []
  const manifestPhotos: BackupManifestEntry[] = []
  const usedNames = new Set<string>()

  for (const [index, meta] of ordered.entries()) {
    const master = await getMaster(meta.id)
    if (!master) continue // Metadata without pixels cannot be restored; skip it.

    let name = `${PHOTO_DIR}${meta.dayKey}.${extensionFor(meta.mime)}`
    if (usedNames.has(name)) name = `${PHOTO_DIR}${meta.dayKey}-${meta.id}.${extensionFor(meta.mime)}`
    usedNames.add(name)

    // Checksum now, while the bytes are here, then hand them to a Blob and let
    // this iteration's copy go. Peak heap stays at one photo.
    const bytes = new Uint8Array(master.bytes)
    entries.push({
      name,
      data: new Blob([bytes]),
      crc: crc32(bytes),
      size: bytes.length,
      date: new Date(meta.capturedAt),
    })
    manifestPhotos.push({
      id: meta.id,
      dayKey: meta.dayKey,
      capturedAt: meta.capturedAt,
      tzOffsetMinutes: meta.tzOffsetMinutes,
      width: meta.width,
      height: meta.height,
      mime: meta.mime,
      mirrored: meta.mirrored,
      source: meta.source,
      file: name,
    })

    onProgress?.(index + 1, ordered.length)
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schema: SCHEMA_VERSION,
    exportedAt: Date.now(),
    photoCount: manifestPhotos.length,
    photos: manifestPhotos,
  }

  const encoder = new TextEncoder()
  const blob = createZip([
    { name: MANIFEST_NAME, data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { name: README_NAME, data: encoder.encode(README) },
    ...entries,
  ])

  return { blob, manifest }
}

export function backupFilename(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`
  return `selfie-a-day-backup-${stamp}.zip`
}

export class BackupFormatError extends Error {
  override name = 'BackupFormatError'
}

export interface ParsedBackup {
  manifest: BackupManifest
  /** Manifest entries dropped as malformed. Counted so a partial restore is not
   *  reported as a complete one. */
  rejected: number
  /**
   * Fetch one entry's bytes. Asynchronous so a restore can stream a photo at a
   * time out of a `File` rather than holding the whole archive in the heap.
   */
  readFile(name: string): Promise<Bytes | undefined>
}

function isValidEntry(value: unknown): value is BackupManifestEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.file === 'string' &&
    isDayKey(e.dayKey) &&
    typeof e.capturedAt === 'number' &&
    Number.isFinite(e.capturedAt) &&
    typeof e.width === 'number' &&
    e.width > 0 &&
    typeof e.height === 'number' &&
    e.height > 0 &&
    typeof e.mime === 'string' &&
    e.mime.startsWith('image/')
  )
}

/** In-memory parse. Convenient for small archives and for tests. */
export function parseBackup(bytes: Bytes): ParsedBackup {
  let files: Map<string, Bytes>
  try {
    files = readZip(bytes)
  } catch (err) {
    if (err instanceof ZipError) throw new BackupFormatError(err.message)
    throw err
  }

  const manifestBytes = files.get(MANIFEST_NAME)
  if (!manifestBytes) {
    throw new BackupFormatError('This ZIP has no manifest.json, so it is not a Selfie a Day backup.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch {
    throw new BackupFormatError('manifest.json is not valid JSON — the backup file is damaged.')
  }

  const manifest = validateManifest(parsed)

  return {
    ...buildManifest(manifest),
    readFile: (name) => Promise.resolve(files.get(name)),
  }
}

function buildManifest(manifest: Partial<BackupManifest>): {
  manifest: BackupManifest
  rejected: number
} {
  const photos = (manifest.photos ?? []).filter(isValidEntry)
  return {
    rejected: (manifest.photos ?? []).length - photos.length,
    manifest: {
      format: BACKUP_FORMAT,
      formatVersion: manifest.formatVersion ?? BACKUP_FORMAT_VERSION,
      schema: typeof manifest.schema === 'number' ? manifest.schema : SCHEMA_VERSION,
      exportedAt: typeof manifest.exportedAt === 'number' ? manifest.exportedAt : Date.now(),
      photoCount: photos.length,
      photos,
    },
  }
}

function validateManifest(parsed: unknown): Partial<BackupManifest> {
  const manifest = parsed as Partial<BackupManifest>
  if (manifest.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('This ZIP was not created by Selfie a Day.')
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `This backup was written by a newer version of the app (format ${String(manifest.formatVersion)}). Update the app, then restore.`,
    )
  }
  if (!Array.isArray(manifest.photos)) {
    throw new BackupFormatError('manifest.json lists no photos.')
  }
  return manifest
}

/**
 * Parse straight from the picked `File`, reading one entry at a time.
 *
 * Restore is the other half of the promise export makes. Reading the whole
 * archive into one ArrayBuffer needed roughly twice the backup's size resident
 * and CRC'd it in a single uninterruptible task — the exact failure export was
 * rewritten to avoid, left asymmetrically in place on the way back in.
 */
export async function parseBackupFile(file: Blob): Promise<ParsedBackup> {
  let index
  try {
    index = await readZipIndex(file)
  } catch (err) {
    if (err instanceof ZipError) throw new BackupFormatError(err.message)
    throw err
  }

  const byName = new Map(index.map((entry) => [entry.name, entry]))
  const manifestEntry = byName.get(MANIFEST_NAME)
  if (!manifestEntry) {
    throw new BackupFormatError('This ZIP has no manifest.json, so it is not a Selfie a Day backup.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readZipEntry(file, manifestEntry)))
  } catch (err) {
    if (err instanceof ZipError) throw new BackupFormatError(err.message)
    throw new BackupFormatError('manifest.json is not valid JSON — the backup file is damaged.')
  }

  return {
    ...buildManifest(validateManifest(parsed)),
    readFile: async (name) => {
      const entry = byName.get(name)
      return entry ? readZipEntry(file, entry) : undefined
    },
  }
}

export interface ImportResult {
  imported: number
  skipped: number
  problems: string[]
}

/**
 * Restore photos from a parsed backup.
 *
 * `makeThumbnail` is injected rather than imported so this module stays free of
 * canvas/DOM dependencies and remains testable in a plain environment.
 */
export async function importBackup(
  parsed: ParsedBackup,
  options: {
    makeThumbnail: (bytes: ArrayBuffer, mime: string) => Promise<Omit<StoredImage, 'id'>>
    onProgress?: (done: number, total: number) => void
    /** Write in batches so a large restore does not hold one huge transaction. */
    batchSize?: number
  },
): Promise<ImportResult> {
  const { makeThumbnail, onProgress, batchSize = 25 } = options
  const problems: string[] = []
  let imported = 0
  let skipped = 0

  const total = parsed.manifest.photos.length
  let batch: PhotoWrite[] = []

  if (parsed.rejected > 0) {
    skipped += parsed.rejected
    problems.push(
      `${parsed.rejected} entr${parsed.rejected === 1 ? 'y was' : 'ies were'} unreadable in this backup and could not be restored.`,
    )
  }

  /**
   * Write the pending batch, and clear it either way.
   *
   * Clearing on failure matters: leaving the batch in place meant the next
   * flush re-attempted the same rows, so one quota failure part-way through a
   * large restore would retry an ever-growing batch and fail repeatedly.
   */
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const pending = batch
    batch = []
    try {
      const written = new Set(await putPhotos(pending, { keepNewer: true }))
      imported += written.size
      for (const write of pending) {
        if (written.has(write.meta.id)) continue
        skipped++
        problems.push(
          `${write.meta.dayKey}: kept the photo already on this device — it was taken after this backup.`,
        )
      }
    } catch (err) {
      skipped += pending.length
      problems.push(
        `${pending[0]?.meta.dayKey ?? 'batch'} and ${pending.length - 1} more: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  for (const [index, entry] of parsed.manifest.photos.entries()) {
    const data = await parsed.readFile(entry.file)
    if (!data) {
      skipped++
      problems.push(`${entry.dayKey}: "${entry.file}" is listed in the manifest but missing from the ZIP.`)
      continue
    }

    try {
      // Copy out of the ZIP's shared buffer — a subarray view would keep the
      // entire archive alive in memory for every photo we store.
      const masterBytes = data.slice().buffer
      const thumb = await makeThumbnail(masterBytes, entry.mime)
      const id = isPhotoId(entry.id) ? entry.id : newPhotoId(entry.capturedAt)

      const meta: PhotoMeta = {
        id,
        dayKey: entry.dayKey,
        capturedAt: entry.capturedAt,
        tzOffsetMinutes: entry.tzOffsetMinutes ?? 0,
        width: entry.width,
        height: entry.height,
        mime: entry.mime,
        mirrored: Boolean(entry.mirrored),
        source: entry.source === 'file' ? 'file' : 'camera',
        masterBytes: masterBytes.byteLength,
        thumbBytes: thumb.bytes.byteLength,
        schema: SCHEMA_VERSION,
      }

      batch.push({
        meta,
        master: { id, mime: entry.mime, width: entry.width, height: entry.height, bytes: masterBytes },
        thumb: { id, ...thumb },
      })

      if (batch.length >= batchSize) await flush()
    } catch (err) {
      skipped++
      problems.push(`${entry.dayKey}: ${err instanceof Error ? err.message : String(err)}`)
    }

    onProgress?.(index + 1, total)
  }

  await flush()
  return { imported, skipped, problems }
}
