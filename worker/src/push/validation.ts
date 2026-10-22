import { decodeBase64Url } from './crypto'

export function validEndpoint(endpoint: unknown, allowInsecure: string): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) return false
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'http:') return allowInsecure === 'true' && url.hostname === '127.0.0.1' && /^http:\/\/127\.0\.0\.1:\d+(?:\/|\?|$)/i.test(endpoint)
    if (url.protocol !== 'https:') return false
    const host = url.hostname
    return host === 'web.push.apple.com' || host.endsWith('.push.apple.com') ||
      host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.notify.windows.com')
  } catch {
    return false
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function validKeys(value: unknown): Promise<boolean> {
  if (!isRecord(value) || typeof value.p256dh !== 'string' || typeof value.auth !== 'string') return false
  try {
    const point = decodeBase64Url(value.p256dh)
    if (point.length !== 65 || point[0] !== 4 || decodeBase64Url(value.auth).length !== 16) return false
    await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return true
  } catch {
    return false
  }
}
