import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from './env'
import { boundedBody, empty, HttpError, isAlbumId, isPhotoId, isTimestamp, json, readJson, validTimeZone } from './http'
import { PHOTO_COLUMNS, photoDto, type PhotoRow } from './records'

const MASTER_LIMIT = 4 * 1024 * 1024
const THUMB_LIMIT = 256 * 1024
const USER_LIMIT = 2 * 1024 * 1024 * 1024

interface UploadMeta {
  albumId: string
  dayKey: string
  capturedAt: number
  timeZone: string | null
  tzOffsetMinutes: number
  width: number
  height: number
  mime: string
  mirrored: boolean
  source: string
  timerSeconds: number
}

export function photoKey(userId: string, id: string, variant: 'master' | 'thumb'): string {
  return `u/${userId}/${id}/${variant}`
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validMeta(value: unknown): value is UploadMeta {
  if (typeof value !== 'object' || value === null) return false
  const meta = value as Record<string, unknown>
  return isAlbumId(meta.albumId) && validDay(meta.dayKey) && isTimestamp(meta.capturedAt)
    && (meta.timeZone === null || validTimeZone(meta.timeZone))
    && typeof meta.tzOffsetMinutes === 'number' && Number.isInteger(meta.tzOffsetMinutes) && Math.abs(meta.tzOffsetMinutes) <= 1440
    && typeof meta.width === 'number' && Number.isSafeInteger(meta.width) && meta.width > 0
    && typeof meta.height === 'number' && Number.isSafeInteger(meta.height) && meta.height > 0
    && (meta.mime === 'image/jpeg' || meta.mime === 'image/webp')
    && typeof meta.mirrored === 'boolean' && (meta.source === 'camera' || meta.source === 'file')
    && typeof meta.timerSeconds === 'number' && [0, 3, 5, 10].includes(meta.timerSeconds)
}

function magicMatches(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/webp') {
    return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  }
  return false
}

async function imageBytes(value: File | string | null, limit: number): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (value === null || typeof value === 'string') throw new HttpError(400, 'invalid_image')
  if (value.size > limit) throw new HttpError(413, 'payload_too_large')
  const bytes = await value.arrayBuffer()
  if (!magicMatches(new Uint8Array(bytes), value.type)) throw new HttpError(400, 'invalid_image')
  return { bytes, mime: value.type }
}

