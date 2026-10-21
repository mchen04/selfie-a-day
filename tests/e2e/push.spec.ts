import { expect, test } from '@playwright/test'
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getPlatformProxy, unstable_splitSqlQuery, unstable_startWorker } from 'wrangler'
import { waitForCameraLive } from '../e2e-support/helpers.ts'

test.use({ timezoneId: 'UTC' })

function decrypt(bytes: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): unknown {
  expect(bytes.readUInt32BE(16)).toBe(4096)
  expect(bytes[20]).toBe(65)
  const sender = bytes.subarray(21, 86)
  const shared = receiver.computeSecret(sender)
  const ikm = hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), sender]), 32)
  const salt = bytes.subarray(0, 16)
  const cek = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
  decipher.setAuthTag(bytes.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(86, -16)), decipher.final()])
  expect(plaintext.at(-1)).toBe(2)
  return JSON.parse(plaintext.subarray(0, -1).toString()) as unknown
}

test('two taps enable one encrypted reminder; a saved photo suppresses the evening nudge', async ({ page, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Web Push subscription stubs use Chromium.')
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'selfie-push-e2e-'))
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const auth = randomBytes(16)
  const vapid = createECDH('prime256v1')
  vapid.generateKeys()
  const received: unknown[] = []
  const errors: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        expect(request.headers['content-encoding']).toBe('aes128gcm')
        expect(request.headers.authorization).toMatch(/^vapid t=/)
        received.push(decrypt(Buffer.concat(chunks), receiver, auth))
        response.writeHead(201).end()
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        response.writeHead(400).end()
      }
    })
  })
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
  let proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local push listener')
    const endpoint = `http://127.0.0.1:${address.port}/push`
    const origin = new URL(baseURL ?? 'http://localhost:4319').origin
    const configPath = join(directory, 'wrangler.json')
    const statePath = join(directory, 'state')
    await writeFile(configPath, JSON.stringify({
      name: 'selfie-push-browser-test', main: resolve('worker/src/index.ts'), compatibility_date: '2026-10-01',
      d1_databases: [{ binding: 'DB', database_name: 'push-test', database_id: randomUUID() }],
      r2_buckets: [{ binding: 'PHOTOS', bucket_name: 'push-test-photos' }],
      vars: {
        ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false', PUSH_ALLOW_INSECURE_ENDPOINTS: 'true',
        VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'), VAPID_SUBJECT: origin,
      },
    }))
    const database = await getPlatformProxy<{ DB: { prepare: (sql: string) => { run: () => Promise<unknown> } } }>({
      configPath, envFiles: [], persist: { path: join(statePath, 'v3') }, remoteBindings: false,
    })
    proxy = database
    for (const file of (await readdir('worker/migrations')).filter((file) => file.endsWith('.sql')).sort()) {
      for (const sql of unstable_splitSqlQuery(await readFile(join('worker/migrations', file), 'utf8'))) await database.env.DB.prepare(sql).run()
    }
    await database.dispose()
    proxy = undefined
    worker = await unstable_startWorker({ config: configPath, envFiles: [], dev: { remote: false, persist: statePath, watch: false, server: { hostname: '127.0.0.1', port: 0 } } })
    await worker.ready
    const localWorker = worker
    const runCron = async (time: number) => {
      const url = new URL('/cdn-cgi/local/scheduled', await localWorker.url)
      url.searchParams.set('cron', '*/5 * * * *')
      url.searchParams.set('time', String(time))
      const response = await page.request.get(url.href)
      expect(response.status()).toBe(200)
      expect(await response.text()).toBe('ok')
    }
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const body = request.postDataBuffer()
      const response = await localWorker.fetch(`http://selfie-test${url.pathname}${url.search}`, {
        method: request.method(), headers: request.headers(), ...(body ? { body: new Uint8Array(body) } : {}),
      })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    })
    await page.addInitScript(({ endpoint, p256dh, auth, publicKey }) => {
      let permission: NotificationPermission = 'default'
      Object.defineProperty(navigator, 'standalone', { value: true })
      Object.defineProperty(Notification, 'permission', { get: () => permission })
      Object.defineProperty(Notification, 'requestPermission', { value: () => {
        sessionStorage.setItem('push-permission-in-tap', String(navigator.userActivation.isActive))
        permission = 'granted'
        return Promise.resolve(permission)
      } })
      const subscription = {
        endpoint, expirationTime: null,
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: () => { sessionStorage.removeItem('push-subscribed'); return Promise.resolve(true) },
      }
      Object.defineProperty(PushManager.prototype, 'getSubscription', { value: () => Promise.resolve(sessionStorage.getItem('push-subscribed') ? subscription : null) })
      Object.defineProperty(PushManager.prototype, 'subscribe', { value: (options: PushSubscriptionOptionsInit) => {
        if (!options.userVisibleOnly || !options.applicationServerKey) throw new Error('Missing push subscription options')
        const key = options.applicationServerKey as Uint8Array
        const encoded = btoa(String.fromCharCode(...key)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
        if (encoded !== publicKey) throw new Error('Wrong VAPID key')
        sessionStorage.setItem('push-subscribed', '1')
        return Promise.resolve(subscription)
      } })
      document.addEventListener('click', () => sessionStorage.setItem('push-taps', String(Number(sessionStorage.getItem('push-taps') ?? '0') + 1)), true)
    }, { endpoint, p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url'), publicKey: vapid.getPublicKey().toString('base64url') })

    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto('/')
    await page.getByLabel('Username', { exact: true }).fill(`push-${randomUUID().replaceAll('-', '').slice(0, 20)}`)
    await page.getByLabel('Password', { exact: true }).fill(randomUUID() + randomUUID())
    const signup = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signup')
    await page.getByTestId('account-submit').click()
    expect((await signup).status()).toBe(201)
    await expect(page.getByTestId('capture-screen')).toBeVisible()
    await page.evaluate(async () => { await navigator.serviceWorker.ready; sessionStorage.setItem('push-taps', '0') })
    await page.getByTestId('nav-settings').click()
    const toggle = page.getByTestId('reminder-toggle-selfies')
    await expect(toggle).toBeEnabled()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toBeEnabled()
    expect(await page.evaluate(() => Number(sessionStorage.getItem('push-taps')))).toBe(2)
    expect(await page.evaluate(() => sessionStorage.getItem('push-permission-in-tap'))).toBe('true')
    const row = await page.getByTestId('reminder-selfies').boundingBox()
    expect(row!.height).toBeGreaterThanOrEqual(44)
    expect(row!.x).toBeGreaterThanOrEqual(0)
    expect(row!.x + row!.width).toBeLessThanOrEqual(320)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await testInfo.attach('reminders-320px', { body: await page.screenshot(), contentType: 'image/png' })

    const today = new Date().toISOString().slice(0, 10)
    const morning = Date.parse(`${today}T09:05:00Z`)
    await runCron(morning)
    await expect.poll(() => received.length).toBe(1)
    await runCron(morning + 300_000)
    expect(errors).toEqual([])
    expect(received).toEqual([{ title: 'Selfies', body: "Time for today's photo.", albumId: 'selfies', tag: 'album-selfies', url: '/?album=selfies' }])

    await page.getByTestId('settings-back').click()
    await waitForCameraLive(page)
    const upload = page.waitForResponse((response) => /\/api\/photos\/[0-9a-z]{20}$/.test(response.url()) && response.request().method() === 'PUT')
    await page.getByTestId('shutter').click()
    expect((await upload).status()).toBe(201)
    await runCron(Date.parse(`${today}T20:35:00Z`))
    await runCron(Date.parse(`${today}T21:00:00Z`))
    expect(errors).toEqual([])
    expect(received).toHaveLength(1)
    await testInfo.attach('tap-path', { body: 'Camera → Settings → Selfies reminder switch: 2 taps. One decrypted reminder; zero evening nudges after capture.', contentType: 'text/plain' })
  } finally {
    await page.unroute('**/api/**')
    await worker?.dispose()
    await proxy?.dispose()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
