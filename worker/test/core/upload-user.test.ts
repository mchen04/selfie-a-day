import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/core/env'
import { tokenHash } from '../../src/core/password'
import { SqliteDatabase } from '../push/sqlite'

const now = Date.parse('2026-10-21T12:00:00Z')
let db: SqliteDatabase

beforeEach(async () => {
  db = new SqliteDatabase()
  await db.exec(readFileSync(new URL('../../migrations/0001_core.sql', import.meta.url), 'utf8'))
  await db.prepare('INSERT INTO users VALUES (?, ?, ?)').bind('synthetic', 'synthetic', 'synthetic').run()
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

async function signedIn(days = 90) {
  const token = randomBytes(32).toString('base64url')
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .bind(await tokenHash(token), 'synthetic', now + days * 86_400_000).run()
  const put = vi.fn(), remove = vi.fn()
  const env = { DB: db, PHOTOS: { put, delete: remove }, COOKIE_SECURE: 'false', ALLOWED_ORIGINS: 'https://selfie.example' } as unknown as Env
  const send = (method: string, path: string, user: string) => worker.fetch(new Request(`https://selfie.example${path}`, {
    method, headers: { Origin: env.ALLOWED_ORIGINS, 'X-Selfie-CSRF': '1', 'X-Selfie-User': user, Cookie: `sad_session=${token}` },
  }), env)
  return { env, put, remove, send }
}

describe('write account binding', () => {
  it.each([
    ['PATCH', '/api/photos/00000000000000000001'], ['DELETE', '/api/photos/00000000000000000001'],
    ['POST', '/api/trash/empty'], ['PUT', '/api/albums/selfies'],
  ])('rejects %s %s for another user before it changes anything', async (method, path) => {
    const { send, remove } = await signedIn()
    const before = await db.prepare('SELECT total_changes() AS count').first()
    const response = await send(method, path, 'synthetic-other')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'user_mismatch' })
    expect(await db.prepare('SELECT total_changes() AS count').first()).toEqual(before)
    expect(remove).not.toHaveBeenCalled()
  })

  it('accepts a write for the signed-in user and never binds sign-out', async () => {
    const { send } = await signedIn()
    const emptied = await send('POST', '/api/trash/empty', 'synthetic')
    expect(emptied.status).toBe(200)
    expect(await emptied.json()).toEqual({ deleted: 0 })
    const logout = await send('POST', '/api/auth/logout', 'synthetic-other')
    expect(logout.status).toBe(204)
    expect(await db.prepare('SELECT count(*) AS count FROM sessions').first()).toEqual({ count: 0 })
  })
})

describe('upload account binding', () => {
  it.each([90, 44])('rejects another user before writes with %s session days remaining', async (days) => {
    const { send, put, remove } = await signedIn(days)
    const before = await db.prepare('SELECT total_changes() AS count').first()
    const response = await send('PUT', '/api/photos/00000000000000000001', 'synthetic-other')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'user_mismatch' })
    expect(await db.prepare('SELECT total_changes() AS count').first()).toEqual(before)
    expect(put).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual([])
  })
})