async function uploadedPhoto(env: Env, userId: string, id: string): Promise<PhotoRow | null> {
  return env.DB.prepare(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE user_id = ? AND id = ?`)
    .bind(userId, id).first<PhotoRow>()
}

async function ownsPhoto(env: Env, userId: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM photos WHERE user_id = ? AND id = ? AND purged_at IS NULL')
    .bind(userId, id).first<{ id: string }>()
  return row !== null
}

function databaseUploadError(error: unknown): never {
  const message = String(error)
  if (message.includes('quota_exceeded')) throw new HttpError(413, 'quota_exceeded')
  throw error
}

export async function uploadPhoto(request: Request, env: Env, userId: string, id: string, now: number): Promise<Response> {
  if (!isPhotoId(id)) throw new HttpError(400, 'invalid_photo')
  const previous = await uploadedPhoto(env, userId, id)
  if (previous) return json({ photo: photoDto(previous), replaced: [] })
  const body = await boundedBody(request, MASTER_LIMIT + THUMB_LIMIT + 65536)
  let form: FormData
  try {
    form = await new Request(request.url, { method: 'PUT', headers: request.headers, body }).formData()
  } catch {
    throw new HttpError(400, 'invalid_multipart')
  }
  let meta: unknown
  try {
    const raw = form.get('meta')
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error()
    meta = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid_meta')
  }
  if (!validMeta(meta)) throw new HttpError(400, 'invalid_meta')
  const master = await imageBytes(form.get('master'), MASTER_LIMIT)
  const thumb = await imageBytes(form.get('thumb'), THUMB_LIMIT)
  if (master.mime !== meta.mime) throw new HttpError(400, 'invalid_image')
  const album = await env.DB.prepare('SELECT id FROM albums WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(userId, meta.albumId).first<{ id: string }>()
  if (!album) throw new HttpError(404, 'not_found')
  const quota = await env.DB.prepare(`SELECT count(*) AS count, coalesce(sum(master_bytes + thumb_bytes), 0) AS bytes
    FROM photos WHERE user_id = ? AND purged_at IS NULL`).bind(userId).first<{ count: number; bytes: number }>()
  if (quota && (quota.count >= 5000 || quota.bytes + master.bytes.byteLength + thumb.bytes.byteLength > USER_LIMIT)) {
    throw new HttpError(413, 'quota_exceeded')
  }
  const masterKey = photoKey(userId, id, 'master')
  const thumbKey = photoKey(userId, id, 'thumb')
  const written: string[] = []
  const uploadToken = crypto.randomUUID()
  let claimed = false
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const claim = await env.DB.prepare(`INSERT INTO photo_uploads (user_id, id, token, started_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET token = excluded.token, started_at = excluded.started_at
        WHERE photo_uploads.started_at < ? RETURNING token`)
        .bind(userId, id, uploadToken, now, now - 10 * 60000).first<{ token: string }>()
      claimed = claim?.token === uploadToken
      const existing = await uploadedPhoto(env, userId, id)
      if (existing) return json({ photo: photoDto(existing), replaced: [] })
      if (claimed) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 1600)))
    }
    if (!claimed) throw new HttpError(503, 'upload_in_progress', { 'Retry-After': '1' })
    await env.PHOTOS.put(masterKey, master.bytes, { httpMetadata: { contentType: master.mime } })
    written.push(masterKey)
    await env.PHOTOS.put(thumbKey, thumb.bytes, { httpMetadata: { contentType: thumb.mime } })
    written.push(thumbKey)
    const [retakes, inserted] = await env.DB.batch([
      env.DB.prepare(`UPDATE photos SET deleted_at = ?, updated_at = ?
        WHERE user_id = ? AND album_id = ? AND day_key = ? AND deleted_at IS NULL AND purged_at IS NULL RETURNING id`)
        .bind(now, now, userId, meta.albumId, meta.dayKey),
      env.DB.prepare(`INSERT INTO photos (user_id, id, album_id, day_key, captured_at, time_zone, tz_offset_minutes,
        width, height, mime, mirrored, source, timer_seconds, master_bytes, thumb_bytes, deleted_at, purged_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?) RETURNING ${PHOTO_COLUMNS}`)
        .bind(userId, id, meta.albumId, meta.dayKey, meta.capturedAt, meta.timeZone, meta.tzOffsetMinutes,
          meta.width, meta.height, meta.mime, meta.mirrored ? 1 : 0, meta.source, meta.timerSeconds,
          master.bytes.byteLength, thumb.bytes.byteLength, now),
    ])
    const row = inserted!.results[0] as PhotoRow
    return json({ photo: photoDto(row), replaced: (retakes!.results as { id: string }[]).map((item) => item.id) }, 201)
  } catch (error) {
    if (written.length) await env.PHOTOS.delete(written)
    return databaseUploadError(error)
  } finally {
    if (claimed) await env.DB.prepare('DELETE FROM photo_uploads WHERE user_id = ? AND id = ? AND token = ?')
      .bind(userId, id, uploadToken).run()
  }
}

export async function getImage(request: Request, env: Env, userId: string, id: string, variant: 'master' | 'thumb'): Promise<Response> {
  if (!isPhotoId(id)) throw new HttpError(404, 'not_found')
  if (!await ownsPhoto(env, userId, id)) throw new HttpError(404, 'not_found')
  const object = await env.PHOTOS.get(photoKey(userId, id, variant))
  if (!object) throw new HttpError(404, 'not_found')
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable', 'Vary': 'Cookie',
    'ETag': object.httpEtag, 'X-Content-Type-Options': 'nosniff',
  })
  const etags = request.headers.get('If-None-Match')?.split(',').map((tag) => tag.trim().replace(/^W\//, ''))
  if (etags?.includes(object.httpEtag) || etags?.includes('*')) return new Response(null, { status: 304, headers })
  headers.set('Content-Length', String(object.size))
  return new Response(request.method === 'HEAD' ? null : object.body as ReadableStream<Uint8Array>, { headers })
}

export async function patchPhoto(request: Request, env: Env, userId: string, id: string, now: number): Promise<Response> {
  if (!isPhotoId(id)) throw new HttpError(404, 'not_found')
  if (!await ownsPhoto(env, userId, id)) throw new HttpError(404, 'not_found')
  const body = await readJson(request)
  if (body.deletedAt !== null && !isTimestamp(body.deletedAt)) throw new HttpError(400, 'invalid_deleted_at')
  try {
    const row = await env.DB.prepare(`UPDATE photos SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND purged_at IS NULL RETURNING ${PHOTO_COLUMNS}`)
      .bind(body.deletedAt, now, userId, id).first<PhotoRow>()
    if (!row) throw new HttpError(404, 'not_found')
    return json({ photo: photoDto(row) })
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new HttpError(409, 'day_taken')
    throw error
  }
}

async function purgeRows(env: Env, rows: { user_id: string; id: string }[], now: number): Promise<number> {
  const keys = rows.flatMap((row) => [photoKey(row.user_id, row.id, 'master'), photoKey(row.user_id, row.id, 'thumb')])
  for (let index = 0; index < keys.length; index += 1000) await env.PHOTOS.delete(keys.slice(index, index + 1000))
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const ids = groups.get(row.user_id) ?? []
    ids.push(row.id)
    groups.set(row.user_id, ids)
  }
  const statements: D1PreparedStatement[] = []
  for (const [userId, ids] of groups) {
    for (let index = 0; index < ids.length; index += 96) {
      const batch = ids.slice(index, index + 96)
      statements.push(env.DB.prepare(`UPDATE photos SET purged_at = ?, deleted_at = coalesce(deleted_at, ?), updated_at = ?
        WHERE user_id = ? AND id IN (${batch.map(() => '?').join(',')}) AND purged_at IS NULL RETURNING id`)
        .bind(now, now, now, userId, ...batch))
    }
  }
  let deleted = 0
  for (let index = 0; index < statements.length; index += 100) {
    const results = await env.DB.batch(statements.slice(index, index + 100))
    deleted += results.reduce((sum, result) => sum + result.results.length, 0)
  }
  return deleted
}

export async function deletePhoto(env: Env, userId: string, id: string, now: number): Promise<Response> {
  if (!isPhotoId(id)) throw new HttpError(404, 'not_found')
  const row = await env.DB.prepare('SELECT purged_at FROM photos WHERE user_id = ? AND id = ?').bind(userId, id)
    .first<{ purged_at: number | null }>()
  if (!row) throw new HttpError(404, 'not_found')
  if (row.purged_at === null) await purgeRows(env, [{ user_id: userId, id }], now)
  return empty()
}

export async function emptyTrash(env: Env, userId: string, now: number): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT id FROM photos WHERE user_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL')
    .bind(userId).all<{ id: string }>()
  const deleted = await purgeRows(env, results.map((row) => ({ user_id: userId, id: row.id })), now)
  return json({ deleted })
}

export async function purgeExpiredTrash(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT user_id, id FROM photos
    WHERE deleted_at < ? AND purged_at IS NULL`).bind(now - 30 * 86400000).all<{ user_id: string; id: string }>()
  await purgeRows(env, results, now)
}
