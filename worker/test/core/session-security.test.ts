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
  await db.prepare('INSERT INTO users VALUES (?, ?, ?)').bind('synthetic', 'synthetic', 'synthetic').run()
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
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(id, 'synthetic', now + 90 * day).run()
  return { id, request: new Request('https://selfie.example/api/auth/me', { headers: { Cookie: `sad_session=${token}` } }) }
}

async function writes() { return (await db.prepare('SELECT total_changes() AS count').first<{ count: number }>())!.count }

describe.each(['false', 'true'])('session hint cookies with COOKIE_SECURE=%s', (secure) => {
  const prefix = secure === 'false' ? 'sad' : '__Host-sad'

  function request(path: string, method = 'GET', cookie?: string, body?: unknown) {
    env.COOKIE_SECURE = secure
    return worker.fetch(new Request(`https://selfie.example${path}`, {
      method,
      headers: { Origin: env.ALLOWED_ORIGINS, 'X-Selfie-CSRF': '1', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env)
  }

  function expectCookies(response: Response, maxAge: number) {
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    const session = cookies.find((cookie) => cookie.startsWith(`${prefix}_session=`))!
    const hint = cookies.find((cookie) => cookie.startsWith(`${prefix}_hint=`))!
    const attributes = ['Path=/', 'SameSite=Strict', `Max-Age=${maxAge}`, ...(secure === 'false' ? [] : ['Secure'])]
    expect(session.split(';').slice(1).map((value) => value.trim()).sort()).toEqual([...attributes, 'HttpOnly'].sort())
    const [value, ...hintAttributes] = hint.split(';').map((part) => part.trim())
    expect(value).toBe(`${prefix}_hint=${maxAge === 0 ? '' : '1'}`)
    expect(hintAttributes.sort()).toEqual(attributes.sort())
  }

  async function existingSession() {
    const current = await session()
    const cookie = current.request.headers.get('Cookie')!.replace('sad_session=', `${prefix}_session=`)
    return { ...current, cookie }
  }

  it('sets the readable constant hint beside the signup cookie', async () => {
    const response = await request('/api/auth/signup', 'POST', undefined, {
      username: 'synthetic-signup', password: randomBytes(18).toString('base64url'),
    })
    expect(response.status).toBe(201)
    expectCookies(response, 7_776_000)
  })

  it('sets the hint beside the login cookie', async () => {
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true)
    const response = await request('/api/auth/login', 'POST', undefined, {
      username: 'synthetic', password: randomBytes(18).toString('base64url'),
    })
    expect(response.status).toBe(200)
    expectCookies(response, 7_776_000)
  })

  it('renews both cookies only when the session needs renewal', async () => {
    const current = await existingSession()
    expect((await request('/api/auth/me', 'GET', current.cookie)).headers.getSetCookie()).toEqual([])
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now + 44 * day, current.id).run()
    const response = await request('/api/auth/me', 'GET', current.cookie)
    expect(response.status).toBe(200)
    expectCookies(response, 7_776_000)
  })

  it.each([false, true])('clears both cookies on logout with an existing session: %s', async (signedIn) => {
    const cookie = signedIn ? (await existingSession()).cookie : `${prefix}_hint=1`
    const response = await request('/api/auth/logout', 'POST', cookie)
    expect(response.status).toBe(204)
    expectCookies(response, 0)
    expect(await db.prepare('SELECT count(*) AS count FROM sessions').first()).toEqual({ count: 0 })
  })

  it.each(['missing', 'malformed', 'unknown', 'expired'])('clears both cookies for a %s session on protected routes', async (state) => {
    const current = await existingSession()
    if (state === 'expired') await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now, current.id).run()
    const cookie = state === 'missing' ? '' : state === 'malformed' ? `${prefix}_session=invalid`
      : state === 'unknown' ? `${prefix}_session=${randomBytes(32).toString('base64url')}` : current.cookie
    for (const path of ['/api/auth/me', '/api/sync']) {
      const response = await request(path, 'GET', `${cookie}; ${prefix}_hint=1`)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthenticated' })
      expectCookies(response, 0)
    }
  })

  it('keeps an existing session when a password attempt fails', async () => {
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(false)
    const current = await existingSession()
    const response = await request('/api/auth/login', 'POST', current.cookie, {
      username: 'synthetic', password: randomBytes(18).toString('base64url'),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_credentials' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect((await request('/api/auth/me', 'GET', current.cookie)).status).toBe(200)
  })

  it('clears a stale hint when a password attempt fails without a valid session', async () => {
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(false)
    const response = await request('/api/auth/login', 'POST', `${prefix}_hint=1`, {
      username: 'synthetic', password: randomBytes(18).toString('base64url'),
    })
    expect(response.status).toBe(401)
    expectCookies(response, 0)
  })
})

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

  it('writes nothing on signed-in requests until renewal is due', async () => {
    const current = await session()
    const before = await writes()
    for (const at of [now + 1000, now + 3_600_000, now + 44 * day]) {
      await Promise.all(Array.from({ length: 10 }, () => authenticate(current.request, env, at)))
    }
    expect(await writes() - before).toBe(0)
    const renewed = await authenticate(current.request, env, now + 45 * day + 1)
    expect(renewed?.cookie).toContain('sad_session=')
    expect(await writes() - before).toBe(1)
    expect(await db.prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(current.id).first()).toEqual({ expires_at: now + 45 * day + 1 + 90 * day })
  })

  it('purges expired authentication rows in bounded cron batches using scheduled time', async () => {
    vi.mocked(Date.now).mockReturnValue(now + 100 * day)
    for (let index = 0; index < 150; index++) {
      await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(`expired-${index}`, 'synthetic', now).run()
      await db.prepare('INSERT INTO auth_attempts VALUES (?, ?, ?)').bind(`login-user:expired-${index}`, now - 900_000, 10).run()
    }
    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind('live', 'synthetic', now + 1).run()
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
    await db.exec("INSERT INTO albums (user_id, id, name, name_key, updated_at) VALUES ('synthetic', 'selfies', 'Selfies', 'selfies', 0)")
    await db.prepare(`INSERT INTO photos (user_id,id,album_id,day_key,captured_at,width,height,mime,mirrored,master_bytes,thumb_bytes,updated_at)
      VALUES ('synthetic',?,'selfies','2026-10-21',?,3,4,'image/jpeg',0,8,8,?)`).bind(id, now, now).run()
    const response = await patchPhoto(new Request(`https://selfie.example/api/photos/${id}`, { method: 'PATCH', body: JSON.stringify({ deletedAt: now - 31 * day }) }), env, 'synthetic', id, now)
    expect(await response.json()).toMatchObject({ photo: { deletedAt: now } })
    await purgeExpiredTrash(env, now + 300_000)
    expect(remove).not.toHaveBeenCalled()
    expect(await db.prepare('SELECT purged_at FROM photos WHERE id = ?').bind(id).first()).toEqual({ purged_at: null })
  })
})
