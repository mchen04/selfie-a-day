import { readFileSync } from 'node:fs'
import { createECDH, randomBytes } from 'node:crypto'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { authenticate } from '../../src/core/auth'
import type { Env } from '../../src/core/env'
import { SqliteDatabase } from '../push/sqlite'

vi.mock('../../src/core/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/auth')>(), authenticate: vi.fn(), handleAuth: () => Promise.resolve(null),
}))

const origin = 'https://selfie-a-day.example'
let db: SqliteDatabase
let env: Env

beforeEach(async () => {
  db = new SqliteDatabase()
  for (const name of ['0001_core.sql', '0002_push.sql']) {
    await db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  await db.exec("INSERT INTO users VALUES ('synthetic', 'synthetic', 'synthetic', 0); INSERT INTO albums (user_id, id, name, created_at, updated_at) VALUES ('synthetic', 'selfies', 'Selfies', 0, 0)")
  const pair = createECDH('prime256v1')
  pair.generateKeys()
  const privateKey = Buffer.alloc(32)
  const privateBytes = pair.getPrivateKey()
  privateBytes.copy(privateKey, privateKey.length - privateBytes.length)
  env = {
    DB: db, PHOTOS: {} as Env['PHOTOS'], COOKIE_SECURE: 'false', ALLOWED_ORIGINS: origin, PUSH_ALLOW_INSECURE_ENDPOINTS: 'true',
    VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: privateKey.toString('base64url'), VAPID_SUBJECT: origin,
  }
  vi.mocked(authenticate).mockResolvedValue({ user: { id: 'synthetic', username: 'synthetic' }, id: 'synthetic-session' })
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

function request(path: string, method = 'GET', body?: unknown) {
  return worker.fetch(new Request(`${origin}/api/push/${path}`, {
    method, headers: { Origin: origin, 'X-Selfie-CSRF': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env)
}

describe('push through the Worker router', () => {
  it.each([['subscription', 'PUT'], ['subscription', 'DELETE'], ['prefs/selfies', 'PUT']])('caps %s %s bodies at 16 KiB', async (path, method) => {
    const receiver = createECDH('prime256v1')
    receiver.generateKeys()
    const response = await request(path, method, {
      endpoint: 'http://127.0.0.1:8788/push', keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
      enabled: true, time: '09:00', timeZone: 'UTC', padding: 'x'.repeat(16_384),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
  })
  it('serves config and saves album preferences through authenticated routes', async () => {
    const config = await request('config')
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY })
    const pref = { albumId: 'selfies', enabled: true, time: '09:00', timeZone: 'UTC' }
    const saved = await request('prefs/selfies', 'PUT', pref)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ pref })
    const listed = await request('prefs')
    expect(await listed.json()).toEqual({ prefs: [pref] })
    expect(listed.headers.get('Cache-Control')).toBe('no-store')
    expect(listed.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('keeps authentication, CSRF, method and ownership errors at the shared boundary', async () => {
    expect((await request('prefs/selfies', 'PUT', { enabled: true, time: '25:00', timeZone: 'UTC' })).status).toBe(400)
    expect((await request('prefs/album-aaaaaaaaaaaaaaaaaaaa', 'PUT', {})).status).toBe(404)
    expect((await request('config', 'POST', {})).status).toBe(405)
    expect((await request('unknown')).status).toBe(404)
    const rejected = await worker.fetch(new Request(`${origin}/api/push/subscription`, { method: 'PUT' }), env)
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ error: 'forbidden' })
    vi.mocked(authenticate).mockResolvedValue(null)
    const signedOut = await request('config')
    expect(signedOut.status).toBe(401)
    expect(await signedOut.json()).toEqual({ error: 'unauthenticated' })
  })

  it('delivers a reminder from the real cron entry point at scheduledTime', async () => {
    const receiver = createECDH('prime256v1')
    receiver.generateKeys()
    const endpoint = 'http://127.0.0.1:8788/push'
    expect((await request('subscription', 'PUT', {
      endpoint, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, timeZone: 'UTC',
    })).status).toBe(204)
    await request('prefs/selfies', 'PUT', { enabled: true, time: '09:00', timeZone: 'UTC' })
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', send)
    const scheduledTime = Date.parse('2026-10-21T09:05:00Z')
    const pending: Promise<unknown>[] = []
    worker.scheduled({ scheduledTime, cron: '*/5 * * * *', noRetry() {} }, env, {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    } as ExecutionContext)
    await Promise.all(pending)
    expect(send).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ TTL: '14400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm' }) as unknown,
    }))
    expect(await db.prepare('SELECT event, day_key, sent_at FROM notification_log').first()).toEqual({
      event: 'reminder', day_key: '2026-10-21', sent_at: scheduledTime,
    })
  })
})
