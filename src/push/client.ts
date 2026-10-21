import { api, type PushSubscriptionData } from '../api/client.ts'
import { isIOS, isStandalone } from '../camera/support.ts'

export type PushState = NotificationPermission | 'unsupported' | 'not-installed'

export function pushState(): PushState {
  if (isIOS() && !isStandalone()) return 'not-installed'
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined' || typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const value = publicKey.replaceAll('-', '+').replaceAll('_', '/')
  return Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
}

export function subscriptionData(subscription: PushSubscription): PushSubscriptionData {
  const keys = subscription.toJSON().keys
  if (!keys?.p256dh || !keys.auth) throw new Error('Could not read the reminder subscription. Try again.')
  return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, timeZone: deviceTimeZone() }
}

let syncing: Promise<void> | null = null
let cancelActivation: (() => void) | null = null
let revision = 0

async function syncSubscription(): Promise<void> {
  if (syncing) return syncing
  const current = revision
  const task = (async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => { cancelActivation = () => resolve(null) }),
    ])
    if (!registration || current !== revision) return
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      const { publicKey } = await api.pushConfig()
      if (current !== revision) return
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) })
    }
    if (current === revision) await api.subscribe(subscriptionData(subscription))
  })()
  syncing = task
  try { await task }
  finally { if (syncing === task) { syncing = null; cancelActivation = null } }
}

export async function subscribeDevice(): Promise<void> {
  const state = pushState()
  if (state === 'unsupported') throw new Error('This browser does not support reminders.')
  if (state === 'not-installed') throw new Error('Add to Home Screen to get reminders')
  const permission = state === 'default' ? await Notification.requestPermission() : state
  if (permission !== 'granted') throw new Error('Allow notifications in Settings to get reminders.')
  await syncSubscription()
}

export async function resyncDevice(): Promise<void> {
  if (pushState() === 'granted') await syncSubscription()
}

export async function unsubscribeDevice(): Promise<void> {
  revision++
  cancelActivation?.()
  await syncing?.catch(() => undefined)
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager?.getSubscription()
  if (!subscription) return
  await api.removeSubscription(subscription.endpoint)
  if (!await subscription.unsubscribe()) throw new Error('Could not turn off reminders on this device. Try again.')
}
