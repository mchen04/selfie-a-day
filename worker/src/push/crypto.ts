import type { PushEnv, PushPayload, Subscription } from './types'

const encoder = new TextEncoder()

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid base64url')
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
  if (encodeBase64Url(bytes) !== value) throw new Error('Invalid base64url')
  return bytes
}

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

async function derive(secret: ArrayBuffer, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length)
}

export async function encryptPayload(payload: PushPayload, receiver: CryptoKey, receiverBytes: Uint8Array<ArrayBuffer>, auth: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const senderBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, pair.privateKey, 256)
  const keyInfo = join(encoder.encode('WebPush: info\0'), receiverBytes, senderBytes)
  const ikm = await derive(shared, auth, keyInfo, 256)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const [cek, nonce] = await Promise.all([
    derive(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 128),
    derive(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 96),
  ])
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const plaintext = join(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]))
  if (plaintext.length + 16 > 4096) throw new Error('Push payload too large')
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext))
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = senderBytes.length
  return join(header, senderBytes, ciphertext)
}

export async function createPushSender(env: PushEnv, now: number) {
  const point = decodeBase64Url(env.VAPID_PUBLIC_KEY)
  const scalar = decodeBase64Url(env.VAPID_PRIVATE_KEY ?? '')
  if (point.length !== 65 || point[0] !== 4 || scalar.length !== 32) throw new Error('Invalid VAPID keys')
  const signingKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: encodeBase64Url(point.slice(1, 33)),
    y: encodeBase64Url(point.slice(33)), d: encodeBase64Url(scalar),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const tokens = new Map<string, Promise<string>>()
  const receivers = new Map<string, Promise<CryptoKey>>()
  const topics = new Map<string, Promise<string>>()
  return async (subscription: Subscription, payload: PushPayload): Promise<Response> => {
    const origin = new URL(subscription.endpoint).origin
    let token = tokens.get(origin)
    if (!token) {
      token = (async () => {
        const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
        const claims = encodeBase64Url(encoder.encode(JSON.stringify({ aud: origin, exp: Math.floor(now / 1000) + 43200, sub: env.VAPID_SUBJECT })))
        const unsigned = `${header}.${claims}`
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(unsigned))
        return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`
      })()
      tokens.set(origin, token)
    }
    const receiverBytes = decodeBase64Url(subscription.p256dh)
    let receiver = receivers.get(subscription.p256dh)
    if (!receiver) {
      receiver = crypto.subtle.importKey('raw', receiverBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      receivers.set(subscription.p256dh, receiver)
    }
    const body = await encryptPayload(payload, await receiver, receiverBytes, decodeBase64Url(subscription.auth))
    let topic = topics.get(payload.albumId)
    if (!topic) {
      topic = crypto.subtle.digest('SHA-256', encoder.encode(payload.albumId))
        .then(digest => encodeBase64Url(new Uint8Array(digest)).slice(0, 32))
      topics.set(payload.albumId, topic)
    }
    return fetch(subscription.endpoint, {
      method: 'POST', redirect: 'manual', body,
      headers: {
        Authorization: `vapid t=${await token}, k=${env.VAPID_PUBLIC_KEY}`,
        TTL: '14400', Urgency: 'normal', Topic: await topic,
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      },
    })
  }
}
