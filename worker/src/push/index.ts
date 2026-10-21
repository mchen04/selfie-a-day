import type { PushEnv } from './types'
import { isRecord, validEndpoint, validKeys, validTimeZone } from './validation'

export type { PushEnv } from './types'
export { runPushScheduler } from './scheduler'

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

function empty(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

interface PrefRow {
  album_id: string
  enabled: number
  time: string
  time_zone: string
}

function prefDto(row: PrefRow) {
  return { albumId: row.album_id, enabled: row.enabled === 1, time: row.time, timeZone: row.time_zone }
}

export async function handlePush(request: Request, env: PushEnv, ctx: { userId: string; url: URL }): Promise<Response | null> {
  const path = ctx.url.pathname
  const albumMatch = /^\/api\/push\/prefs\/([^/]+)$/.exec(path)
  if (!['/api/push/config', '/api/push/subscription', '/api/push/prefs'].includes(path) && !albumMatch) return null
  if (path === '/api/push/config' && request.method === 'GET') return json({ publicKey: env.VAPID_PUBLIC_KEY })
  if (path === '/api/push/prefs' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT p.album_id, p.enabled, p.time, p.time_zone FROM push_prefs p
      JOIN albums a ON a.user_id = p.user_id AND a.id = p.album_id
      WHERE p.user_id = ? AND a.deleted_at IS NULL ORDER BY p.album_id`).bind(ctx.userId).all<PrefRow>()
    return json({ prefs: rows.results.map(prefDto) })
  }
  const subscriptionWrite = path === '/api/push/subscription' && ['PUT', 'DELETE'].includes(request.method)
  if (!subscriptionWrite && !(albumMatch && request.method === 'PUT')) return json({ error: 'method_not_allowed' }, 405)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!isRecord(body)) return json({ error: 'invalid_json' }, 400)
  if (subscriptionWrite) {
    if (request.method === 'DELETE') {
      if (typeof body.endpoint !== 'string') return json({ error: 'invalid_endpoint' }, 400)
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(ctx.userId, body.endpoint).run()
      return empty()
    }
    if (!validEndpoint(body.endpoint, env.PUSH_ALLOW_INSECURE_ENDPOINTS)) return json({ error: 'invalid_endpoint' }, 400)
    if (!await validKeys(body.keys) || !isRecord(body.keys)) return json({ error: 'invalid_keys' }, 400)
    if (!validTimeZone(body.timeZone)) return json({ error: 'invalid_time_zone' }, 400)
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, time_zone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET
        created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
        user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        time_zone = excluded.time_zone, updated_at = excluded.updated_at`)
        .bind(body.endpoint, ctx.userId, body.keys.p256dh, body.keys.auth, body.timeZone, now, now),
      env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
        (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, endpoint DESC LIMIT 10)`)
        .bind(ctx.userId, ctx.userId),
    ])
    return empty()
  }
  let albumId: string
  try {
    albumId = decodeURIComponent(albumMatch?.[1] ?? '')
  } catch {
    return json({ error: 'not_found' }, 404)
  }
  const album = await env.DB.prepare('SELECT id FROM albums WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(ctx.userId, albumId).first<{ id: string }>()
  if (!album) return json({ error: 'not_found' }, 404)
  if (typeof body.enabled !== 'boolean') return json({ error: 'invalid_enabled' }, 400)
  if (typeof body.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return json({ error: 'invalid_time' }, 400)
  if (!validTimeZone(body.timeZone)) return json({ error: 'invalid_time_zone' }, 400)
  await env.DB.prepare(`INSERT INTO push_prefs (user_id, album_id, enabled, time, time_zone, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, album_id) DO UPDATE SET
    enabled = excluded.enabled, time = excluded.time, time_zone = excluded.time_zone, updated_at = excluded.updated_at`)
    .bind(ctx.userId, albumId, Number(body.enabled), body.time, body.timeZone, Date.now()).run()
  return json({ pref: { albumId, enabled: body.enabled, time: body.time, timeZone: body.timeZone } })
}
