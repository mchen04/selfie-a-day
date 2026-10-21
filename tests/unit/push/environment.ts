import { vi } from 'vitest'
import type { PushPreference } from '../../../src/api/client.ts'

export function pushEnvironment(permission: NotificationPermission = 'default') {
  const unsubscribe = vi.fn().mockResolvedValue(true)
  const subscription = {
    endpoint: 'https://web.push.apple.com/synthetic-device',
    toJSON: () => ({ keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth' } }),
    unsubscribe,
  } as unknown as PushSubscription
  let current: PushSubscription | null = null
  const notification = {
    permission,
    requestPermission: vi.fn(() => { notification.permission = 'granted'; return Promise.resolve('granted') }),
  }
  const manager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => { current = subscription; return Promise.resolve(subscription) }),
  }
  const registration = { pushManager: manager }
  vi.stubGlobal('PushManager', function () {})
  vi.stubGlobal('Notification', notification)
  vi.stubGlobal('navigator', {
    userAgent: 'Synthetic desktop', maxTouchPoints: 0,
    serviceWorker: { ready: Promise.resolve(registration), getRegistration: vi.fn(() => Promise.resolve(registration)) },
  })
  let prefs: PushPreference[] = []
  const request = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/push/config') return Promise.resolve(Response.json({ publicKey: 'BAECAwQ' }))
    if (path === '/api/push/prefs') return Promise.resolve(Response.json({ prefs }))
    if (path.startsWith('/api/push/prefs/')) {
      const pref = { albumId: path.split('/').at(-1), ...JSON.parse(init?.body as string) as object }
      return Promise.resolve(Response.json({ pref }))
    }
    if (path === '/api/push/subscription') return Promise.resolve(new Response(null, { status: 204 }))
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', request)
  return {
    subscription, unsubscribe, notification, manager, registration, request,
    setSubscription: (next: PushSubscription | null) => { current = next },
    setPrefs: (next: PushPreference[]) => { prefs = next },
  }
}
