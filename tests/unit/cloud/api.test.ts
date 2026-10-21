import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, onSignedOut, uploadPhoto } from '../../../src/api/client.ts'
import { photo, reply } from './fixtures.ts'

afterEach(() => vi.unstubAllGlobals())

describe('API contract', () => {
  it('sends same-origin credentials and CSRF on writes only', async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(reply({ user: { id: 'synthetic', username: 'synthetic' } })))
    vi.stubGlobal('fetch', request)
    await api.me()
    await api.login('synthetic', crypto.randomUUID())
    const get = request.mock.calls[0]![1] as RequestInit
    const post = request.mock.calls[1]![1] as RequestInit
    expect(get.credentials).toBe('same-origin')
    expect(new Headers(get.headers).has('X-Selfie-CSRF')).toBe(false)
    expect(new Headers(post.headers).get('X-Selfie-CSRF')).toBe('1')
    expect(new Headers(post.headers).get('Content-Type')).toBe('application/json')
  })
  it('lets the browser set the multipart boundary and sends timer metadata', async () => {
    const request = vi.fn().mockResolvedValue(reply({ photo: photo(), replaced: [] }, 201))
    vi.stubGlobal('fetch', request)
    await uploadPhoto({ ...photo(), timerSeconds: 5 }, new Blob([new Uint8Array(16)], { type: 'image/webp' }), new Blob([new Uint8Array(4)], { type: 'image/webp' }))
    const init = request.mock.calls[0]![1] as RequestInit
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
    expect(new Headers(init.headers).get('X-Selfie-CSRF')).toBe('1')
    expect(JSON.parse((init.body as FormData).get('meta') as string)).toMatchObject({ timerSeconds: 5 })
    expect((init.body as FormData).has('master')).toBe(true)
  })
  it('signs out on a protected 401, but keeps login errors inline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'invalid_credentials' }, 401)))
    const signedOut = vi.fn()
    const off = onSignedOut(signedOut)
    try {
      await expect(api.login('synthetic', crypto.randomUUID())).rejects.toThrow(/incorrect/)
      expect(signedOut).not.toHaveBeenCalled()
      await expect(api.sync()).rejects.toBeInstanceOf(ApiError)
      expect(signedOut).toHaveBeenCalledOnce()
    } finally { off() }
  })
  it('shows the server wait time for rate limits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'too_many_attempts' }, 429, { 'Retry-After': '120' })))
    const error = await api.signup('synthetic', crypto.randomUUID()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).retryAfter).toBe(120)
    expect((error as ApiError).message).toContain('2 minute')
  })
  it('maps restore conflicts to an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'day_taken' }, 409)))
    await expect(api.patchPhoto(photo().id, null)).rejects.toThrow(/already has a photo/)
  })
})
