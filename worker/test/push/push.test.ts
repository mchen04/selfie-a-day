import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { handlePush, runPushScheduler } from '../../src/push'
import { createFixture, decrypt, verifyVapid } from './support'

let fixture: Awaited<ReturnType<typeof createFixture>>
const at = (time: string) => Date.parse(time)

async function api(path: string, method = 'GET', body?: unknown, userId = 'alice') {
  const url = new URL(`https://selfie-a-day.example${path}`)
  const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const response = await handlePush(request, fixture.env, { userId, url })
  if (!response) throw new Error('Unhandled test path')
  return response
}

async function subscribe(path = '/push', userId = 'alice') {
  expect((await api('/api/push/subscription', 'PUT', fixture.subscriptionBody(path), userId)).status).toBe(204)
}

async function pref(time = '09:00', albumId = 'selfies', userId = 'alice', enabled = true) {
  expect((await api(`/api/push/prefs/${albumId}`, 'PUT', { enabled, time }, userId)).status).toBe(200)
}

async function photo(dayKey: string, options: { id?: string; userId?: string; albumId?: string; deleted?: boolean; purged?: boolean } = {}) {
  await fixture.env.DB.prepare(`INSERT INTO photos (user_id, id, album_id, day_key, deleted_at, purged_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(options.userId ?? 'alice', options.id ?? crypto.randomUUID(), options.albumId ?? 'selfies',
    dayKey, options.deleted ? 1 : null, options.purged ? 1 : null).run()
}

async function history(days: number) {
  const statements = Array.from({ length: days }, (_, index) => fixture.env.DB.prepare(
    'INSERT INTO photos (user_id, id, album_id, day_key) VALUES (?, ?, ?, ?)')
    .bind('alice', `history-${index}`, 'selfies', new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10)))
  await fixture.env.DB.batch(statements)
}

beforeAll(async () => { fixture = await createFixture() })
beforeEach(async () => { await fixture.reset() })
afterAll(async () => { if (fixture) await fixture.close() })

describe('push endpoints', () => {
  it('returns public configuration and rejects unsupported methods and paths', async () => {
    const response = await api('/api/push/config')
    expect(await response.json()).toEqual({ publicKey: fixture.env.VAPID_PUBLIC_KEY })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect((await api('/api/push/config', 'PUT', {})).status).toBe(405)
    expect((await api('/api/push/prefs', 'POST', {})).status).toBe(405)
    const url = new URL('https://selfie-a-day.example/api/push/unknown')
    expect(await handlePush(new Request(url), fixture.env, { userId: 'alice', url })).toBeNull()
  })

  it.each([
    'https://web.push.apple.com/token', 'https://east.push.apple.com/token',
    'https://fcm.googleapis.com/token', 'https://updates.push.services.mozilla.com/token',
    'https://w1.notify.windows.com/token',
  ])('accepts provider endpoint %s', async endpoint => {
    expect((await api('/api/push/subscription', 'PUT', { ...fixture.subscriptionBody(), endpoint })).status).toBe(204)
  })

  it.each([
    'https://example.com/token', 'https://web.push.apple.com.example.com/token',
    'https://evilpush.apple.com/token', 'https://notify.windows.com/token',
    'https://push.apple.com/token', 'http://web.push.apple.com/token',
    'http://localhost:8765/token', 'http://127.0.0.2:8765/token', 'http://127.0.0.1/token',
    'https://user:password@web.push.apple.com/token', 'https://web.push.apple.com/token#fragment',
    'file:///tmp/push', 'not-a-url',
  ])('rejects disallowed endpoint %s', async endpoint => {
    expect((await api('/api/push/subscription', 'PUT', { ...fixture.subscriptionBody(), endpoint })).status).toBe(400)
  })

  it('allows loopback only with the exact insecure flag', async () => {
    for (const flag of ['false', 'TRUE', '1', '']) {
      fixture.env.PUSH_ALLOW_INSECURE_ENDPOINTS = flag
      expect((await api('/api/push/subscription', 'PUT', fixture.subscriptionBody())).status).toBe(400)
    }
    fixture.env.PUSH_ALLOW_INSECURE_ENDPOINTS = 'true'
    await subscribe()
  })

  it('accepts an explicit loopback port 80 and rejects numeric host aliases', async () => {
    const body = fixture.subscriptionBody()
    expect((await api('/api/push/subscription', 'PUT', { ...body, endpoint: 'http://127.0.0.1:80/push' })).status).toBe(204)
    for (const host of ['2130706433', '127.1', '0x7f000001']) {
      expect((await api('/api/push/subscription', 'PUT', { ...body, endpoint: `http://${host}:8788/push` })).status).toBe(400)
    }
  })

  it.each([
    { p256dh: 'bad', auth: 'bad' },
    { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') },
    { p256dh: Buffer.alloc(64).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') },
  ])('rejects malformed or off-curve subscription keys %#', async keys => {
    expect((await api('/api/push/subscription', 'PUT', { ...fixture.subscriptionBody(), keys })).status).toBe(400)
  })

  it('rejects auth secrets of the wrong size and padded key encodings', async () => {
    const body = fixture.subscriptionBody()
    for (const length of [0, 15, 17]) {
      expect((await api('/api/push/subscription', 'PUT', { ...body, keys: { ...body.keys, auth: Buffer.alloc(length).toString('base64url') } })).status).toBe(400)
    }
    expect((await api('/api/push/subscription', 'PUT', { ...body, keys: { ...body.keys, p256dh: `${body.keys.p256dh}=` } })).status).toBe(400)
  })

  it('validates JSON bodies and subscription zones', async () => {
    expect((await api('/api/push/subscription', 'PUT', [])).status).toBe(400)
    expect((await api('/api/push/subscription', 'PUT', { ...fixture.subscriptionBody(), timeZone: 'Mars/Base' })).status).toBe(400)
    const url = new URL('https://selfie-a-day.example/api/push/subscription')
    const response = await handlePush(new Request(url, { method: 'PUT', body: '{' }), fixture.env, { userId: 'alice', url })
    expect(response?.status).toBe(400)
  })

  it('upserts endpoints and reassigns a shared phone without permitting another user to delete it', async () => {
    await subscribe()
    await subscribe()
    expect((await fixture.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())?.n).toBe(1)
    await subscribe('/push', 'bob')
    await api('/api/push/subscription', 'DELETE', { endpoint: `${fixture.endpoint}/push` })
    expect((await fixture.env.DB.prepare('SELECT user_id FROM push_subscriptions').first<{ user_id: string }>())?.user_id).toBe('bob')
    expect((await api('/api/push/subscription', 'DELETE', { endpoint: `${fixture.endpoint}/push` }, 'bob')).status).toBe(204)
    expect((await fixture.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())?.n).toBe(0)
  })

  it('drops the oldest subscription above the ten-device limit', async () => {
    await subscribe('/oldest')
    await fixture.env.DB.prepare('UPDATE push_subscriptions SET created_at = 1').run()
    for (let index = 0; index < 10; index++) await subscribe(`/new-${index}`)
    expect((await fixture.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())?.n).toBe(10)
    expect(await fixture.env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?').bind(`${fixture.endpoint}/oldest`).first()).toBeNull()
  })

  it('returns only the current user preferences and requires album ownership', async () => {
    await pref('10:15')
    await pref('11:30', 'selfies', 'bob')
    expect(await (await api('/api/push/prefs')).json()).toEqual({ prefs: [{ albumId: 'selfies', enabled: true, time: '10:15' }] })
    expect((await api('/api/push/prefs/album-bbbbbbbbbbbbbbbbbbbb', 'PUT', { enabled: true, time: '09:00' })).status).toBe(404)
    expect((await api('/api/push/prefs/absent', 'PUT', { enabled: true, time: '09:00' })).status).toBe(404)
  })

  it.each(['24:00', '9:00', '12:60', '00:0', ' 09:00', '09:00:00', null, 900])('rejects invalid reminder time %s', async time => {
    expect((await api('/api/push/prefs/selfies', 'PUT', { enabled: true, time })).status).toBe(400)
  })

  it('validates preference booleans and allows disabling and boundary times', async () => {
    expect((await api('/api/push/prefs/selfies', 'PUT', { enabled: 1, time: '09:00' })).status).toBe(400)
    await pref('00:00')
    await pref('23:59', 'selfies', 'alice', false)
    expect(await (await api('/api/push/prefs')).json()).toEqual({ prefs: [{ albumId: 'selfies', enabled: false, time: '23:59' }] })
  })
})

describe('scheduler and Web Push encryption', () => {
  it('uses a changed album zone for reminder time and today', async () => {
    await subscribe()
    await pref('09:00')
    await fixture.env.DB.prepare("UPDATE albums SET time_zone = 'America/Los_Angeles' WHERE user_id = 'alice' AND id = 'selfies'").run()
    expect((await runPushScheduler(fixture.env, at('2026-07-01T16:00:00Z'))).sent).toBe(1)
    await photo('2026-07-02')
    expect((await runPushScheduler(fixture.env, at('2026-07-02T16:00:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it('follows the most recently synced device zone on a DST day', async () => {
    await subscribe('/travel')
    await subscribe('/home')
    await pref('09:00')
    await fixture.env.DB.prepare('UPDATE push_subscriptions SET updated_at = 1').run()
    await api('/api/push/subscription', 'PUT', fixture.subscriptionBody('/travel', 'America/New_York'))
    expect((await runPushScheduler(fixture.env, at('2026-03-08T12:59:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-03-08T13:00:00Z'))).sent).toBe(2)
    expect((await runPushScheduler(fixture.env, at('2026-03-08T13:05:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(2)
  })

  it('uses the effective zone date to suppress photos across midnight', async () => {
    await api('/api/push/subscription', 'PUT', fixture.subscriptionBody('/travel', 'Asia/Tokyo'))
    await pref('08:00')
    await photo('2026-07-02')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T23:05:00Z'))).sent).toBe(0)
    await fixture.env.DB.prepare('DELETE FROM photos').run()
    expect((await runPushScheduler(fixture.env, at('2026-07-01T23:05:00Z'))).sent).toBe(1)
    expect(await fixture.env.DB.prepare('SELECT day_key FROM notification_log').first()).toEqual({ day_key: '2026-07-02' })
  })
  it('drops notification log days no zone can still be on', async () => {
    for (const day of ['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01']) {
      await fixture.env.DB.prepare("INSERT INTO notification_log (user_id, album_id, event, day_key, sent_at) VALUES ('alice', 'selfies', 'reminder', ?, 1)").bind(day).run()
    }
    await runPushScheduler(fixture.env, at('2026-07-01T00:30:00Z'))
    expect((await fixture.env.DB.prepare('SELECT day_key FROM notification_log ORDER BY day_key').all()).results)
      .toEqual([{ day_key: '2026-06-29' }, { day_key: '2026-06-30' }, { day_key: '2026-07-01' }])
  })

  it('sends an independently decryptable reminder at the local time, never before it', async () => {
    await subscribe()
    await pref('09:00')
    await fixture.env.DB.prepare("UPDATE albums SET time_zone = 'America/Los_Angeles' WHERE user_id = 'alice' AND id = 'selfies'").run()
    expect(await runPushScheduler(fixture.env, at('2026-07-01T15:59:00Z'))).toEqual({ sent: 0, skipped: 1, removed: 0, failed: 0 })
    expect(await runPushScheduler(fixture.env, at('2026-07-01T16:00:00Z'))).toEqual({ sent: 1, skipped: 0, removed: 0, failed: 0 })
    expect(fixture.received).toHaveLength(1)
    expect(fixture.received[0]?.payload).toEqual({ title: 'Selfies', body: "Time for today's photo.", albumId: 'selfies', tag: 'album-selfies', url: '/?album=selfies' })
    expect(fixture.received[0]?.headers).toMatchObject({ ttl: '14400', urgency: 'normal', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' })
    expect(fixture.received[0]?.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('signs a raw ES256 VAPID JWT with the correct audience, lifetime and subject', async () => {
    await subscribe()
    await pref()
    const now = at('2026-07-01T09:00:00Z')
    await runPushScheduler(fixture.env, now)
    const authorization = fixture.received[0]?.headers.authorization
    expect(typeof authorization).toBe('string')
    if (!authorization) throw new Error('Missing authorization')
    const token = verifyVapid(authorization, fixture.keys)
    expect(token.valid).toBe(true)
    expect(token.signatureLength).toBe(64)
    expect(token.header).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(token.claims).toEqual({ aud: fixture.endpoint, exp: now / 1000 + 43200, sub: fixture.env.VAPID_SUBJECT })
  })

  it('uses a new salt and ECDH sender key for each encrypted message', async () => {
    await subscribe('/one')
    await subscribe('/two')
    await pref()
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).sent).toBe(2)
    const first = fixture.received[0]
    const second = fixture.received[1]
    if (!first || !second) throw new Error('Missing deliveries')
    expect(first.bytes.subarray(0, 16).equals(second.bytes.subarray(0, 16))).toBe(false)
    expect(first.bytes.subarray(21, 86).equals(second.bytes.subarray(21, 86))).toBe(false)
    expect(decrypt(first.bytes, fixture.keys)).toEqual(decrypt(second.bytes, fixture.keys))
    expect(first.headers.authorization).toBe(second.headers.authorization)
    const altered = Buffer.from(first.bytes)
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1
    expect(() => decrypt(altered, fixture.keys)).toThrow()
  })

  it('does not catch up at the end of the three-hour morning window', async () => {
    await subscribe()
    await pref()
    expect(await runPushScheduler(fixture.env, at('2026-07-01T12:00:00Z'))).toEqual({ sent: 0, skipped: 1, removed: 0, failed: 0 })
    expect(fixture.received).toHaveLength(0)
  })

  it('suppresses every event once today has an active photo', async () => {
    await subscribe()
    await pref()
    await photo('2026-07-01')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(0)
  })

  it('sends a nudge only after the morning delivery, from 20:30 until 23:30', async () => {
    await subscribe()
    await pref()
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-07-02T09:00:00Z'))).sent).toBe(1)
    expect((await runPushScheduler(fixture.env, at('2026-07-02T20:29:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-07-02T20:30:00Z'))).sent).toBe(1)
    expect(fixture.received.at(-1)?.payload).toMatchObject({ body: "Still time for today's photo." })
    expect((await runPushScheduler(fixture.env, at('2026-07-02T23:30:00Z'))).sent).toBe(0)
  })

  it('suppresses the nudge after a photo arrives', async () => {
    await subscribe()
    await pref()
    await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))
    await photo('2026-07-01')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it.each(['18:31', '20:00'])('does not nudge a late reminder at %s', async time => {
    await subscribe()
    await pref(time)
    await runPushScheduler(fixture.env, at(`2026-07-01T${time}:00Z`))
    expect((await runPushScheduler(fixture.env, at('2026-07-01T22:59:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it('allows the 18:30 boundary and sends morning and nudge when their windows overlap', async () => {
    await subscribe()
    await pref('18:30')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(2)
    expect(fixture.received.map(value => value.payload)).toEqual([
      expect.objectContaining({ body: "Time for today's photo." }), expect.objectContaining({ body: "Still time for today's photo." }),
    ])
  })

  it.each([30, 100, 365])('sends the exact day %i milestone based on distinct active days', async day => {
    await subscribe()
    await pref()
    await history(day - 1)
    await photo('2020-01-01')
    await photo('2025-01-01', { deleted: true })
    await photo('2025-01-02', { purged: true })
    await photo('2026-07-02')
    await photo('2025-01-03', { userId: 'bob' })
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).sent).toBe(1)
    expect(fixture.received[0]?.payload).toMatchObject({ body: `Day ${day} today — keep it going.` })
  })

  it('deduplicates overlapping and repeated cron runs with the database claim', async () => {
    await subscribe()
    await pref()
    const now = at('2026-07-01T09:00:00Z')
    const results = await Promise.all([runPushScheduler(fixture.env, now), runPushScheduler(fixture.env, now)])
    expect(results.reduce((total, value) => total + value.sent, 0)).toBe(1)
    expect((await runPushScheduler(fixture.env, now + 300000)).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it('does not send a second morning event if the distinct-day count changes', async () => {
    await subscribe()
    await pref()
    await history(28)
    await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))
    await photo('2025-01-01')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:05:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it('fires once after the Los Angeles spring-forward gap for a 02:30 reminder', async () => {
    await subscribe()
    await pref('02:30')
    await fixture.env.DB.prepare("UPDATE albums SET time_zone = 'America/Los_Angeles' WHERE user_id = 'alice' AND id = 'selfies'").run()
    expect((await runPushScheduler(fixture.env, at('2026-03-08T09:55:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-03-08T10:00:00Z'))).sent).toBe(1)
    expect((await runPushScheduler(fixture.env, at('2026-03-08T10:30:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it('fires exactly once through both Los Angeles fall-back 01:30 hours', async () => {
    await subscribe()
    await pref('01:30')
    await fixture.env.DB.prepare("UPDATE albums SET time_zone = 'America/Los_Angeles' WHERE user_id = 'alice' AND id = 'selfies'").run()
    expect((await runPushScheduler(fixture.env, at('2026-11-01T08:25:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-11-01T08:30:00Z'))).sent).toBe(1)
    expect((await runPushScheduler(fixture.env, at('2026-11-01T09:30:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
  })

  it.each(['/gone', '/missing'])('deletes a subscription returning 404 or 410 at %s', async path => {
    await subscribe(path)
    await pref()
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).toEqual({ sent: 0, skipped: 0, removed: 1, failed: 0 })
    expect(await fixture.env.DB.prepare('SELECT endpoint FROM push_subscriptions').first()).toBeNull()
  })

  it('does not reuse an expired subscription for a nudge in the same run', async () => {
    await subscribe('/gone')
    await subscribe('/push')
    await pref('18:30')
    expect(await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).toEqual({ sent: 2, skipped: 0, removed: 1, failed: 0 })
    expect(fixture.received).toHaveLength(3)
  })

  it('ignores photos in another user or album and excludes deleted albums', async () => {
    await subscribe()
    await pref()
    await photo('2026-07-01', { userId: 'bob' })
    await photo('2026-07-01', { albumId: 'album-bbbbbbbbbbbbbbbbbbbb' })
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).sent).toBe(1)
    await fixture.env.DB.prepare("UPDATE albums SET deleted_at = 1 WHERE user_id = 'alice' AND id = 'selfies'").run()
    expect((await runPushScheduler(fixture.env, at('2026-07-02T09:00:00Z'))).sent).toBe(0)
    expect(await (await api('/api/push/prefs')).json()).toEqual({ prefs: [] })
    expect((await api('/api/push/prefs/selfies', 'PUT', { enabled: true, time: '09:00' })).status).toBe(404)
  })

  it('logs a failed send without retrying it or qualifying it for an evening nudge', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await subscribe('/fail')
    await pref()
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).toEqual({ sent: 0, skipped: 1, removed: 0, failed: 1 })
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:05:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(1)
    expect(error).toHaveBeenCalledWith('Push delivery failed', 503)
  })

  it('counts thrown deliveries and logs the error name and message without retrying', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await subscribe()
    await pref()
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost'))
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).toMatchObject({ sent: 0, skipped: 1, failed: 1 })
    expect(log).toHaveBeenCalledExactlyOnceWith('Push delivery failed', { name: 'TypeError', message: 'Network connection lost' })
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:05:00Z'))).sent).toBe(0)
    expect((await runPushScheduler(fixture.env, at('2026-07-01T20:30:00Z'))).sent).toBe(0)
    expect(send).toHaveBeenCalledOnce()
  })

  it('redacts subscription, key, payload and user data from thrown delivery messages', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await subscribe()
    await pref()
    const sensitive = [fixture.endpoint, `${fixture.endpoint}/push`, 'alice', 'selfies', 'Selfies',
      "Time for today's photo.", 'album-selfies', '/?album=selfies', fixture.env.VAPID_PUBLIC_KEY,
      fixture.env.VAPID_PRIVATE_KEY!, fixture.keys.point.toString('base64url'), fixture.keys.auth.toString('base64url')]
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(`Fetch failed: ${sensitive.join(' | ')}`))
    await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))
    expect(log).toHaveBeenCalledExactlyOnceWith('Push delivery failed', {
      name: 'TypeError', message: `Fetch failed: ${sensitive.map(() => '[redacted]').join(' | ')}`,
    })
  })

  it('sends nothing for disabled preferences, missing subscriptions or another user albums', async () => {
    await subscribe()
    await pref('09:00', 'selfies', 'alice', false)
    await pref('09:00', 'selfies', 'bob')
    await fixture.env.DB.prepare("INSERT INTO push_prefs VALUES ('alice', 'album-bbbbbbbbbbbbbbbbbbbb', 1, '09:00')").run()
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).toEqual({ sent: 0, skipped: 0, removed: 0, failed: 0 })
    expect(fixture.received).toHaveLength(0)
  })

  it('keeps the 40-send limit and delivers unclaimed events in the next run', async () => {
    for (let index = 0; index < 10; index++) await subscribe(`/device-${index}`)
    for (let index = 0; index < 5; index++) {
      const albumId = `album-${String(index).padStart(20, '0')}`
      await fixture.env.DB.prepare('INSERT INTO albums VALUES (?, ?, ?, NULL, 0, 0, NULL)').bind('alice', albumId, `Album ${index}`).run()
      await pref('09:00', albumId)
    }
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).toEqual({ sent: 40, skipped: 1, removed: 0, failed: 0 })
    expect(await runPushScheduler(fixture.env, at('2026-07-01T09:05:00Z'))).toEqual({ sent: 10, skipped: 4, removed: 0, failed: 0 })
    expect(fixture.received).toHaveLength(50)
  })

  it('ignores a subscription moved to another user', async () => {
    await subscribe()
    await pref()
    await subscribe('/push', 'bob')
    expect((await runPushScheduler(fixture.env, at('2026-07-01T09:00:00Z'))).sent).toBe(0)
    expect(fixture.received).toHaveLength(0)
  })
})
