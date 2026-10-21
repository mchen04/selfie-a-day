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
  await db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').bind('synthetic', 'synthetic', 'synthetic', now).run()
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

describe('upload account binding', () => {
  it.each([90, 44])('rejects another user before writes with %s session days remaining', async (days) => {
    const token = randomBytes(32).toString('base64url')
    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .bind(await tokenHash(token), 'synthetic', now, now + days * 86_400_000, now - 3_600_000).run()
    const put = vi.fn(), remove = vi.fn()
    const env = {
      DB: db, PHOTOS: { put, delete: remove }, COOKIE_SECURE: 'false', ALLOWED_ORIGINS: 'https://selfie.example',
    } as unknown as Env
    const before = await db.prepare('SELECT total_changes() AS count').first()
    const response = await worker.fetch(new Request('https://selfie.example/api/photos/00000000000000000001', {
      method: 'PUT', headers: {
        Origin: env.ALLOWED_ORIGINS, 'X-Selfie-CSRF': '1', 'X-Selfie-User': 'synthetic-other', Cookie: `sad_session=${token}`,
      },
    }), env)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'user_mismatch' })
    expect(await db.prepare('SELECT total_changes() AS count').first()).toEqual(before)
    expect(put).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual([])
  })
})
