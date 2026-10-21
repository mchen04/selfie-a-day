import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { authenticate, purgeExpiredAuth } from '../../src/core/auth'
import * as passwords from '../../src/core/password'
import { patchPhoto, purgeExpiredTrash } from '../../src/core/photos'
import type { Env } from '../../src/core/env'
import { SqliteDatabase } from '../push/sqlite'

const now = Date.parse('2026-10-21T12:00:00Z')
const day = 86_400_000
let db: SqliteDatabase
let env: Env
let remove: ReturnType<typeof vi.fn>

beforeEach(async () => {
  db = new SqliteDatabase()
  for (const name of ['0001_core.sql', '0002_push.sql', '0003_auth_cleanup.sql']) await db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  await db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').bind('synthetic', 'synthetic', 'synthetic', now).run()
  remove = vi.fn()
  env = { DB: db, PHOTOS: { delete: remove }, COOKIE_SECURE: 'false', ALLOWED_ORIGINS: 'https://selfie.example' } as unknown as Env
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

function login(username = 'synthetic') {
  return worker.fetch(new Request('https://selfie.example/api/auth/login', {
    method: 'POST', headers: { Origin: env.ALLOWED_ORIGINS, 'X-Selfie-CSRF': '1', 'X-Forwarded-For': '192.0.2.1' },
    body: JSON.stringify({ username, password: randomBytes(16).toString('base64url') }),
  }), env)
}

async function session() {
  const token = randomBytes(32).toString('base64url'), id = await passwords.tokenHash(token)
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').bind(id, 'synthetic', now, now + 90 * day, now).run()
  return { id, request: new Request('https://selfie.example/api/auth/me', { headers: { Cookie: `sad_session=${token}` } }) }
}

async function writes() { return (await db.prepare('SELECT total_changes() AS count').first<{ count: number }>())!.count }

describe('session and login security', () => {
  it('reserves concurrent guesses before password verification', async () => {
    const verify = vi.spyOn(passwords, 'verifyPassword')
    const responses = await Promise.all(Array.from({ length: 20 }, () => login()))
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10)
    expect(verify).toHaveBeenCalledTimes(10)
    expect((await db.prepare('SELECT count FROM auth_attempts ORDER BY key').all()).results).toEqual([{ count: 10 }, { count: 10 }, { count: 10 }])
  })

  it('returns successful login reservations without clearing earlier daily or IP failures', async () => {
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true)
    for (const [key, count] of [['login-user:synthetic', 2], ['login-user-day:synthetic', 29], ['login-ip:192.0.2.1', 49]] as const) {
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, ?)').bind(key, now, count).run()
    }
    expect((await login()).status).toBe(200)
    expect(await db.prepare("SELECT count FROM auth_attempts WHERE key = 'login-user:synthetic'").first()).toBeNull()
    expect(await db.prepare("SELECT count FROM auth_attempts WHERE key = 'login-user-day:synthetic'").first()).toEqual({ count: 29 })
    expect(await db.prepare("SELECT count FROM auth_attempts WHERE key = 'login-ip:192.0.2.1'").first()).toEqual({ count: 49 })
  })

  it('writes session activity at most once an hour while renewal still writes when due', async () => {
    const current = await session()
    let before = await writes()
    await Promise.all(Array.from({ length: 10 }, () => authenticate(current.request, env, now + 1000)))
    expect(await writes() - before).toBe(0)
    before = await writes()
    await Promise.all(Array.from({ length: 10 }, () => authenticate(current.request, env, now + 3_600_000)))
    expect(await writes() - before).toBe(1)
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now + 44 * day, current.id).run()
    const renewed = await authenticate(current.request, env, now + 3_600_001)
    expect(renewed?.cookie).toContain('sad_session=')
    expect(await db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').bind(current.id).first()).toEqual({ last_seen_at: now + 3_600_001 })
  })

  it('purges expired authentication rows in bounded cron batches using scheduled time', async () => {
    vi.mocked(Date.now).mockReturnValue(now + 100 * day)
    for (let index = 0; index < 150; index++) {
      await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').bind(`expired-${index}`, 'synthetic', 0, now, 0).run()
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, ?)').bind(`login-user:expired-${index}`, now - 900_000, 10).run()
    }
    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').bind('live', 'synthetic', now, now + 1, now).run()
    for (const [key, start] of [['login-user-day:live', now - day + 1], ['signup-ip:live', now - 3_600_000 + 1], ['login-ip:live', now - 900_000 + 1]] as const) {
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, ?)').bind(key, start, 1).run()
    }
    const pending: Promise<unknown>[] = []
    worker.scheduled({ scheduledTime: now, cron: '*/5 * * * *', noRetry() {} }, env, { waitUntil: (task: Promise<unknown>) => { pending.push(task) } } as ExecutionContext)
    await Promise.all(pending)
    expect(await db.prepare("SELECT count(*) AS count FROM sessions WHERE id LIKE 'expired-%'").first()).toEqual({ count: 50 })
    expect(await db.prepare("SELECT count(*) AS count FROM auth_attempts WHERE key LIKE 'login-user:expired-%'").first()).toEqual({ count: 50 })
    expect(await db.prepare("SELECT id FROM sessions WHERE id = 'live'").first()).toEqual({ id: 'live' })
    expect(await db.prepare("SELECT count(*) AS count FROM auth_attempts WHERE key LIKE '%:live'").first()).toEqual({ count: 3 })
  })

  it('expires counters only when their own login, daily or signup window ends', async () => {
    for (const [prefix, duration] of [['login-user', 900_000], ['login-ip', 900_000], ['login-user-day', day], ['signup-ip', 3_600_000]] as const) {
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, 1)').bind(`${prefix}:expired`, now - duration).run()
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, 1)').bind(`${prefix}:live`, now - duration + 1).run()
    }
    await purgeExpiredAuth(env, now)
    expect(await db.prepare("SELECT count(*) AS count FROM auth_attempts WHERE key LIKE '%:expired'").first()).toEqual({ count: 0 })
    expect(await db.prepare("SELECT count(*) AS count FROM auth_attempts WHERE key LIKE '%:live'").first()).toEqual({ count: 4 })
  })

  it('starts trash retention at server time despite an old client clock', async () => {
    const id = '00000000000000000001'
    await db.exec("INSERT INTO albums (user_id, id, name, created_at, updated_at) VALUES ('synthetic', 'selfies', 'Selfies', 0, 0)")
    await db.prepare(`INSERT INTO photos (user_id,id,album_id,day_key,captured_at,tz_offset_minutes,width,height,mime,mirrored,source,master_bytes,thumb_bytes,updated_at)
      VALUES ('synthetic',?,'selfies','2026-10-21',?,0,3,4,'image/jpeg',0,'camera',8,8,?)`).bind(id, now, now).run()
    const response = await patchPhoto(new Request(`https://selfie.example/api/photos/${id}`, { method: 'PATCH', body: JSON.stringify({ deletedAt: now - 31 * day }) }), env, 'synthetic', id, now)
    expect(await response.json()).toMatchObject({ photo: { deletedAt: now } })
    await purgeExpiredTrash(env, now + 300_000)
    expect(remove).not.toHaveBeenCalled()
    expect(await db.prepare('SELECT purged_at FROM photos WHERE id = ?').bind(id).first()).toEqual({ purged_at: null })
  })
})
