import type { Env } from './env'
import { HttpError, json } from './http'
import { base64url, unbase64url } from './password'
import { ALBUM_COLUMNS, albumDto, type AlbumRow, PHOTO_COLUMNS, photoDto, type PhotoRow } from './records'

function encodeCursor(userId: string, revision: number): string {
  return base64url(new TextEncoder().encode(JSON.stringify([1, userId, revision])))
}

function decodeCursor(value: string, userId: string): number {
  try {
    if (value.length > 256) throw new Error()
    const data: unknown = JSON.parse(new TextDecoder().decode(unbase64url(value)))
    if (!Array.isArray(data) || data.length !== 3 || data[0] !== 1 || data[1] !== userId
      || !Number.isSafeInteger(data[2]) || (data[2] as number) < 0) throw new Error()
    return data[2] as number
  } catch {
    throw new HttpError(400, 'invalid_cursor')
  }
}

export async function sync(env: Env, userId: string, url: URL, now: number): Promise<Response> {
  const since = url.searchParams.get('since')
  const revision = since === null ? 0 : decodeCursor(since, userId)
  await env.DB.prepare(`INSERT INTO albums (user_id, id, name, name_key, time_zone, created_at, updated_at, deleted_at)
    SELECT ?, 'selfies', 'Selfies', 'selfies', NULL, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM albums WHERE user_id = ?)
    ON CONFLICT(user_id, id) DO NOTHING`).bind(userId, now, now, userId).run()
  const [clock, albums, photos, removed] = await env.DB.batch([
    env.DB.prepare('SELECT revision FROM sync_clock WHERE user_id = ?').bind(userId),
    env.DB.prepare(`SELECT ${ALBUM_COLUMNS} FROM albums WHERE user_id = ? AND revision > ? ORDER BY revision`).bind(userId, revision),
    env.DB.prepare(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE user_id = ? AND revision > ? AND purged_at IS NULL ORDER BY revision`).bind(userId, revision),
    env.DB.prepare('SELECT id FROM photos WHERE user_id = ? AND revision > ? AND purged_at IS NOT NULL ORDER BY revision').bind(userId, revision),
  ])
  const current = (clock!.results as { revision: number }[])[0]?.revision ?? 0
  if (revision > current) throw new HttpError(400, 'invalid_cursor')
  return json({
    albums: (albums!.results as unknown as AlbumRow[]).map(albumDto),
    photos: (photos!.results as unknown as PhotoRow[]).map(photoDto),
    removed: since === null ? [] : (removed!.results as { id: string }[]).map((row) => row.id),
    cursor: encodeCursor(userId, current), serverTime: now,
  })
}
