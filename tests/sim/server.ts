import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { API_STATE_DIR } from './config.ts'

/**
 * Server-side truth for the simulation, read straight from the local Worker's
 * Miniflare SQLite files (read-only, WAL-safe), so verifying the server adds no
 * requests to the evidence the data-flow audit reads.
 */

const objectFile = (kind: 'd1/miniflare-D1DatabaseObject' | 'r2/miniflare-R2BucketObject') => {
  const dir = join(API_STATE_DIR, 'v3', kind)
  const name = existsSync(dir) ? readdirSync(dir).find((file) => /^[0-9a-f]{64}\.sqlite$/.test(file)) : undefined
  return name ? join(dir, name) : null
}

function query<T>(kind: 'd1/miniflare-D1DatabaseObject' | 'r2/miniflare-R2BucketObject', sql: string, ...params: Array<string | number | null>): T[] {
  const file = objectFile(kind)
  if (!file) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(sql).all(...params) as T[] }
  finally { db.close() }
}

const d1 = <T>(sql: string, ...params: Array<string | number | null>) => query<T>('d1/miniflare-D1DatabaseObject', sql, ...params)

export interface ServerPhoto { id: string; albumId: string; dayKey: string; capturedAt: number; timerSeconds: number; deletedAt: number | null; purgedAt: number | null }
export interface ServerAlbum { id: string; name: string; timeZone: string | null }

export const userId = (username: string) => d1<{ id: string }>('SELECT id FROM users WHERE username = ?', username)[0]?.id ?? null

export const serverPhotos = (user: string) => d1<ServerPhoto>(`SELECT id, album_id AS albumId, day_key AS dayKey, captured_at AS capturedAt,
  timer_seconds AS timerSeconds, deleted_at AS deletedAt, purged_at AS purgedAt FROM photos WHERE user_id = ? ORDER BY captured_at, id`, user)

export const serverAlbums = (user: string) => d1<ServerAlbum>(`SELECT id, name, time_zone AS timeZone FROM albums
  WHERE user_id = ? AND deleted_at IS NULL ORDER BY id`, user)

export const serverSubscriptions = (user: string) => d1<{ endpoint: string; timeZone: string }>(
  'SELECT endpoint, time_zone AS timeZone FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint', user)

export const serverPrefs = (user: string) => d1<{ albumId: string; enabled: number; time: string; timeZone: string }>(
  'SELECT album_id AS albumId, enabled, time, time_zone AS timeZone FROM push_prefs WHERE user_id = ? ORDER BY album_id', user)

export const notificationLog = (user: string) => d1<{ albumId: string; event: string; dayKey: string; sent: number }>(
  `SELECT album_id AS albumId, event, day_key AS dayKey, sent_at IS NOT NULL AS sent FROM notification_log
  WHERE user_id = ? ORDER BY day_key, album_id, event`, user)

export function r2Objects(user?: string): { objects: number; bytes: number } {
  const rows = query<{ objects: number; bytes: number | null }>('r2/miniflare-R2BucketObject',
    `SELECT count(*) AS objects, sum(size) AS bytes FROM _mf_objects${user ? ' WHERE key LIKE ?' : ''}`, ...(user ? [`u/${user}/%`] : []))
  return { objects: rows[0]?.objects ?? 0, bytes: rows[0]?.bytes ?? 0 }
}

export const r2Photo = (user: string, photo: string) => query<{ key: string; size: number }>('r2/miniflare-R2BucketObject',
  'SELECT key, size FROM _mf_objects WHERE key LIKE ? ORDER BY key', `u/${user}/${photo}/%`)

/** Row counts per table plus per-user breakdowns; never row contents. */
export function serverStorage(users: Record<string, string | null>) {
  const tables = d1<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('sqlite_sequence', 'd1_migrations') ORDER BY name`)
  const rows = Object.fromEntries(tables.map(({ name }) => [name, d1<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`)[0]?.n ?? 0]))
  const perUser = Object.fromEntries(Object.entries(users).filter((entry): entry is [string, string] => entry[1] !== null).map(([label, id]) => {
    const count = (sql: string) => d1<{ n: number }>(sql, id)[0]?.n ?? 0
    return [label, {
      photos: {
        active: count('SELECT count(*) AS n FROM photos WHERE user_id = ? AND deleted_at IS NULL AND purged_at IS NULL'),
        trashed: count('SELECT count(*) AS n FROM photos WHERE user_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL'),
        purged: count('SELECT count(*) AS n FROM photos WHERE user_id = ? AND purged_at IS NOT NULL'),
        bytes: count('SELECT coalesce(sum(master_bytes + thumb_bytes), 0) AS n FROM photos WHERE user_id = ? AND purged_at IS NULL'),
      },
      albums: count('SELECT count(*) AS n FROM albums WHERE user_id = ? AND deleted_at IS NULL'),
      sessions: count('SELECT count(*) AS n FROM sessions WHERE user_id = ?'),
      pushSubscriptions: count('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?'),
      pushPrefsEnabled: count('SELECT count(*) AS n FROM push_prefs WHERE user_id = ? AND enabled = 1'),
      pushPrefs: count('SELECT count(*) AS n FROM push_prefs WHERE user_id = ?'),
      notificationLog: count('SELECT count(*) AS n FROM notification_log WHERE user_id = ?'),
      r2: r2Objects(id),
    }]
  }))
  return { d1: { rows, perUser }, r2: r2Objects() }
}
