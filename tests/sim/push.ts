import { createDecipheriv, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { API_ORIGIN, PUSH_PORT, pushDeviceKeys, vapidKeys } from './config.ts'
import { simStamp } from './calendar.ts'

export interface PushPayload { title: string; body: string; albumId: string; tag: string; url: string }
export type PushEvent = 'reminder' | 'milestone' | 'nudge' | 'unknown'

export interface PushMessage {
  device: string
  cron: string
  receivedAt: string
  dayKey: string
  event: PushEvent
  payload: PushPayload
  headers: { contentEncoding: string; ttl: string; urgency: string; topic: string }
  vapid: { signatureValid: boolean; serverKey: boolean; audience: string; expiresHoursAfterCron: number; subject: string }
  bytes: number
}

export interface CronRun { at: string; scheduledTime: number; status: number; delivered: number }

export const pushEvent = (body: string): PushEvent =>
  body === "Time for today's photo." ? 'reminder' : body === "Still time for today's photo." ? 'nudge' : /^Day \d+ today — keep it going\.$/.test(body) ? 'milestone' : 'unknown'

function decrypt(bytes: Buffer, device: string): PushPayload {
  const { pair, auth } = pushDeviceKeys(device)
  if (bytes.readUInt32BE(16) !== 4096 || bytes[20] !== 65) throw new Error('Unexpected aes128gcm header')
  const sender = bytes.subarray(21, 86)
  const shared = pair.computeSecret(sender)
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), pair.getPublicKey(), sender]), 32))
  const salt = bytes.subarray(0, 16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(bytes.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(86, -16)), decipher.final()])
  if (plaintext.at(-1) !== 2) throw new Error('Missing final-record padding delimiter')
  return JSON.parse(plaintext.subarray(0, -1).toString()) as PushPayload
}

function checkVapid(header: string | undefined, scheduledTime: number) {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+),\s*k=([\w-]+)$/.exec(header ?? '')
  if (!match) throw new Error('Missing VAPID authorization')
  const [, token, key] = match as unknown as [string, string, string]
  const [head, claims, signature] = token.split('.') as [string, string, string]
  const point = Buffer.from(key, 'base64url')
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } })
  const signatureValid = verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { aud: string; exp: number; sub: string }
  return {
    signatureValid, serverKey: key === vapidKeys().publicKey, audience: decoded.aud,
    expiresHoursAfterCron: Math.round((decoded.exp * 1000 - scheduledTime) / 360_000) / 10, subject: decoded.sub,
  }
}

const body = (request: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
})

/**
 * Stands in for Apple's push service: a local endpoint the Worker delivers to
 * with real VAPID signing and RFC 8291 encryption. Each message is decrypted
 * with the subscribing device's keys and stamped with the simulated cron time
 * that produced it.
 */
export class PushReceiver {
  readonly messages: PushMessage[] = []
  readonly errors: string[] = []
  readonly crons: CronRun[] = []
  private server: Server | null = null
  private cronAt = 0
  private dayKey = ''

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const device = /^\/push\/([\w-]+)$/.exec(request.url ?? '')?.[1]
          if (!device || request.method !== 'POST') throw new Error(`Unexpected push request ${request.method} ${request.url}`)
          const bytes = await body(request)
          const payload = decrypt(bytes, device)
          this.messages.push({
            device, cron: simStamp(this.cronAt), receivedAt: simStamp(this.cronAt), dayKey: this.dayKey, event: pushEvent(payload.body), payload,
            headers: {
              contentEncoding: String(request.headers['content-encoding']), ttl: String(request.headers.ttl),
              urgency: String(request.headers.urgency), topic: String(request.headers.topic),
            },
            vapid: checkVapid(request.headers.authorization, this.cronAt), bytes: bytes.length,
          })
          response.writeHead(201).end()
        } catch (error) {
          this.errors.push(error instanceof Error ? error.message : String(error))
          response.writeHead(400).end()
        }
      })()
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(PUSH_PORT, '127.0.0.1', resolve) })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Fire the Worker's cron at a simulated instant and collect what it delivered. */
  async cron(scheduledTime: number, dayKey: string): Promise<PushMessage[]> {
    this.cronAt = scheduledTime
    this.dayKey = dayKey
    const before = this.messages.length
    const url = new URL('/cdn-cgi/handler/scheduled', API_ORIGIN)
    url.searchParams.set('cron', '*/5 * * * *')
    url.searchParams.set('time', String(scheduledTime))
    const response = await fetch(url)
    const text = await response.text()
    if (response.status !== 200 || text !== 'ok') throw new Error(`Cron run failed: ${response.status} ${text}`)
    // Deliveries finish in the scheduled handler's waitUntil; wait until they stop arriving.
    let count = -1
    let stable = 0
    for (let waited = 0; waited < 6000 && stable < 4; waited += 150) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      stable = this.messages.length === count ? stable + 1 : 0
      count = this.messages.length
    }
    const delivered = this.messages.slice(before)
    this.crons.push({ at: simStamp(scheduledTime), scheduledTime, status: response.status, delivered: delivered.length })
    return delivered
  }
}
