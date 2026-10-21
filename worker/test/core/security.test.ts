import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { sessionCookie } from '../../src/core/auth'
import type { Env } from '../../src/core/env'

const origin = 'https://selfie-a-day.vercel.app'

describe('request security boundary', () => {
  it.each(['true', '', 'unexpected'])('uses Secure cookies unless explicitly disabled: %s', (mode) => {
    const cookie = sessionCookie({ COOKIE_SECURE: mode } as Env, randomBytes(32).toString('base64url'))
    expect(cookie).toMatch(/^__Host-sad_session=/)
    expect(cookie).toContain('; Secure')
    expect(cookie).not.toContain('Domain=')
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s with missing CSRF or Origin before database access', async (method) => {
    const env = { ALLOWED_ORIGINS: origin } as Env
    const cases: Record<string, string>[] = [{ Origin: origin }, { 'X-Selfie-CSRF': '1' }, { Origin: `${origin}.evil.example`, 'X-Selfie-CSRF': '1' }]
    for (const headers of cases) {
      const response = await worker.fetch(new Request('https://api.example/api/photos/00000000000000000001', { method, headers }), env)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    }
  })

  it('rejects preflight requests without CORS headers', async () => {
    const response = await worker.fetch(new Request('https://api.example/api/sync', { method: 'OPTIONS', headers: { Origin: origin } }), {} as Env)
    expect(response.status).toBe(405)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
