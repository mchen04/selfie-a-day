import type { Album, PhotoMeta } from '../core/types.ts'
import { getMaster } from './images.ts'
import { createZip, crc32, type ZipEntry } from './zip.ts'

export async function downloadPhotos(photos: readonly PhotoMeta[], albums: readonly Album[], signal: AbortSignal,
  progress: (done: number, total: number) => void): Promise<File> {
  const entries: ZipEntry[] = []
  for (const [index, photo] of photos.entries()) {
    signal.throwIfAborted()
    const master = await getMaster(photo.id, signal)
    signal.throwIfAborted()
    const bytes = new Uint8Array(master.bytes)
    const album = (albums.find((album) => album.id === photo.albumId)?.name ?? 'Photos').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40)
    entries.push({ name: `${album}-${photo.albumId}/${photo.dayKey}-${photo.id}.${photo.mime.includes('webp') ? 'webp' : 'jpg'}`,
      data: new Blob([bytes], { type: photo.mime }), size: bytes.length, crc: crc32(bytes), date: new Date(photo.capturedAt) })
    progress(index + 1, photos.length)
  }
  return new File([createZip(entries)], `selfie-a-day-${new Date().toISOString().slice(0, 10)}.zip`, { type: 'application/zip' })
}

export async function saveDownload(file: File): Promise<void> {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'My photos' }); return }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
