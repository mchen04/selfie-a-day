import type { Env } from './env'
import { empty, HttpError, json, readJson } from './http'
import { base64url, hashPassword, tokenHash, verifyPassword } from './password'

const DAY = 86400000
const SESSION_LIFETIME = 90 * DAY
const LOGIN_WINDOW = 15 * 60000
const SIGNUP_WINDOW = 60 * 60000

interface User {
  id: string
  username: string
}

export interface Session {
  user: User
  id: string
  cookie?: string
}

interface Attempt {
  window_start: number
  count: number
}

export function cookieName(env: Env): string {
  return env.COOKIE_SECURE === 'false' ? 'sad_session' : '__Host-sad_session'
}

export function sessionCookie(env: Env, token: string, maxAge = SESSION_LIFETIME / 1000): string {
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${env.COOKIE_SECURE === 'false' ? '' : '; Secure'}`
}

function requestToken(request: Request, env: Env): string | null {
  const prefix = `${cookieName(env)}=`
  const cookie = (request.headers.get('Cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  const token = cookie?.slice(prefix.length)
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export async function authenticate(request: Request, env: Env, now: number): Promise<Session | null> {
  const token = requestToken(request, env)
  if (!token) return null
  const id = await tokenHash(token)
  const row = await env.DB.prepare(`SELECT u.id, u.username, s.expires_at, s.last_seen_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).bind(id, now)
    .first<User & { expires_at: number; last_seen_at: number }>()
  if (!row) return null
  const session: Session = { user: { id: row.id, username: row.username }, id }
  if (row.expires_at - now < 45 * DAY) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?')
      .bind(now + SESSION_LIFETIME, now, id, row.id).run()
    session.cookie = sessionCookie(env, token)
  } else if (row.last_seen_at <= now - 3_600_000) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND user_id = ? AND last_seen_at <= ?')
      .bind(now, id, row.id, now - 3_600_000).run()
  }
  return session
}

async function createSession(env: Env, userId: string, now: number): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await tokenHash(token), userId, now, now + SESSION_LIFETIME, now).run()
  return sessionCookie(env, token)
}

function clientIp(request: Request): string {
  // Direct workers.dev callers can spoof x-forwarded-for to bypass IP limits; username limits and PBKDF2 still apply.
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('cf-connecting-ip')?.trim() || 'unknown'
}

function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)
}

function rateError(start: number, duration: number, now: number): HttpError {
  return new HttpError(429, 'too_many_attempts', { 'Retry-After': String(Math.max(1, Math.ceil((start + duration - now) / 1000))) })
}

async function incrementAttempt(env: Env, key: string, duration: number, now: number): Promise<Attempt> {
  const attempt = await env.DB.prepare(`INSERT INTO auth_attempts (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    RETURNING window_start, count`).bind(key, now, now - duration, now - duration).first<Attempt>()
  if (!attempt) throw new Error('counter_failed')
  return attempt
}

async function signup(request: Request, env: Env, now: number): Promise<Response> {
  const attempt = await incrementAttempt(env, `signup-ip:${clientIp(request)}`, SIGNUP_WINDOW, now)
  if (attempt.count > 10) throw rateError(attempt.window_start, SIGNUP_WINDOW, now)
  const body = await readJson(request)
  const username = normalizeUsername(body.username)
  if (!validUsername(username)) throw new HttpError(400, 'invalid_username')
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new HttpError(400, 'invalid_password')
  const passwordHash = await hashPassword(body.password)
  const user = { id: crypto.randomUUID(), username }
  try {
    await env.DB.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, username, passwordHash, now).run()
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: users.username')) throw new HttpError(409, 'username_taken')
    throw error
  }
  return json({ user }, 201, { 'Set-Cookie': await createSession(env, user.id, now) })
}

async function login(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request)
  const username = normalizeUsername(body.username)
  const usernameKey = `login-user:${username.slice(0, 32)}`
  const dailyUsernameKey = `login-user-day:${username.slice(0, 32)}`
  const ipKey = `login-ip:${clientIp(request)}`
  const limits = [
    { key: dailyUsernameKey, limit: 30, duration: DAY },
    { key: usernameKey, limit: 10, duration: LOGIN_WINDOW },
    { key: ipKey, limit: 50, duration: LOGIN_WINDOW },
  ]
  const attempts = await Promise.all(limits.map(async (limit) => ({ ...limit, ...await incrementAttempt(env, limit.key, limit.duration, now) })))
  const refund = (entries: typeof attempts) => env.DB.batch(entries.map((attempt) =>
    env.DB.prepare('UPDATE auth_attempts SET count = max(0, count - 1) WHERE key = ? AND window_start = ?')
      .bind(attempt.key, attempt.window_start)))
  const exceeded = attempts.find((attempt) => attempt.count > attempt.limit)
  if (exceeded) {
    await refund(attempts)
    throw rateError(exceeded.window_start, exceeded.duration, now)
  }
  const user = validUsername(username)
    ? await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').bind(username)
      .first<User & { password_hash: string }>() : null
  const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : ''
  const valid = await verifyPassword(password, user?.password_hash ?? null)
  if (!valid || !user) {
    throw new HttpError(401, 'invalid_credentials')
  }
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ? AND window_start = ?').bind(usernameKey, attempts[1]!.window_start).run()
  await refund(attempts.filter((attempt) => attempt.key !== usernameKey))
  return json({ user: { id: user.id, username: user.username } }, 200, { 'Set-Cookie': await createSession(env, user.id, now) })
}

export async function purgeExpiredAuth(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').bind(now),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE key IN (
      SELECT key FROM auth_attempts WHERE window_start <= ? AND window_start <= CASE
        WHEN key LIKE 'login-user-day:%' THEN ? WHEN key LIKE 'signup-ip:%' THEN ? ELSE ? END
      ORDER BY window_start LIMIT 100)`).bind(now - LOGIN_WINDOW, now - DAY, now - SIGNUP_WINDOW, now - LOGIN_WINDOW),
  ])
}

export async function handleAuth(request: Request, env: Env, url: URL, session: Session | null, now: number): Promise<Response | null> {
  const method = request.method === 'HEAD' ? 'GET' : request.method
  if (url.pathname === '/api/auth/signup' && method === 'POST') return signup(request, env, now)
  if (url.pathname === '/api/auth/login' && method === 'POST') return login(request, env, now)
  if (url.pathname === '/api/auth/logout' && method === 'POST') {
    if (session) await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(session.id, session.user.id).run()
    const response = empty()
    response.headers.set('Set-Cookie', sessionCookie(env, '', 0))
    return response
  }
  if (url.pathname === '/api/auth/me' && method === 'GET') {
    if (!session) throw new HttpError(401, 'unauthenticated')
    return json({ user: session.user })
  }
  if (/^\/api\/auth\/(signup|login|logout|me)$/.test(url.pathname)) throw new HttpError(405, 'method_not_allowed')
  return null
}
