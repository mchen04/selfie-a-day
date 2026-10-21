import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createHarness, type Harness, ORIGIN, TEST_NOW, TEST_PASSWORD } from '../support/harness'
import { tokenHash } from '../../src/core/password'

describe('accounts and sessions in workerd', () => {
  let h: Harness
  beforeAll(async () => { h = await createHarness() })
  afterAll(async () => { await h?.dispose() })

  it('signs up a normalized user, stores only hashes, and reads me', async () => {
    const response = await h.request('/api/auth/signup', { method: 'POST', json: { username: '  Abc.Def  ', password: TEST_PASSWORD }, ip: '192.0.2.10' })
    expect(response.status).toBe(201)
    const cookie = response.headers.get('Set-Cookie')!
    expect(cookie).toMatch(/^__Host-sad_session=[A-Za-z0-9_-]{43};/)
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=7776000']) expect(cookie).toContain(attribute)
    expect(cookie).not.toContain('Domain=')
    const data = await response.json<{ user: { id: string; username: string } }>()
    expect(data.user.username).toBe('abc.def')
    const row = await h.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(data.user.id).first<{ password_hash: string }>()
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(row!.password_hash).not.toContain(TEST_PASSWORD)
    const token = cookie.split(';')[0]!.split('=')[1]!
    const session = await h.env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(data.user.id).first<{ id: string }>()
    expect(session!.id).toBe(await tokenHash(token))
    expect(session!.id).not.toBe(token)
    const me = await h.request('/api/auth/me', { cookie })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual(data)
    expect(me.headers.get('Cache-Control')).toBe('no-store')
    expect(me.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(me.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const duplicate = await h.request('/api/auth/signup', { method: 'POST', json: { username: 'ABC.DEF', password: TEST_PASSWORD }, ip: '192.0.2.10' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'username_taken' })
  })

  it('logs in, clears the username failure counter, and logs out', async () => {
    const user = await h.user()
    const bad = await h.request('/api/auth/login', { method: 'POST', json: { username: user.username, password: randomBytes(12).toString('base64url') }, ip: '192.0.2.11' })
    expect(bad.status).toBe(401)
    const good = await h.request('/api/auth/login', { method: 'POST', json: { username: user.username.toUpperCase(), password: TEST_PASSWORD }, ip: '192.0.2.11' })
    expect(good.status).toBe(200)
    expect(await good.json()).toEqual({ user: { id: user.id, username: user.username } })
    expect(await h.env.DB.prepare('SELECT count FROM auth_attempts WHERE key = ?').bind(`login-user:${user.username}`).first()).toBeNull()
    const ip = await h.env.DB.prepare('SELECT count FROM auth_attempts WHERE key = ?').bind('login-ip:192.0.2.11').first<{ count: number }>()
    expect(ip!.count).toBe(1)
    const cookie = good.headers.get('Set-Cookie')!
    const logout = await h.request('/api/auth/logout', { method: 'POST', cookie })
    expect(logout.status).toBe(204)
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect((await h.request('/api/auth/me', { cookie })).status).toBe(401)
    expect((await h.request('/api/auth/logout', { method: 'POST' })).status).toBe(204)
    expect((await h.request('/api/auth/me')).status).toBe(401)
  })

  it.each([
    { username: 'ab', password: TEST_PASSWORD, error: 'invalid_username' },
    { username: 'bad name', password: TEST_PASSWORD, error: 'invalid_username' },
    { username: 'abcdefgh', password: randomBytes(3).toString('hex'), error: 'invalid_password' },
    { username: 'abcdefgh', password: randomBytes(200).toString('hex'), error: 'invalid_password' },
  ])('rejects signup input: $error', async ({ username, password, error }) => {
    const response = await h.request('/api/auth/signup', { method: 'POST', json: { username, password }, ip: randomBytes(8).toString('hex') })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
  })

  it('expires sessions and renews only below 45 days remaining', async () => {
    const user = await h.user()
    const token = user.cookie.split('=')[1]!
    const sessionId = await tokenHash(token)
    const threshold = TEST_NOW + 45 * 86400000
    await h.sql('UPDATE sessions SET expires_at = ? WHERE id = ?', threshold, sessionId)
    expect((await h.request('/api/auth/me', { cookie: user.cookie })).headers.get('Set-Cookie')).toBeNull()
    const renewed = await h.request('/api/auth/me', { cookie: user.cookie, now: TEST_NOW + 1 })
    expect(renewed.status).toBe(200)
    expect(renewed.headers.get('Set-Cookie')).toContain(user.cookie)
    const row = await h.env.DB.prepare('SELECT expires_at, last_seen_at FROM sessions WHERE id = ?').bind(sessionId).first<{ expires_at: number; last_seen_at: number }>()
    expect(row).toEqual({ expires_at: TEST_NOW + 1 + 90 * 86400000, last_seen_at: TEST_NOW + 1 })
    await h.sql('UPDATE sessions SET expires_at = ? WHERE id = ?', TEST_NOW, sessionId)
    expect((await h.request('/api/auth/me', { cookie: user.cookie })).status).toBe(401)
    expect((await h.request('/api/auth/me', { cookie: `__Host-sad_session=${randomBytes(32).toString('base64url')}` })).status).toBe(401)
  })

  it.each(['/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/trash/empty', '/api/push/subscription'])('rejects CSRF failures on %s', async (path) => {
    const user = await h.user()
    const cases: Record<string, string>[] = [{ Origin: ORIGIN }, { Origin: 'https://evil.example', 'X-Selfie-CSRF': '1' }, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, { 'X-Selfie-CSRF': '1' }]
    for (const headers of cases) {
      const response = await h.request(path, { method: 'POST', cookie: user.cookie, csrf: false, headers })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    }
  })

  it('rejects an Origin prefix match and OPTIONS, and authenticates push routes', async () => {
    expect((await h.request('/api/auth/login', { method: 'POST', headers: { Origin: `${ORIGIN}.evil.example` }, json: {} })).status).toBe(403)
    expect((await h.request('/api/auth/login', { method: 'OPTIONS' })).status).toBe(405)
    expect((await h.request('/api/push/config')).status).toBe(401)
    expect((await h.request('/api/push/subscription', { method: 'PUT', json: {} })).status).toBe(401)
    expect((await h.request('/api/sync')).status).toBe(401)
  })

  it('limits ten login failures per username and opens the window after 15 minutes', async () => {
    const username = `absent-${randomBytes(5).toString('hex')}`
    for (let i = 0; i < 10; i++) {
      const response = await h.request('/api/auth/login', { method: 'POST', json: { username, password: TEST_PASSWORD }, ip: `198.51.100.${i}` })
      expect(response.status).toBe(401)
    }
    const blocked = await h.request('/api/auth/login', { method: 'POST', json: { username, password: TEST_PASSWORD }, ip: '198.51.100.100' })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'too_many_attempts' })
    expect(blocked.headers.get('Retry-After')).toBe('900')
    const reset = await h.request('/api/auth/login', { method: 'POST', json: { username, password: TEST_PASSWORD }, ip: '198.51.100.100', now: TEST_NOW + 900000 })
    expect(reset.status).toBe(401)
  })

  it('limits fifty login failures per IP across usernames', async () => {
    const ip = '203.0.113.55'
    for (let i = 0; i < 50; i++) {
      const response = await h.request('/api/auth/login', { method: 'POST', json: { username: `no-user-${i}`, password: TEST_PASSWORD }, ip })
      expect(response.status).toBe(401)
    }
    const blocked = await h.request('/api/auth/login', { method: 'POST', json: { username: 'another-user', password: TEST_PASSWORD }, ip })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('900')
  })

  it('uses the first forwarded IP when cf-connecting-ip is absent', async () => {
    await h.sql('INSERT INTO auth_attempts (key, window_start, count) VALUES (?, ?, ?)', 'login-ip:203.0.113.56', TEST_NOW, 50)
    const response = await h.request('/api/auth/login', { method: 'POST', json: { username: 'someone', password: TEST_PASSWORD }, headers: { 'cf-connecting-ip': '', 'x-forwarded-for': '203.0.113.56, 203.0.113.57' } })
    expect(response.status).toBe(429)
  })

  it('limits signups to ten attempts per IP each hour', async () => {
    for (let i = 0; i < 10; i++) {
      const response = await h.request('/api/auth/signup', { method: 'POST', json: { username: 'x', password: TEST_PASSWORD }, ip: '203.0.113.60' })
      expect(response.status).toBe(400)
    }
    const blocked = await h.request('/api/auth/signup', { method: 'POST', json: {}, ip: '203.0.113.60' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('3600')
    expect((await h.request('/api/auth/signup', { method: 'POST', json: {}, ip: '203.0.113.60', now: TEST_NOW + 3600000 })).status).toBe(400)
  })
})

describe('local cookie mode', () => {
  let h: Harness
  beforeAll(async () => { h = await createHarness(false) })
  afterAll(async () => { await h?.dispose() })
  it('uses the local cookie without Secure and clears it on logout', async () => {
    const user = await h.user()
    expect(user.cookie).toMatch(/^sad_session=/)
    const login = await h.request('/api/auth/login', { method: 'POST', json: { username: user.username, password: TEST_PASSWORD } })
    const cookie = login.headers.get('Set-Cookie')!
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=7776000']) expect(cookie).toContain(attribute)
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain('Domain=')
    expect((await h.request('/api/auth/me', { cookie })).status).toBe(200)
    const logout = await h.request('/api/auth/logout', { method: 'POST', cookie })
    expect(logout.headers.get('Set-Cookie')).toMatch(/^sad_session=;/)
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(logout.headers.get('Set-Cookie')).not.toContain('Secure')
  })
})
