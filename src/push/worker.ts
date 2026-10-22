import { api } from '../api/client.ts'
import { applicationServerKey, subscriptionData } from './client.ts'

interface PushChangeEvent extends ExtendableEvent {
  oldSubscription?: PushSubscription | null
  newSubscription?: PushSubscription | null
}

function appUrl(scope: ServiceWorkerGlobalScope, value: unknown): string {
  if (typeof value !== 'string') return '/'
  try {
    const url = new URL(value, scope.location.origin)
    return url.origin === scope.location.origin ? url.pathname + url.search + url.hash : '/'
  } catch { return '/' }
}

async function openCapture(scope: ServiceWorkerGlobalScope, value: unknown): Promise<void> {
  const url = new URL(appUrl(scope, value), scope.location.origin).href
  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const client = windows.find((window) => new URL(window.url).origin === scope.location.origin)
  if (client) {
    const navigated = await client.navigate(url).catch(() => null)
    if (navigated) { await navigated.focus(); return }
  }
  await scope.clients.openWindow(url)
}

async function renewSubscription(scope: ServiceWorkerGlobalScope, event: PushChangeEvent): Promise<void> {
  try {
    let subscription = event.newSubscription
    if (!subscription) {
      const { publicKey } = await api.pushConfig()
      subscription = await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) })
    }
    await api.subscribe(subscriptionData(subscription))
    if (event.oldSubscription && event.oldSubscription.endpoint !== subscription.endpoint) await api.removeSubscription(event.oldSubscription.endpoint)
  } catch { return }
}

export function installPushHandlers(scope: ServiceWorkerGlobalScope): void {
  scope.addEventListener('push', (event) => {
    let payload: Record<string, unknown> = {}
    try {
      const data: unknown = event.data?.json()
      if (data && typeof data === 'object') payload = data as Record<string, unknown>
    } catch { payload = {} }
    event.waitUntil(scope.registration.showNotification(
      typeof payload.title === 'string' && payload.title ? payload.title : 'Selfie a Day',
      {
        body: typeof payload.body === 'string' && payload.body ? payload.body : "Time for today's photo.",
        tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : 'selfie-reminder',
        data: { url: appUrl(scope, payload.url) }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      },
    ))
  })
  scope.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: unknown } | null
    event.waitUntil(openCapture(scope, data?.url))
  })
  scope.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(renewSubscription(scope, event))
  })
}
