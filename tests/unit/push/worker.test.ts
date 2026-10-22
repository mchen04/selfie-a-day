import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushEnvironment } from './environment.ts'

const workbox = vi.hoisted(() => ({ precache: vi.fn(), cleanup: vi.fn(), route: vi.fn(), claim: vi.fn(), shell: vi.fn() }))
vi.mock('workbox-core', () => ({ clientsClaim: workbox.claim }))
vi.mock('workbox-precaching', () => ({ precacheAndRoute: workbox.precache, cleanupOutdatedCaches: workbox.cleanup, createHandlerBoundToURL: workbox.shell }))
vi.mock('workbox-routing', () => ({ NavigationRoute: class {}, registerRoute: workbox.route }))

let handlers: Map<string, (event: unknown) => void>
let env: ReturnType<typeof pushEnvironment>
let scope: {
  __WB_MANIFEST: string[]
  location: { origin: string }
  registration: { showNotification: ReturnType<typeof vi.fn>; pushManager: ReturnType<typeof pushEnvironment>['manager'] }
  clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> }
  skipWaiting: ReturnType<typeof vi.fn>
  addEventListener: (type: string, handler: (event: unknown) => void) => void
}

async function dispatch(type: string, data: Record<string, unknown>) {
  const pending: Promise<unknown>[] = []
  const handler = handlers.get(type)
  expect(handler).toBeDefined()
  handler!({ ...data, waitUntil: (task: Promise<unknown>) => pending.push(task) })
  await Promise.all(pending)
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  env = pushEnvironment('granted')
  handlers = new Map()
  scope = {
    __WB_MANIFEST: ['index.html'], location: { origin: 'https://selfie.example' },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined), pushManager: env.manager },
    clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(null) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type, handler) => { handlers.set(type, handler) },
  }
  vi.stubGlobal('self', scope)
  await import('../../../src/sw.ts')
})
afterEach(() => vi.unstubAllGlobals())

describe('service worker events', () => {
  it('keeps precaching, navigation and user-approved updates registered', async () => {
    expect(workbox.precache).toHaveBeenCalledWith(['index.html'])
    expect(workbox.cleanup).toHaveBeenCalledOnce()
    expect(workbox.route).toHaveBeenCalledOnce()
    expect(workbox.claim).toHaveBeenCalledOnce()
    await dispatch('message', { data: { type: 'OTHER' } })
    expect(scope.skipWaiting).not.toHaveBeenCalled()
    await dispatch('message', { data: { type: 'SKIP_WAITING' } })
    expect(scope.skipWaiting).toHaveBeenCalledOnce()
  })

  it('shows the contract payload with its album link, tag, icon and badge', async () => {
    const payload = { title: 'Selfies', body: "Time for today's photo.", tag: 'album-selfies', url: '/?album=selfies' }
    await dispatch('push', { data: { json: () => payload } })
    expect(scope.registration.showNotification).toHaveBeenCalledWith('Selfies', {
      body: payload.body, tag: payload.tag, data: { url: payload.url }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    })
  })

  it.each(['missing', 'malformed', 'null'])('shows fallback copy for %s payloads', async (kind) => {
    await dispatch('push', { data: kind === 'missing' ? null : { json: () => { if (kind === 'malformed') throw new Error('Invalid JSON'); return null } } })
    expect(scope.registration.showNotification).toHaveBeenCalledWith('Selfie a Day', expect.objectContaining({ body: "Time for today's photo.", data: { url: '/' } }))
  })

  it('navigates and focuses an existing app window and closes the notification', async () => {
    const focus = vi.fn().mockResolvedValue(undefined)
    const navigate = vi.fn().mockResolvedValue({ focus })
    scope.clients.matchAll.mockResolvedValue([{ url: 'https://selfie.example/timeline', navigate }])
    const close = vi.fn()
    await dispatch('notificationclick', { notification: { close, data: { url: '/?album=selfies' } } })
    expect(close).toHaveBeenCalledOnce()
    expect(scope.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
    expect(navigate).toHaveBeenCalledWith('https://selfie.example/?album=selfies')
    expect(focus).toHaveBeenCalledOnce()
    expect(scope.clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens the album link when no app window exists', async () => {
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: '/?album=selfies' } } })
    expect(scope.clients.openWindow).toHaveBeenCalledWith('https://selfie.example/?album=selfies')
  })

  it('opens a new window if the old window cannot navigate', async () => {
    scope.clients.matchAll.mockResolvedValue([{ url: 'https://selfie.example/', navigate: vi.fn().mockResolvedValue(null) }])
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: null } })
    expect(scope.clients.openWindow).toHaveBeenCalledWith('https://selfie.example/')
  })

  it('keeps notification links on the app origin', async () => {
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: 'https://outside.example/' } } })
    expect(scope.clients.openWindow).toHaveBeenCalledWith('https://selfie.example/')
  })

  it('renews an expired subscription and removes the old endpoint', async () => {
    await dispatch('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://web.push.apple.com/old' } })
    expect(env.manager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
    expect(env.request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/push/config', 'GET'], ['/api/push/subscription', 'PUT'], ['/api/push/subscription', 'DELETE'],
    ])
  })

  it('uses a replacement supplied by the browser and tolerates offline renewal', async () => {
    await dispatch('pushsubscriptionchange', { newSubscription: env.subscription })
    expect(env.manager.subscribe).not.toHaveBeenCalled()
    expect(env.request).toHaveBeenCalledOnce()
    env.request.mockRejectedValueOnce(new TypeError('Offline'))
    await dispatch('pushsubscriptionchange', {})
  })
})
