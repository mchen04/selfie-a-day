import { chromium, devices, expect, webkit, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { waitForCameraLive, waitForOfflineReady } from '../e2e-support/helpers.ts'
import { ORIGIN, STATE_DIR, ZONE, pushDeviceKeys, pushEndpoint, vapidKeys, type SimAccount } from './config.ts'

export type DeviceName = 'phone' | 'desktop' | 'outsider'

export interface RequestRecord {
  seq: number
  context: DeviceName
  step: string
  at: string
  /** Simulated epoch ms when the request started. */
  ms: number
  method: string
  path: string
  resourceType: string
  status: number | null
  requestBodyBytes: number | null
  requestHeaderBytes: number | null
  responseBodyBytes: number | null
  responseHeaderBytes: number | null
  fromServiceWorker: boolean
  serviceWorkerInitiated: boolean
  offline: boolean
  failure: string | null
}

export interface ConsoleRecord { context: DeviceName; step: string; type: string; text: string; network: boolean }

/** What a device reports back to the day that is running it. */
export interface Journal {
  label(): { step: string; at: string }
  simNow(): number
  nextSeq(): number
  request(record: RequestRecord): void
  console(record: ConsoleRecord): void
  track(work: Promise<unknown>): void
}

export interface Observed { screens: string[]; countdown: number[]; flashes: number; captureAt: number; meAt: number; events: Array<{ type: string; at: number; onLine: boolean; hidden: boolean }> }

export interface LocalPhoto { id: string; albumId: string; dayKey: string; timerSeconds: number; deletedAt: number | null; capturedAt: number }
export interface LocalState {
  user: { id: string; username: string } | null
  albums: Array<{ id: string; name: string }>
  photos: LocalPhoto[]
  cursor: string
  activeAlbumId: string | null
  outbox: Array<LocalPhoto & { attempts: number; error: string | null }>
  ghosts: Array<{ albumId: string; imageId: string; bytes: number }>
}

export interface PushDeviceState { permission: NotificationPermission; subscribed: boolean }

const fixture = resolve('tests/fixtures/alignment-target.y4m')
const fakeCamera = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${fixture}`,
  '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']
export const profileDir = (name: DeviceName) => join(STATE_DIR, 'profiles', name)

/** The phone's push permission and subscription, kept like a browser keeps them: across launches. */
export class PushDevice {
  private readonly file: string
  constructor(name: DeviceName) { this.file = join(STATE_DIR, `push-${name}.json`) }
  read(): PushDeviceState {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as PushDeviceState : { permission: 'default', subscribed: false }
  }
  update(patch: Partial<PushDeviceState> = {}): PushDeviceState {
    const next = { ...this.read(), ...patch }
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(this.file, JSON.stringify(next))
    return next
  }
}

/** Runs in every page before the app: records which screens paint, countdown ticks and flashes. */
function observe() {
  const sim = { screens: [] as string[], countdown: [] as number[], flashes: 0, captureAt: -1, meAt: -1, events: [] as Array<{ type: string; at: number; onLine: boolean; hidden: boolean }> }
  Object.defineProperty(window, '__sim', { value: sim })
  const event = (type: string) => sim.events.push({ type, at: Date.now(), onLine: navigator.onLine, hidden: document.hidden })
  for (const type of ['online', 'offline']) window.addEventListener(type, () => event(type))
  document.addEventListener('visibilitychange', () => event('visibilitychange'))
  const screens = ['boot', 'account-screen', 'capture-screen', 'timeline-screen', 'photo-screen', 'settings-screen', 'trash-screen', 'playback']
  let flash = false
  let count: number | null = null
  const scan = () => {
    const screen = screens.find((id) => document.querySelector(`[data-testid="${id}"]`))
    if (screen && sim.screens.at(-1) !== screen) {
      sim.screens.push(screen)
      if (screen === 'capture-screen' && sim.captureAt < 0) sim.captureAt = performance.now()
    }
    const seconds = document.querySelector('[data-testid="countdown"]')?.getAttribute('data-seconds')
    const value = seconds ? Number(seconds) : null
    if (value !== count) {
      count = value
      if (value !== null) sim.countdown.push(value)
    }
    const on = document.querySelector('[data-testid="screen-flash"]') !== null
    if (on && !flash) sim.flashes++
    flash = on
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-seconds'] })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (sim.meAt < 0 && new URL(entry.name).pathname === '/api/auth/me') sim.meAt = (entry as PerformanceResourceTiming).responseEnd
    }
  }).observe({ type: 'resource', buffered: true })
}

/**
 * Stand-ins for an installed iPhone PWA's Notification and PushManager. The
 * subscription carries real P-256/auth keys, so the Worker encrypts to it; the
 * permission and "subscribed" state live in the test runner, as a browser keeps
 * them outside the page.
 */
function stubPush(config: { endpoint: string; p256dh: string; auth: string; publicKey: string; permission: NotificationPermission }) {
  type SimWindow = { __simPermission: NotificationPermission; __simPushState: (patch?: Partial<{ permission: NotificationPermission; subscribed: boolean }>) => Promise<{ subscribed: boolean }> }
  const win = window as unknown as SimWindow
  win.__simPermission = config.permission
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
  Object.defineProperty(Notification, 'permission', { get: () => win.__simPermission, configurable: true })
  Object.defineProperty(Notification, 'requestPermission', {
    configurable: true,
    value: async () => {
      if (win.__simPermission === 'default') win.__simPermission = 'granted'
      await win.__simPushState({ permission: win.__simPermission })
      return win.__simPermission
    },
  })
  const subscription = {
    endpoint: config.endpoint, expirationTime: null, options: { userVisibleOnly: true },
    toJSON: () => ({ endpoint: config.endpoint, expirationTime: null, keys: { p256dh: config.p256dh, auth: config.auth } }),
    unsubscribe: async () => { await win.__simPushState({ subscribed: false }); return true },
  }
  Object.defineProperty(PushManager.prototype, 'getSubscription', {
    configurable: true, value: async () => (await win.__simPushState()).subscribed ? subscription : null,
  })
  Object.defineProperty(PushManager.prototype, 'permissionState', {
    configurable: true, value: () => Promise.resolve(win.__simPermission === 'default' ? 'prompt' : win.__simPermission),
  })
  Object.defineProperty(PushManager.prototype, 'subscribe', {
    configurable: true,
    value: async (options: PushSubscriptionOptionsInit) => {
      if (win.__simPermission !== 'granted') throw new DOMException('Notifications are not allowed', 'NotAllowedError')
      const key = new Uint8Array(options.applicationServerKey as ArrayBuffer)
      const encoded = btoa(String.fromCharCode(...key)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      if (!options.userVisibleOnly || encoded !== config.publicKey) throw new DOMException('Unexpected subscription options', 'InvalidAccessError')
      await win.__simPushState({ subscribed: true })
      return subscription
    },
  })
}

/** The iOS share sheet: keeps the file it is handed so the test can read it in memory. */
function stubShare() {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data?: ShareData) => !!data?.files?.length })
  Object.defineProperty(navigator, 'share', {
    configurable: true, value: (data: ShareData) => { (window as unknown as { __simShared: File | null }).__simShared = data.files?.[0] ?? null; return Promise.resolve() },
  })
}

/** Desktop browsers take the download path. */
function noShare() {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false })
}

const SIGNED_IN = ['capture-screen', 'timeline-screen', 'photo-screen', 'settings-screen', 'trash-screen'].map((id) => `[data-testid="${id}"]`).join(', ')

export class Device {
  offline = false
  taps = 0
  readonly views: Array<{ screen: string; scrollWidth: number; width: number }> = []
  private shots = 0

  private constructor(
    readonly name: DeviceName,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly touch: boolean,
    readonly engine: 'chromium' | 'webkit',
    private readonly evidenceDir: string,
    private readonly browser: Browser | null,
  ) {}

  /** Justin's phone: an iPhone-size Chromium profile on disk, reopened every morning. */
  static async phone(journal: Journal, evidenceDir: string, startAt: number, push: PushDevice): Promise<Device> {
    const iphone = devices['iPhone 14']
    const context = await chromium.launchPersistentContext(profileDir('phone'), {
      headless: true, args: fakeCamera, baseURL: ORIGIN, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: iphone.userAgent, timezoneId: ZONE, locale: 'en-US',
      permissions: ['camera'], acceptDownloads: true,
    })
    const keys = pushDeviceKeys('phone')
    await context.exposeFunction('__simPushState', (patch?: Partial<PushDeviceState>) => push.update(patch))
    await context.addInitScript(stubPush, {
      endpoint: pushEndpoint('phone'), p256dh: keys.pair.getPublicKey().toString('base64url'), auth: keys.auth.toString('base64url'),
      publicKey: vapidKeys().publicKey, permission: push.read().permission,
    })
    await context.addInitScript(stubShare)
    return Device.ready('phone', context, null, true, 'chromium', journal, evidenceDir, startAt)
  }

  /** The second device: a desktop Chromium profile with a camera, signed in through the form each day. */
  static async desktop(journal: Journal, evidenceDir: string, startAt: number): Promise<Device> {
    const context = await chromium.launchPersistentContext(profileDir('desktop'), {
      headless: true, args: fakeCamera, baseURL: ORIGIN, viewport: { width: 1280, height: 900 }, timezoneId: ZONE, locale: 'en-US',
      permissions: ['camera'], acceptDownloads: true,
    })
    await context.addInitScript(noShare)
    return Device.ready('desktop', context, null, false, 'chromium', journal, evidenceDir, startAt)
  }

  /** An unrelated person's iPhone: a fresh WebKit context (simulated Safari, not iOS Safari). */
  static async outsider(journal: Journal, evidenceDir: string, startAt: number): Promise<Device> {
    const browser = await webkit.launch({ headless: true })
    const context = await browser.newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, baseURL: ORIGIN, timezoneId: ZONE, locale: 'en-US' })
    return Device.ready('outsider', context, browser, true, 'webkit', journal, evidenceDir, startAt)
  }

  private static async ready(name: DeviceName, context: BrowserContext, browser: Browser | null, touch: boolean, engine: 'chromium' | 'webkit',
    journal: Journal, evidenceDir: string, startAt: number): Promise<Device> {
    await context.clock.install({ time: startAt })
    await context.addInitScript(observe)
    const page = context.pages()[0] ?? await context.newPage()
    const device = new Device(name, context, page, touch, engine, evidenceDir, browser)
    device.record(journal)
    return device
  }

  private record(journal: Journal) {
    const started = new Map<Request, { seq: number; step: string; at: string; ms: number; offline: boolean }>()
    const keep = (request: Request) => /^https?:/.test(request.url())
    this.context.on('request', (request) => {
      if (keep(request)) started.set(request, { seq: journal.nextSeq(), ...journal.label(), ms: journal.simNow(), offline: this.offline })
    })
    const finish = async (request: Request, failure: string | null) => {
      const start = started.get(request)
      if (!start) return
      started.delete(request)
      // A failed request can still have had its response headers (Chromium reports 204 fetches as ERR_ABORTED).
      // Both reads are bounded: a record never waits on Playwright for more than 5 s.
      const bounded = <T>(work: Promise<T>) => Promise.race([work.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))])
      const response = await bounded(request.response())
      const sizes = failure ? null : await bounded(request.sizes())
      const url = new URL(request.url())
      journal.request({
        seq: start.seq, context: this.name, step: start.step, at: start.at, ms: start.ms, method: request.method(),
        path: url.origin === ORIGIN ? url.pathname + url.search : url.href, resourceType: request.resourceType(),
        status: response?.status() ?? null,
        requestBodyBytes: sizes?.requestBodySize ?? null, requestHeaderBytes: sizes?.requestHeadersSize ?? null,
        responseBodyBytes: sizes?.responseBodySize ?? null, responseHeaderBytes: sizes?.responseHeadersSize ?? null,
        fromServiceWorker: response?.fromServiceWorker() ?? false, serviceWorkerInitiated: this.engine === 'chromium' && request.serviceWorker() !== null,
        offline: start.offline, failure,
      })
    }
    this.context.on('requestfinished', (request) => journal.track(finish(request, null)))
    this.context.on('requestfailed', (request) => journal.track(finish(request, request.failure()?.errorText ?? 'failed')))
    this.context.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return
      const text = message.text()
      journal.console({ context: this.name, ...journal.label(), type: message.type(), text, network: /^Failed to load resource/.test(text) })
    })
    this.context.on('weberror', (error) => journal.console({ context: this.name, ...journal.label(), type: 'pageerror', text: error.error().message, network: false }))
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
  }

  // --- Clock and network -------------------------------------------------

  now(): Promise<number> { return this.page.evaluate(() => Date.now()) }

  /** Move the simulated clock forward (never back) to `instant`. */
  async advanceTo(instant: number): Promise<void> {
    if (this.page.url().startsWith('http') && await this.now() >= instant) return
    await this.context.clock.setSystemTime(instant)
  }

  async setOffline(offline: boolean): Promise<void> {
    this.offline = offline
    await this.context.setOffline(offline)
  }

  waitOfflineReady(): Promise<void> { return waitForOfflineReady(this.page) }

  // --- Interaction --------------------------------------------------------

  testId(id: string): Locator { return this.page.getByTestId(id) }

  async press(target: Locator): Promise<void> {
    if (this.touch) await target.tap()
    else await target.click()
    this.taps++
  }

  /**
   * Hold /api/auth/me at the network layer (CDP Fetch, which leaves the HTTP
   * cache alone, unlike page.route) until `release`, to see what the app paints
   * while its session check is still out.
   */
  async holdSessionCheck(): Promise<{ held: () => boolean; release: () => Promise<void> }> {
    const cdp = await this.context.newCDPSession(this.page)
    const paused: string[] = []
    let releasing = false
    cdp.on('Fetch.requestPaused', (event: { requestId: string }) => {
      if (releasing) void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined)
      else paused.push(event.requestId)
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/auth/me*', requestStage: 'Request' }] })
    return {
      held: () => paused.length > 0,
      release: async () => {
        releasing = true
        for (const requestId of paused) await cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined)
        await cdp.send('Fetch.disable').catch(() => undefined)
        await cdp.detach().catch(() => undefined)
      },
    }
  }

  async open(path = '/') {
    const response = await this.page.goto(path)
    await expect(this.page.locator('[data-testid="account-screen"], [data-testid="capture-screen"], [data-testid="timeline-screen"], [data-testid="boot-error"]').first())
      .toBeVisible({ timeout: 30_000 })
    return response
  }

  async observed(): Promise<Observed> {
    return this.page.evaluate(() => (window as unknown as { __sim: Observed }).__sim)
  }

  async resetObserved(): Promise<void> {
    await this.page.evaluate(() => {
      const sim = (window as unknown as { __sim: { countdown: number[]; flashes: number } }).__sim
      sim.countdown = []
      sim.flashes = 0
    })
  }

  async signUp(account: SimAccount): Promise<number> {
    const before = this.taps
    await expect(this.testId('account-submit')).toHaveText('Create account')
    await this.press(this.page.getByLabel('Username', { exact: true }))
    await this.page.getByLabel('Username', { exact: true }).fill(account.username)
    await this.press(this.page.getByLabel('Password', { exact: true }))
    await this.page.getByLabel('Password', { exact: true }).fill(account.password)
    await this.press(this.testId('account-submit'))
    await expect(this.testId('capture-screen')).toBeVisible({ timeout: 20_000 })
    return this.taps - before
  }

  async signIn(account: SimAccount): Promise<number> {
    const before = this.taps
    await expect(this.testId('account-screen')).toBeVisible()
    if (await this.testId('account-submit').textContent() !== 'Sign in') await this.press(this.page.getByRole('button', { name: 'Have an account? Sign in' }))
    await expect(this.testId('account-submit')).toHaveText('Sign in')
    await this.press(this.page.getByLabel('Username', { exact: true }))
    await this.page.getByLabel('Username', { exact: true }).fill(account.username)
    await this.press(this.page.getByLabel('Password', { exact: true }))
    await this.page.getByLabel('Password', { exact: true }).fill(account.password)
    await this.press(this.testId('account-submit'))
    await expect(this.page.locator(SIGNED_IN).first()).toBeVisible({ timeout: 20_000 })
    return this.taps - before
  }

  /** The screen the app shows right now (the first signed-in or account screen found). */
  async screen(): Promise<string | null> {
    return this.page.locator(`${SIGNED_IN}, [data-testid="account-screen"]`).first().getAttribute('data-testid').catch(() => null)
  }

  async live(): Promise<void> { await waitForCameraLive(this.page) }

  async setTimer(seconds: 0 | 3 | 5 | 10): Promise<void> {
    const timer = this.testId('camera-timer')
    await expect(timer).toBeEnabled()
    for (let taps = 0; taps < 4 && Number(await timer.getAttribute('data-seconds')) !== seconds; taps++) await this.press(timer)
    await expect(timer).toHaveAttribute('data-seconds', String(seconds))
  }

  async setFlash(on: boolean): Promise<void> {
    const flash = this.testId('camera-flash')
    await expect(flash).toBeEnabled()
    if ((await flash.getAttribute('data-flash') === 'on') !== on) await this.press(flash)
    await expect(flash).toHaveAttribute('data-flash', on ? 'on' : 'off')
  }

  async selectAlbum(albumId: string): Promise<void> {
    await this.press(this.testId('active-album-picker'))
    await this.press(this.page.locator(`[data-testid="album-option"][data-album-id="${albumId}"]`))
    await expect(this.testId('album-picker')).toHaveCount(0)
    await expect.poll(async () => (await this.local()).activeAlbumId).toBe(albumId)
  }

  async createAlbum(name: string): Promise<string> {
    const before = new Set((await this.local()).albums.map((album) => album.id))
    await this.press(this.testId('active-album-picker'))
    await this.press(this.testId('new-album'))
    await this.testId('new-album-name').fill(name)
    await this.press(this.page.getByRole('button', { name: 'Create', exact: true }))
    await expect(this.testId('album-picker')).toHaveCount(0)
    let created = ''
    await expect.poll(async () => {
      const state = await this.local()
      created = state.albums.find((album) => !before.has(album.id) && album.name === name)?.id ?? ''
      return created && state.activeAlbumId === created
    }).toBe(true)
    return created
  }

  /** Settings → (switch album) → Name → Save album, then back to the camera. */
  async renameAlbum(albumId: string, name: string): Promise<void> {
    await this.press(this.testId('nav-settings'))
    if ((await this.local()).activeAlbumId !== albumId) {
      await this.press(this.testId('settings-album-picker'))
      await this.press(this.page.locator(`[data-testid="album-option"][data-album-id="${albumId}"]`))
      await expect(this.testId('album-picker')).toHaveCount(0)
    }
    await this.testId('album-name').fill(name)
    await this.press(this.testId('save-album'))
    await expect(this.page.getByText('Album saved.')).toBeVisible()
    await this.press(this.testId('settings-back'))
    await expect(this.testId('capture-screen')).toBeVisible()
  }

  async sync(): Promise<void> {
    const synced = this.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sync', { timeout: 20_000 })
    await this.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await synced
  }

  async screenshot(name: string): Promise<string> {
    const file = `${this.name}-${String(++this.shots).padStart(2, '0')}-${name}.png`
    await this.page.screenshot({ path: join(this.evidenceDir, file), scale: 'css', animations: 'disabled', caret: 'hide' })
    const width = await this.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }))
    this.views.push({ screen: name, ...width })
    return file
  }

  async cookies(): Promise<string[]> {
    return (await this.context.cookies(ORIGIN)).filter((cookie) => cookie.value).map((cookie) => cookie.name).sort()
  }

  // --- Local state (IndexedDB, never pixels) -------------------------------

  async local(): Promise<LocalState> {
    return this.page.evaluate(async () => {
      const empty = { user: null, albums: [], photos: [], cursor: '', activeAlbumId: null, outbox: [], ghosts: [] }
      if (!(await indexedDB.databases()).some((db) => db.name === 'selfie-a-day')) return empty
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('selfie-a-day')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Could not open storage'))
      })
      if (!db.objectStoreNames.contains('kv')) { db.close(); return empty }
      const read = <T>(store: string, key?: IDBValidKey) => new Promise<T>((resolve, reject) => {
        const request = key === undefined ? db.transaction(store).objectStore(store).getAll() : db.transaction(store).objectStore(store).get(key)
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error ?? new Error('Could not read storage'))
      })
      type Meta = { id: string; albumId: string; dayKey: string; timerSeconds: number; deletedAt: number | null; capturedAt: number }
      const pick = (photo: Meta) => ({ id: photo.id, albumId: photo.albumId, dayKey: photo.dayKey, timerSeconds: photo.timerSeconds, deletedAt: photo.deletedAt ?? null, capturedAt: photo.capturedAt })
      try {
        const user = await read<{ id: string; username: string } | undefined>('kv', 'user') ?? null
        const snapshot = user ? await read<{ albums: Array<{ id: string; name: string }>; photos: Meta[]; cursor: string } | undefined>('kv', `user:${user.id}:snapshot`) : undefined
        const settings = user ? await read<{ activeAlbumId?: string } | undefined>('kv', `user:${user.id}:settings`) : undefined
        const outbox = await read<Array<{ userId: string; meta: Meta; attempts: number; error: string | null }>>('outbox')
        const ghosts = await read<Array<{ userId: string; albumId: string; image: { id: string; bytes: ArrayBuffer } }>>('ghosts')
        return {
          user: user ? { id: user.id, username: user.username } : null,
          albums: (snapshot?.albums ?? []).map((album) => ({ id: album.id, name: album.name })),
          photos: (snapshot?.photos ?? []).map(pick),
          cursor: snapshot?.cursor ?? '',
          activeAlbumId: settings?.activeAlbumId ?? (user ? 'selfies' : null),
          outbox: outbox.map((entry) => ({ ...pick(entry.meta), attempts: entry.attempts, error: entry.error })),
          ghosts: ghosts.map((ghost) => ({ albumId: ghost.albumId, imageId: ghost.image.id, bytes: ghost.image.bytes.byteLength })),
        }
      } finally { db.close() }
    })
  }

  /** Store counts and byte estimates, storage keys and Cache Storage paths. Never values or pixels. */
  async storage(): Promise<unknown> {
    if (!this.page.url().startsWith(ORIGIN)) return null
    return this.page.evaluate(async () => {
      const size = (value: unknown): number => {
        if (value instanceof ArrayBuffer) return value.byteLength
        if (ArrayBuffer.isView(value)) return value.byteLength
        if (value instanceof Blob) return value.size
        if (typeof value === 'string') return value.length
        if (Array.isArray(value)) return value.reduce((total: number, item) => total + size(item), 0)
        if (value && typeof value === 'object') return Object.entries(value).reduce((total, [key, item]) => total + key.length + size(item), 0)
        return 8
      }
      const indexed: Record<string, { count: number; bytes: number; keys?: string[] }> = {}
      if ((await indexedDB.databases()).some((db) => db.name === 'selfie-a-day')) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('selfie-a-day')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error ?? new Error('Could not open storage'))
        })
        try {
          for (const name of Array.from(db.objectStoreNames)) {
            const [values, keys] = await Promise.all(['getAll', 'getAllKeys'].map((method) => new Promise<unknown[]>((resolve, reject) => {
              const store = db.transaction(name).objectStore(name)
              const request = method === 'getAll' ? store.getAll() : store.getAllKeys()
              request.onsuccess = () => resolve(request.result as unknown[])
              request.onerror = () => reject(request.error ?? new Error('Could not read storage'))
            }))) as [unknown[], IDBValidKey[]]
            indexed[name] = { count: values.length, bytes: size(values), ...(name === 'kv' ? { keys: keys.map(String) } : {}) }
          }
        } finally { db.close() }
      }
      const caches_ = await Promise.all((await caches.keys()).map(async (name) => {
        const paths = (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)
        return { name, entries: paths.length, apiEntries: paths.filter((path) => path.startsWith('/api/')).length, paths }
      }))
      const estimate = await navigator.storage?.estimate?.().catch(() => null)
      const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
      return {
        indexedDB: indexed,
        localStorage: Object.keys(localStorage).sort().map((key) => ({ key, bytes: (localStorage.getItem(key) ?? '').length })),
        cacheStorage: caches_,
        estimate: estimate ? { usage: estimate.usage ?? null, quota: estimate.quota ?? null } : null,
        serviceWorker: registration?.active?.state ?? null,
      }
    })
  }
}
