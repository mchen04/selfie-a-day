import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationServerKey, deviceTimeZone, pushState, resyncDevice, subscribeDevice, unsubscribeDevice } from '../../../src/push/client.ts'
import { pushEnvironment } from './environment.ts'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

describe('push support and permission', () => {
  it.each(['default', 'granted', 'denied'] as const)('reports %s without asking permission', (permission) => {
    const env = pushEnvironment(permission)
    expect(pushState()).toBe(permission)
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
  })

  it.each(['serviceWorker', 'PushManager', 'Notification'])('requires %s', (missing) => {
    pushEnvironment()
    if (missing === 'serviceWorker') vi.stubGlobal('navigator', { userAgent: 'Synthetic' })
    else vi.stubGlobal(missing, undefined)
    expect(pushState()).toBe('unsupported')
  })

  it('requires installation on iPhone and accepts legacy standalone mode', () => {
    pushEnvironment()
    Object.assign(navigator, { userAgent: 'iPhone' })
    expect(pushState()).toBe('not-installed')
    Object.assign(navigator, { standalone: true })
    expect(pushState()).toBe('default')
  })

  it('detects iPad desktop mode and standard standalone mode', () => {
    pushEnvironment()
    Object.assign(navigator, { userAgent: 'Macintosh', maxTouchPoints: 5 })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    expect(pushState()).toBe('not-installed')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(pushState()).toBe('default')
  })

  it('decodes an unpadded base64url VAPID key', () => {
    expect([...applicationServerKey('BP_-')]).toEqual([4, 255, 254])
  })
})

describe('device subscriptions', () => {
  it('asks permission synchronously, subscribes, and sends credentials, CSRF and the device zone', async () => {
    const env = pushEnvironment()
    const pending = subscribeDevice()
    expect(env.notification.requestPermission).toHaveBeenCalledOnce()
    expect(env.request).not.toHaveBeenCalled()
    await pending
    expect(env.manager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2, 3, 4]) })
    const [path, init] = env.request.mock.calls.at(-1)!
    expect(path).toBe('/api/push/subscription')
    expect(JSON.parse(init?.body as string)).toEqual({ endpoint: env.subscription.endpoint, keys: env.subscription.toJSON().keys, timeZone: deviceTimeZone() })
    expect(init?.credentials).toBe('same-origin')
    expect(new Headers(init?.headers).get('X-Selfie-CSRF')).toBe('1')
  })

  it.each(['default', 'denied'] as const)('never asks or subscribes on app start with %s permission', async (permission) => {
    const env = pushEnvironment(permission)
    await resyncDevice('synthetic')
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
    expect(env.manager.subscribe).not.toHaveBeenCalled()
    expect(env.request).not.toHaveBeenCalled()
  })

  it('re-syncs a rotated endpoint on start without another permission prompt', async () => {
    const env = pushEnvironment('granted')
    const rotated = { ...env.subscription, endpoint: 'https://web.push.apple.com/rotated' } as PushSubscription
    env.setSubscription(rotated)
    await resyncDevice('synthetic')
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
    expect(env.manager.subscribe).not.toHaveBeenCalled()
    expect(JSON.parse(env.request.mock.calls[0]![1]?.body as string)).toMatchObject({ endpoint: rotated.endpoint })
  })

  it('replaces a missing subscription when permission is already granted', async () => {
    const env = pushEnvironment('granted')
    await resyncDevice('synthetic')
    expect(env.manager.subscribe).toHaveBeenCalledOnce()
    expect(env.request).toHaveBeenCalledTimes(2)
  })

  it('re-sends an unchanged subscription only after a day, or for another user, endpoint or time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const env = pushEnvironment('granted')
      env.setSubscription(env.subscription)
      const puts = () => env.request.mock.calls.filter(([path, init]) => path === '/api/push/subscription' && init?.method === 'PUT').length
      await resyncDevice('synthetic')
      await resyncDevice('synthetic')
      expect(puts()).toBe(1)
      await resyncDevice('other-synthetic')
      expect(puts()).toBe(2)
      env.setSubscription({ ...env.subscription, endpoint: 'https://web.push.apple.com/rotated' })
      await resyncDevice('other-synthetic')
      expect(puts()).toBe(3)
      vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }) }) })
      await resyncDevice('other-synthetic')
      expect(puts()).toBe(4)
      await resyncDevice('other-synthetic')
      expect(puts()).toBe(4)
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
      await resyncDevice('other-synthetic')
      expect(puts()).toBe(5)
    } finally { vi.useRealTimers() }
  })

  it('retries a failed send, and always sends a new or explicitly enabled subscription', async () => {
    const env = pushEnvironment('granted')
    env.setSubscription(env.subscription)
    const puts = () => env.request.mock.calls.filter(([path, init]) => path === '/api/push/subscription' && init?.method === 'PUT').length
    env.request.mockRejectedValueOnce(new TypeError('Offline'))
    await expect(resyncDevice('synthetic')).rejects.toThrow('Offline')
    await resyncDevice('synthetic')
    expect(puts()).toBe(2)
    await subscribeDevice()
    expect(puts()).toBe(3)
    await resyncDevice('synthetic')
    expect(puts()).toBe(4)
    env.setSubscription(null)
    await resyncDevice('synthetic')
    expect(env.manager.subscribe).toHaveBeenCalledOnce()
    expect(puts()).toBe(5)
    await unsubscribeDevice()
    expect(localStorage.getItem('sad.push.sent')).toBeNull()
  })

  it('removes the server subscription before unsubscribing locally', async () => {
    const env = pushEnvironment('granted')
    env.setSubscription(env.subscription)
    await unsubscribeDevice()
    expect(env.request).toHaveBeenCalledWith('/api/push/subscription', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ endpoint: env.subscription.endpoint }) }))
    expect(env.unsubscribe).toHaveBeenCalledOnce()
    expect(env.request.mock.invocationCallOrder[0]).toBeLessThan(env.unsubscribe.mock.invocationCallOrder[0]!)
  })

  it('waits for an in-flight sync before deleting, so it cannot restore a logged-out endpoint', async () => {
    const env = pushEnvironment('granted')
    let ready!: (value: { pushManager: typeof env.manager }) => void
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: new Promise((resolve) => { ready = resolve }) })
    const sync = resyncDevice('synthetic')
    const logout = unsubscribeDevice()
    env.setSubscription(env.subscription)
    ready(env.registration)
    await Promise.all([sync, logout])
    expect(env.request.mock.calls.map((call) => call[1]?.method)).toEqual(['DELETE'])
  })

  it('keeps logout retryable when server removal fails', async () => {
    const env = pushEnvironment('granted')
    env.setSubscription(env.subscription)
    env.request.mockResolvedValueOnce(Response.json({ error: 'internal_error' }, { status: 500 }))
    await expect(unsubscribeDevice()).rejects.toThrow()
    expect(env.unsubscribe).not.toHaveBeenCalled()
  })

  it('does not hold logout open while service worker activation is still pending', async () => {
    const env = pushEnvironment('granted')
    let activate!: (value: typeof env.registration) => void
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: new Promise((resolve) => { activate = resolve }) })
    const sync = resyncDevice('synthetic')
    const logout = unsubscribeDevice()
    try {
      await expect(Promise.race([logout.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))])).resolves.toBe(true)
    } finally {
      activate(env.registration)
      await Promise.all([sync, logout])
    }
  })
})
