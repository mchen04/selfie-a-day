import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { readFile } from 'node:fs/promises'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { vi } from 'vitest'
import type { PushEnv } from '../../src/push'
import { SqliteDatabase } from './sqlite'

export interface Received {
  headers: IncomingHttpHeaders
  bytes: Buffer
  payload: unknown
}

export async function makeKeys() {
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const point = Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey))
  const publicPoint = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', vapid.privateKey)
  const receiverJwk = await crypto.subtle.exportKey('jwk', receiver.privateKey)
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
  if (!privateJwk.d) throw new Error('Missing generated private key')
  return { point, auth, receiverJwk, publicPoint, privateScalar: privateJwk.d }
}

export function decrypt(bytes: Buffer, keys: Awaited<ReturnType<typeof makeKeys>>): unknown {
  if (bytes.readUInt32BE(16) !== 4096 || bytes[20] !== 65) throw new Error('Invalid content header')
  const sender = bytes.subarray(21, 86)
  const publicKey = createPublicKey({ key: {
    kty: 'EC', crv: 'P-256', x: sender.subarray(1, 33).toString('base64url'), y: sender.subarray(33).toString('base64url'),
  }, format: 'jwk' })
  const privateKey = createPrivateKey({ key: { ...keys.receiverJwk }, format: 'jwk' })
  const shared = diffieHellman({ privateKey, publicKey })
  const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), keys.point, sender]), 32))
  const salt = bytes.subarray(0, 16)
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
  decipher.setAuthTag(bytes.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(86, -16)), decipher.final()])
  if (plaintext.at(-1) !== 2) throw new Error('Missing final-record delimiter')
  return JSON.parse(plaintext.subarray(0, -1).toString()) as unknown
}

export function verifyVapid(authorization: string, keys: Awaited<ReturnType<typeof makeKeys>>) {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization)
  if (!match?.[1] || match[2] !== keys.publicPoint.toString('base64url')) throw new Error('Invalid VAPID authorization')
  const [header, claims, signature] = match[1].split('.')
  if (!header || !claims || !signature) throw new Error('Invalid JWT')
  const key = createPublicKey({ key: {
    kty: 'EC', crv: 'P-256', x: keys.publicPoint.subarray(1, 33).toString('base64url'), y: keys.publicPoint.subarray(33).toString('base64url'),
  }, format: 'jwk' })
  return {
    valid: verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as unknown,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as unknown,
    signatureLength: Buffer.from(signature, 'base64url').length,
  }
}

export async function createFixture() {
  const keys = await makeKeys()
  const received: Received[] = []
  const socketFree = process.env.SELFIE_PUSH_TEST_MODE === 'sqlite'
  const status = (path: string) => path.startsWith('/gone') ? 410 : path.startsWith('/missing') ? 404 : path.startsWith('/fail') ? 503 : 201
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks)
        received.push({ headers: request.headers, bytes, payload: decrypt(bytes, keys) })
        response.writeHead(status(request.url ?? ''))
        response.end()
      } catch {
        response.writeHead(400)
        response.end()
      }
    })
  })
  if (!socketFree) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  }
  const address = server.address()
  if (!socketFree && (!address || typeof address === 'string')) throw new Error('Missing test listener')
  const endpoint = `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 8788}`
  if (socketFree) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const bytes = Buffer.from(await request.arrayBuffer())
      received.push({ headers: Object.fromEntries(request.headers), bytes, payload: decrypt(bytes, keys) })
      return new Response(null, { status: status(new URL(request.url).pathname) })
    })
  }
  const miniflare = socketFree ? undefined : new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['DB'],
  }))
  const sqlite = socketFree ? new SqliteDatabase() : undefined
  const db = sqlite ?? await miniflare?.getD1Database('DB')
  if (!db) throw new Error('Missing test database')
  await db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE albums (user_id TEXT, id TEXT, name TEXT, time_zone TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(user_id, id));
    CREATE TABLE photos (user_id TEXT, id TEXT, album_id TEXT, day_key TEXT, captured_at INTEGER, time_zone TEXT, tz_offset_minutes INTEGER, width INTEGER, height INTEGER, mime TEXT, mirrored INTEGER, source TEXT, timer_seconds INTEGER NOT NULL DEFAULT 0, master_bytes INTEGER, thumb_bytes INTEGER, deleted_at INTEGER, purged_at INTEGER, updated_at INTEGER, PRIMARY KEY(user_id, id));
  `)
  const migration = await readFile(new URL('../../migrations/0002_push.sql', import.meta.url), 'utf8')
  for (const sql of migration.split(';').filter(value => value.trim())) await db.prepare(sql).run()
  const env: PushEnv = {
    DB: db, PUSH_ALLOW_INSECURE_ENDPOINTS: 'true', VAPID_PUBLIC_KEY: keys.publicPoint.toString('base64url'),
    VAPID_PRIVATE_KEY: keys.privateScalar, VAPID_SUBJECT: 'https://selfie-a-day.example',
  }
  const subscriptionBody = (path = '/push', timeZone = 'UTC') => ({
    endpoint: `${endpoint}${path}`,
    keys: { p256dh: keys.point.toString('base64url'), auth: keys.auth.toString('base64url') }, timeZone,
  })
  return {
    keys, received, endpoint, env, subscriptionBody,
    async reset() {
      received.length = 0
      env.PUSH_ALLOW_INSECURE_ENDPOINTS = 'true'
      await db.batch(['notification_log', 'push_prefs', 'push_subscriptions', 'photos', 'albums', 'users'].map(table => db.prepare(`DELETE FROM ${table}`)))
      await db.batch([
        db.prepare("INSERT INTO users VALUES ('alice', 'alice', 'synthetic', 0), ('bob', 'bob', 'synthetic', 0)"),
        db.prepare("INSERT INTO albums VALUES ('alice', 'selfies', 'Selfies', NULL, 0, 0, NULL), ('bob', 'selfies', 'Bob photos', NULL, 0, 0, NULL), ('bob', 'album-bbbbbbbbbbbbbbbbbbbb', 'Private', NULL, 0, 0, NULL)"),
      ])
    },
    async close() {
      await miniflare?.dispose()
      sqlite?.close()
      vi.unstubAllGlobals()
      if (!socketFree) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    },
  }
}
