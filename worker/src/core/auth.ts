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
  const row = await env.DB.prepare(`SELECT u.id, u.username, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).bind(id, now)
    .first<User & { expires_at: number }>()
  if (!row) return null
  const session: Session = { user: { id: row.id, username: row.username }, id }
  if (row.expires_at - now < 45 * DAY) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?')
      .bind(now + SESSION_LIFETIME, now, id, row.id).run()
    session.cookie = sessionCookie(env, token)
  } else {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND user_id = ?').bind(now, id, row.id).run()
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

async function assertRate(env: Env, keys: string[], limit: number, duration: number, now: number): Promise<void> {
  for (const key of keys) {
    const attempt = await env.DB.prepare('SELECT window_start, count FROM auth_attempts WHERE key = ?').bind(key).first<Attempt>()
    if (attempt && attempt.window_start > now - duration && attempt.count >= limit) throw rateError(attempt.window_start, duration, now)
  }
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
  await assertRate(env, [dailyUsernameKey], 30, DAY, now)
  await assertRate(env, [usernameKey], 10, LOGIN_WINDOW, now)
  await assertRate(env, [ipKey], 50, LOGIN_WINDOW, now)
  const user = validUsername(username)
    ? await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').bind(username)
      .first<User & { password_hash: string }>() : null
  const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : ''
  const valid = await verifyPassword(password, user?.password_hash ?? null)
  if (!valid || !user) {
    await incrementAttempt(env, usernameKey, LOGIN_WINDOW, now)
    await incrementAttempt(env, ipKey, LOGIN_WINDOW, now)
    const daily = await incrementAttempt(env, dailyUsernameKey, DAY, now)
    if (daily.count >= 30) throw rateError(daily.window_start, DAY, now)
    throw new HttpError(401, 'invalid_credentials')
  }
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(usernameKey).run()
  return json({ user: { id: user.id, username: user.username } }, 200, { 'Set-Cookie': await createSession(env, user.id, now) })
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
