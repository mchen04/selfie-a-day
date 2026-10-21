export const ALBUM_COLUMNS = 'id, name, time_zone, created_at, updated_at, deleted_at'
export const PHOTO_COLUMNS = 'id, album_id, day_key, captured_at, time_zone, tz_offset_minutes, width, height, mime, mirrored, source, timer_seconds, master_bytes, thumb_bytes, deleted_at'

export interface AlbumRow {
  id: string
  name: string
  time_zone: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface PhotoRow {
  id: string
  album_id: string
  day_key: string
  captured_at: number
  time_zone: string | null
  tz_offset_minutes: number
  width: number
  height: number
  mime: string
  mirrored: number
  source: string
  timer_seconds: number
  master_bytes: number
  thumb_bytes: number
  deleted_at: number | null
}

export function albumDto(row: AlbumRow) {
  return { id: row.id, name: row.name, timeZone: row.time_zone, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }
}

export function photoDto(row: PhotoRow) {
  return {
    id: row.id, albumId: row.album_id, dayKey: row.day_key, capturedAt: row.captured_at,
    timeZone: row.time_zone, tzOffsetMinutes: row.tz_offset_minutes, width: row.width, height: row.height,
    mime: row.mime, mirrored: Boolean(row.mirrored), source: row.source, timerSeconds: row.timer_seconds,
    masterBytes: row.master_bytes, thumbBytes: row.thumb_bytes, deletedAt: row.deleted_at,
  }
}
