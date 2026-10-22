export const ALBUM_COLUMNS = 'id, name, time_zone, deleted_at'
export const PHOTO_COLUMNS = 'id, album_id, day_key, captured_at, width, height, mime, mirrored, timer_seconds, deleted_at'

export interface AlbumRow {
  id: string
  name: string
  time_zone: string | null
  deleted_at: number | null
}

export interface PhotoRow {
  id: string
  album_id: string
  day_key: string
  captured_at: number
  width: number
  height: number
  mime: string
  mirrored: number
  timer_seconds: number
  deleted_at: number | null
}

export function albumDto(row: AlbumRow) {
  return { id: row.id, name: row.name, timeZone: row.time_zone, deletedAt: row.deleted_at }
}

export function photoDto(row: PhotoRow) {
  return {
    id: row.id, albumId: row.album_id, dayKey: row.day_key, capturedAt: row.captured_at,
    width: row.width, height: row.height, mime: row.mime, mirrored: Boolean(row.mirrored),
    timerSeconds: row.timer_seconds, deletedAt: row.deleted_at,
  }
}
