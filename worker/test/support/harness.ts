import { createRequire } from 'node:module'
import type { Response as WorkerResponse } from '@cloudflare/workers-types'
import { readFile, readdir } from 'node:fs/promises'
import { createECDH, randomBytes } from 'node:crypto'
import type { Miniflare as MiniflareInstance } from 'miniflare'
import type { BuildOptions, BuildResult } from 'esbuild'
import type { Env } from '../../src/core/env'

const requireWorker = createRequire(import.meta.url)
const requireWrangler = createRequire(requireWorker.resolve('wrangler'))
const { Miniflare, convertV4MiniflareOptions } = requireWrangler('miniflare') as typeof import('miniflare')
const { build } = requireWrangler('esbuild') as { build: (options: BuildOptions) => Promise<BuildResult> }

export const ORIGIN = 'https://selfie-a-day.vercel.app'
export const TEST_NOW = 1792584000000
export const TEST_PASSWORD = randomBytes(18).toString('base64url')
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

interface RequestOptions {
  method?: string
  cookie?: string
  json?: unknown
  body?: FormData | string
  headers?: Record<string, string>
  csrf?: boolean
  now?: number
  ip?: string
}

export interface TestUser {
  id: string
  username: string
  cookie: string
}

export class Harness {
  readonly mf: MiniflareInstance
  readonly env: Env

  constructor(mf: MiniflareInstance, env: Env) {
    this.mf = mf
    this.env = env
  }

  async request(path: string, options: RequestOptions = {}): Promise<WorkerResponse> {
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { 'X-Test-Now': String(options.now ?? TEST_NOW), 'cf-connecting-ip': options.ip ?? '192.0.2.1' }
    if (options.csrf !== false && method !== 'GET' && method !== 'HEAD') {
      headers.Origin = ORIGIN
      headers['X-Selfie-CSRF'] = '1'
    }
    if (options.cookie) headers.Cookie = options.cookie
    let body: string | FormData | undefined = options.body
    if (options.json !== undefined) {
      body = JSON.stringify(options.json)
      headers['Content-Type'] = 'application/json'
    }
    Object.assign(headers, options.headers)
    const encoded = new Request(`https://api.example${path}`, { method, headers, ...(body === undefined ? {} : { body }) })
    const response = await this.mf.dispatchFetch(encoded.url, {
      method, headers: Object.fromEntries(encoded.headers),
      ...(body === undefined ? {} : { body: new Uint8Array(await encoded.arrayBuffer()) }),
    })
    return response as unknown as WorkerResponse
  }

  async user(username = `u-${randomBytes(8).toString('hex')}`): Promise<TestUser> {
    const response = await this.request('/api/auth/signup', { method: 'POST', json: { username, password: TEST_PASSWORD }, ip: randomBytes(8).toString('hex') })
    if (response.status !== 201) throw new Error(`signup failed: ${response.status} ${await response.text()}`)
    const data = await response.json<{ user: { id: string; username: string } }>()
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0]!
    const sync = await this.request('/api/sync', { cookie })
    if (sync.status !== 200) throw new Error(`sync failed: ${await sync.text()}`)
    return { ...data.user, cookie }
  }

  upload(user: TestUser, id: string, options: { meta?: Record<string, unknown>; master?: Uint8Array<ArrayBuffer>; thumb?: Uint8Array<ArrayBuffer>; masterMime?: string; thumbMime?: string; now?: number } = {}): Promise<WorkerResponse> {
    const meta = {
      albumId: 'selfies', dayKey: '2026-10-21', capturedAt: TEST_NOW,
      width: 100, height: 100, mime: 'image/jpeg', mirrored: true, timerSeconds: 3,
      ...options.meta,
    }
    const form = new FormData()
    form.set('meta', JSON.stringify(meta))
    form.set('master', new Blob([options.master ?? JPEG], { type: options.masterMime ?? 'image/jpeg' }), 'master.jpg')
    form.set('thumb', new Blob([options.thumb ?? JPEG], { type: options.thumbMime ?? 'image/jpeg' }), 'thumb.jpg')
    return this.request(`/api/photos/${id}`, { method: 'PUT', cookie: user.cookie, body: form, ...(options.now === undefined ? {} : { now: options.now }) })
  }

  async sql(sql: string, ...bindings: unknown[]): Promise<void> {
    await this.env.DB.prepare(sql).bind(...bindings).run()
  }

  dispose(): Promise<void> { return this.mf.dispose() }
}

let bundle: string | undefined

export async function createHarness(secure = true): Promise<Harness> {
  if (!bundle) {
    const result = await build({ entryPoints: ['worker/test/support/runtime.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
    bundle = result.outputFiles![0]!.text
  }
  const pair = createECDH('prime256v1')
  pair.generateKeys()
  const config = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as {
    compatibility_date: string
    vars: Record<string, string>
    d1_databases: { binding: string; database_id: string }[]
    r2_buckets: { binding: string; bucket_name: string }[]
  }
  const vars = {
    ...config.vars,
    COOKIE_SECURE: String(secure),
    VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: ORIGIN,
  }
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle, compatibilityDate: config.compatibility_date,
    d1Databases: Object.fromEntries(config.d1_databases.map((binding) => [binding.binding, binding.database_id])),
    r2Buckets: Object.fromEntries(config.r2_buckets.map((binding) => [binding.binding, binding.bucket_name])), bindings: vars,
    host: '127.0.0.1', port: 0,
  }))
  try {
    const env = await mf.getBindings<Env>()
    const directory = new URL('../../migrations/', import.meta.url)
    for (const name of (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8')
      const statements = sql.split(/(?=^(?:CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER)|PRAGMA)\b)/m).map((query) => query.trim()).filter(Boolean)
      await env.DB.batch(statements.map((query) => env.DB.prepare(query)))
    }
    return new Harness(mf, env)
  } catch (error) {
    await mf.dispose()
    throw error
  }
}

export function photoId(value: number): string { return value.toString(36).padStart(20, '0') }

export interface SyncData {
  albums: { id: string; name: string; timeZone: string | null; deletedAt: number | null }[]
  photos: { id: string; deletedAt: number | null; timerSeconds: number }[]
  removed: string[]
  cursor: string
}
