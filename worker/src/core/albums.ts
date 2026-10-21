import type { Env } from './env'
import { HttpError, isAlbumId, isTimestamp, json, readJson, validTimeZone } from './http'
import { ALBUM_COLUMNS, albumDto, type AlbumRow } from './records'

export async function putAlbum(request: Request, env: Env, userId: string, id: string, now: number): Promise<Response> {
  if (!isAlbumId(id)) throw new HttpError(400, 'invalid_album')
  const body = await readJson(request)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 40) throw new HttpError(400, 'invalid_name')
  if (body.timeZone !== null && !validTimeZone(body.timeZone)) throw new HttpError(400, 'invalid_time_zone')
  if (!isTimestamp(body.createdAt)) throw new HttpError(400, 'invalid_created_at')
  try {
    const row = await env.DB.prepare(`INSERT INTO albums (user_id, id, name, name_key, time_zone, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(user_id, id) DO UPDATE SET
      name = excluded.name, name_key = excluded.name_key, time_zone = excluded.time_zone, updated_at = excluded.updated_at
      RETURNING ${ALBUM_COLUMNS}`).bind(userId, id, name, name.toLowerCase(), body.timeZone, body.createdAt, now).first<AlbumRow>()
    if (!row) throw new Error('album_failed')
    return json({ album: albumDto(row) })
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: albums.id')) throw new HttpError(404, 'not_found')
    if (String(error).includes('UNIQUE constraint failed')) throw new HttpError(409, 'album_name_taken')
    throw error
  }
}
