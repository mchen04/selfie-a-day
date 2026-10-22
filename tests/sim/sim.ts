import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVIDENCE_DIR, ORIGIN, OUTSIDER, OWNER, STATE_DIR, type SimAccount } from './config.ts'
import { DAY_KEYS, at, dayLabel, simStamp } from './calendar.ts'
import { Device, PushDevice, type ConsoleRecord, type DeviceName, type Journal, type RequestRecord } from './device.ts'
import { PushReceiver, type CronRun, type PushMessage } from './push.ts'
import { notificationLog, serverStorage, userId } from './server.ts'

/** The eight things the card asks to see working every day. */
export const CARD_FEATURES = ['login', 'capture', 'ghost', 'albums', 'timelapse', 'trash', 'sync', 'offline'] as const
export type CardFeature = typeof CARD_FEATURES[number]
export type Feature = CardFeature | 'push' | 'accounts' | 'invariants'

export interface CheckResult { pass: boolean; feature: Feature; step: string; at: string; detail?: unknown; error?: string }
export interface HarnessRecord { seq: number; step: string; at: string; purpose: string; method: string; path: string; status: number; requestBodyBytes: number; responseBodyBytes: number }

/** An API error status (or a network failure) a day provokes on purpose. */
export interface Expected { context?: DeviceName; method?: string; path: RegExp; status: number | 'failed'; why: string }

export const HONESTY = {
  phone: 'simulated phone, mocked camera: Chromium with an iPhone 14 viewport, user agent and touch, and a fake front-camera video file',
  flash: 'flash = the front-camera white-screen fallback (the fake camera has no torch)',
  push: 'mocked push transport (real VAPID signing and encryption, no Apple push service); Notification/PushManager are stubs with real subscription keys',
  webkit: 'simulated Safari (Playwright WebKit, not iOS Safari)',
  clock: 'browsers and cron runs use the simulated clock; the local Worker handles requests on the host\'s real clock, so server-set deletedAt/updatedAt carry the real run time',
  share: 'the iOS share sheet is a stub that receives the ZIP file; desktop uses the browser download path',
  deterministic: 'fixed users, passwords, push and VAPID keys derived from fixed seeds; fixed simulated clock',
  network: 'offline = Chromium network emulation; it fires no `online` event in a page loaded while offline (and reports it as online), so on reconnect the harness dispatches `online` itself and each reconnect check says which one the app got',
}

export const NOT_VERIFIED = [
  'Physical iPhone camera and torch',
  'Installed-PWA push delivery through Apple\'s push service',
  'Real iOS Safari storage eviction (simulated here by clearing site storage, cookies kept)',
  'iOS Safari\'s own `online` event timing when the connection returns',
]

/** Small facts later days need (album ids, photo ids), kept on disk so a restarted test worker still has them. */
export class Memo {
  private readonly file = join(STATE_DIR, 'memo.json')
  private read(): Record<string, unknown> { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown> : {} }
  get<T>(key: string): T | undefined { return this.read()[key] as T | undefined }
  need<T>(key: string): T {
    const value = this.get<T>(key)
    if (value === undefined) throw new Error(`An earlier day did not record ${key}`)
    return value
  }
  set(key: string, value: unknown): void {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(this.file, JSON.stringify({ ...this.read(), [key]: value }, null, 2))
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 6).join('\n').slice(0, 1200)

export class Day implements Journal {
  readonly dayKey: string
  readonly dir: string
  readonly memo = new Memo()
  readonly checks: Array<CheckResult & { name: string }> = []
  readonly requests: RequestRecord[] = []
  readonly harness: HarnessRecord[] = []
  readonly consoleLog: ConsoleRecord[] = []
  readonly expected: Expected[] = []
  readonly edges: string[] = []
  readonly notes: string[] = []
  readonly storage: Record<string, unknown> = {}
  readonly devices: Partial<Record<DeviceName, Device>> = {}
  readonly offlineByDesign: DeviceName[] = []
  private readonly pending = new Set<Promise<unknown>>()
  private readonly pushStart: number
  private readonly cronStart: number
  private seq = 0
  private stepName = 'start'
  private base: number
  private realBase = Date.now()
  private apis = new Map<string, APIRequestContext>()

  constructor(readonly n: number, readonly push: PushReceiver, start: string) {
    this.dayKey = DAY_KEYS[n - 1]!
    this.dir = join(EVIDENCE_DIR, `day-${String(n).padStart(2, '0')}`)
    mkdirSync(this.dir, { recursive: true })
    this.base = at(this.dayKey, start)
    this.pushStart = push.messages.length
    this.cronStart = push.crons.length
  }

  get label_(): string { return dayLabel(this.n) }

  // --- Journal -------------------------------------------------------------

  simNow(): number { return this.base + (Date.now() - this.realBase) }
  label() { return { step: this.stepName, at: simStamp(this.simNow()) } }
  nextSeq() { return ++this.seq }
  request(record: RequestRecord) { this.requests.push(record) }
  console(record: ConsoleRecord) { this.consoleLog.push(record) }
  track(work: Promise<unknown>) {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
  }
  /** Wait for request records still being written, at most 30 s (a stuck one is noted, never waited on forever). */
  async settle(): Promise<void> {
    const deadline = Date.now() + 30_000
    for (let round = 0; round < 5 && this.pending.size; round++) {
      const left = deadline - Date.now()
      const done = await Promise.race([Promise.allSettled([...this.pending]).then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), Math.max(0, left)))])
      if (!done) {
        this.notes.push(`Harness: ${this.pending.size} request record(s) still pending after 30 s; continued without them`)
        this.progress(`settle gave up on ${this.pending.size} pending record(s)`)
        this.pending.clear()
        return
      }
    }
  }

  /** One line per step start and end (real time), so a run that hangs shows where. */
  progress(line: string): void {
    appendFileSync(join(this.dir, 'progress.log'), `${new Date().toISOString()} ${simStamp(this.simNow())} ${line}\n`)
  }

  // --- Clock -----------------------------------------------------------------

  /** Move every open device (and the cron clock) to `time` on this day, Los Angeles wall time. */
  async advance(time: string): Promise<number> {
    const instant = at(this.dayKey, time)
    if (instant > this.simNow()) {
      this.base = instant
      this.realBase = Date.now()
      for (const device of Object.values(this.devices)) await device.context.clock.setSystemTime(instant)
    }
    return this.simNow()
  }

  /** Let simulated time run with timers firing, in one-minute slices so async work between them can land. */
  async runMinutes(minutes: number): Promise<void> {
    for (let minute = 0; minute < minutes; minute++) {
      for (const device of Object.values(this.devices)) await device.context.clock.runFor(60_000)
      this.base += 60_000
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  // --- Devices ---------------------------------------------------------------

  async phone(time: string, push: PushDevice, prepare?: (device: Device) => Promise<void>): Promise<Device> {
    const start = await this.advance(time)
    const device = await Device.phone(this, this.dir, start, push)
    this.devices.phone = device
    await prepare?.(device)
    return device
  }

  async desktop(time: string): Promise<Device> {
    const start = await this.advance(time)
    const device = await Device.desktop(this, this.dir, start)
    this.devices.desktop = device
    return device
  }

  async outsider(time: string): Promise<Device> {
    const start = await this.advance(time)
    const device = await Device.outsider(this, this.dir, start)
    this.devices.outsider = device
    return device
  }

  async close(name: DeviceName): Promise<void> {
    const device = this.devices[name]
    if (!device) return
    await this.settle()
    this.views.push(...device.views)
    await device.close()
    delete this.devices[name]
  }

  // --- Checks ----------------------------------------------------------------

  check(name: string, feature: Feature, pass: boolean, detail?: unknown): boolean {
    let unique = name
    for (let copy = 2; this.checks.some((check) => check.name === unique); copy++) unique = `${name} (#${copy})`
    this.checks.push({ name: unique, feature, pass, step: this.stepName, at: simStamp(this.simNow()), ...(detail === undefined ? {} : { detail }) })
    return pass
  }

  /** Passes when `assertion` resolves; whatever it returns is kept as the check's detail. */
  async verify(name: string, feature: Feature, assertion: () => unknown): Promise<boolean> {
    try {
      const detail = await assertion()
      return this.check(name, feature, true, detail ?? undefined)
    } catch (error) {
      this.check(name, feature, false)
      this.checks.at(-1)!.error = errorText(error)
      return false
    }
  }

  /** A named stretch of the day. A failure is recorded and the day carries on. */
  async step<T>(name: string, feature: Feature, work: () => Promise<T>): Promise<T | undefined> {
    const previous = this.stepName
    this.stepName = name
    this.progress(`start ${name}`)
    try { return await work() }
    catch (error) {
      this.check(`${name}: completed`, feature, false)
      this.checks.at(-1)!.error = errorText(error)
      for (const device of Object.values(this.devices)) {
        await device.screenshot(`failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}`).catch(() => undefined)
      }
      return undefined
    } finally {
      this.progress(`end ${name}`)
      this.stepName = previous
    }
  }

  edge(text: string): void { this.edges.push(text) }
  expect(expected: Expected): void { this.expected.push(expected) }

  // --- Push ----------------------------------------------------------------

  /** Run the Worker's cron with scheduledTime exactly `time` (so a repeat run reuses the same instant). */
  async cron(time: string): Promise<PushMessage[]> {
    await this.advance(time)
    const instant = at(this.dayKey, time)
    const previous = this.stepName
    this.stepName = `cron ${time}`
    try { return await this.push.cron(instant, this.dayKey) }
    finally { this.stepName = previous }
  }

  get pushes(): PushMessage[] { return this.push.messages.slice(this.pushStart) }
  get crons(): CronRun[] { return this.push.crons.slice(this.cronStart) }

  // --- Harness requests (seeding, account set-up), recorded apart from the devices' own -----

  async api(account: SimAccount): Promise<APIRequestContext> {
    const existing = this.apis.get(account.username)
    if (existing) return existing
    const context = await playwrightRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { Origin: ORIGIN, 'X-Selfie-CSRF': '1' } })
    this.apis.set(account.username, context)
    await this.call(context, 'POST', '/api/auth/login', `sign the harness in as ${account.username}`, { data: account })
    return context
  }

  async call(context: APIRequestContext, method: string, path: string, purpose: string,
    options: { data?: unknown; multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> } = {}) {
    const response = await context.fetch(path, { method, ...options, headers: method === 'GET' ? {} : { Origin: ORIGIN, 'X-Selfie-CSRF': '1' } })
    const body = await response.body()
    const requestBodyBytes = options.data ? Buffer.byteLength(JSON.stringify(options.data))
      : Object.values(options.multipart ?? {}).reduce((total, part) => total + (typeof part === 'string' ? Buffer.byteLength(part) : part.buffer.length), 0)
    this.harness.push({ seq: this.nextSeq(), ...this.label(), purpose, method, path: path.replace(/\?.*$/, ''), status: response.status(), requestBodyBytes, responseBodyBytes: body.length })
    return { status: response.status(), json: () => JSON.parse(body.toString()) as unknown }
  }

  // --- End of day ------------------------------------------------------------

  /** The invariants every day must keep, plus "every card feature was exercised". */
  async invariants(): Promise<void> {
    this.stepName = 'invariants'
    await this.settle()
    const views = this.views.concat(...Object.values(this.devices).map((device) => device.views))
    const wide = views.filter((view) => view.width <= 390 && view.scrollWidth > view.width)
    this.check('invariant: no horizontal scroll at 390 px', 'invariants', wide.length === 0 && views.some((view) => view.width === 390), { screens: views.filter((view) => view.width === 390).length, wide })

    const isAsset = (record: RequestRecord) => ['document', 'script', 'stylesheet'].includes(record.resourceType)
    const badAssets = this.requests.filter((record) => isAsset(record) && (record.status === null ? record.failure !== 'net::ERR_ABORTED' : record.status >= 400))
    this.check('invariant: no failed document/script/style request', 'invariants', badAssets.length === 0, { assets: this.requests.filter(isAsset).length, failed: badAssets.slice(0, 10) })

    const errors = this.consoleLog.filter((record) => !record.network && (record.type === 'error' || record.type === 'pageerror'))
    this.check('invariant: no console errors', 'invariants', errors.length === 0, errors.slice(0, 10))

    const allowed = (record: RequestRecord) => this.expected.some((expected) =>
      (!expected.context || expected.context === record.context) && (!expected.method || expected.method === record.method) && expected.path.test(record.path) &&
      (expected.status === 'failed' ? record.status === null : expected.status === record.status))
    const api = this.requests.filter((record) => record.path.startsWith('/api/'))
    const unexpected = api.filter((record) => !allowed(record) && !record.offline && (record.status === null ? record.failure !== 'net::ERR_ABORTED' : record.status >= 400))
    this.check('invariant: no unexpected API error or failed API request', 'invariants', unexpected.length === 0, { api: api.length, unexpected: unexpected.slice(0, 10), expected: this.expected.map((item) => ({ ...item, path: String(item.path) })) })

    const cachedApi = api.filter((record) => record.fromServiceWorker)
    this.check('offline: /api is never answered by the service worker', 'offline', cachedApi.length === 0, { api: api.length, fromServiceWorker: cachedApi.length })

    const owner = userId(OWNER.username)
    const sent = new Map<string, number>()
    for (const message of this.pushes) {
      const key = `${message.device}/${message.payload.albumId}/${message.event}/${message.dayKey}`
      sent.set(key, (sent.get(key) ?? 0) + 1)
    }
    const log = owner ? notificationLog(owner).filter((row) => row.dayKey === this.dayKey) : []
    this.check('invariant: at most one push per user/album/event/day', 'invariants', [...sent.values()].every((count) => count <= 1), { received: Object.fromEntries(sent), notificationLog: log })
    this.check('push: every delivery decrypts and carries a valid VAPID signature', 'push', this.push.errors.length === 0 && this.pushes.every((message) => message.vapid.signatureValid && message.vapid.serverKey),
      { deliveries: this.pushes.length, receiverErrors: this.push.errors.slice(0, 5) })

    const covered = CARD_FEATURES.filter((feature) => this.checks.some((check) => check.feature === feature))
    this.check('invariant: all eight card features exercised today', 'invariants', covered.length === CARD_FEATURES.length,
      { covered, missing: CARD_FEATURES.filter((feature) => !covered.includes(feature)) })
  }

  /** Screens measured on devices already closed today. */
  readonly views: Array<{ screen: string; scrollWidth: number; width: number }> = []

  async snapshot(label: string, name: DeviceName): Promise<void> {
    const device = this.devices[name]
    if (!device) return
    try {
      this.storage[`${name}:${label}`] = { at: simStamp(this.simNow()), cookies: await device.cookies(), ...await device.storage() as object }
    } catch (error) {
      this.storage[`${name}:${label}`] = { at: simStamp(this.simNow()), error: errorText(error) }
    }
  }

  async finish(): Promise<void> {
    await this.settle()
    for (const name of ['phone', 'desktop', 'outsider'] as const) await this.close(name)
    for (const context of this.apis.values()) await context.dispose()
    this.writeEvidence()
  }

  writeEvidence(): void {
    const owner = userId(OWNER.username)
    const outsider = userId(OUTSIDER.username)
    const checks = Object.fromEntries(this.checks.map(({ name, ...result }) => [name, result]))
    const write = (file: string, value: unknown) => writeFileSync(join(this.dir, file), `${JSON.stringify(value, null, 2)}\n`)
    write('checks.json', {
      day: this.n, label: this.label_, dayKey: this.dayKey, edges: this.edges, notes: this.notes,
      passed: this.checks.filter((check) => check.pass).length, failed: this.checks.filter((check) => !check.pass).length, checks,
    })
    const contexts = [...new Set(this.requests.map((record) => record.context))]
    write('requests.json', {
      day: this.n, label: this.label_,
      contexts: Object.fromEntries(contexts.map((context) => [context, this.requests.filter((record) => record.context === context).sort((a, b) => a.seq - b.seq)])),
      harness: this.harness,
      totals: Object.fromEntries(contexts.map((context) => {
        const records = this.requests.filter((record) => record.context === context)
        return [context, {
          requests: records.length, api: records.filter((record) => record.path.startsWith('/api/')).length,
          fromServiceWorker: records.filter((record) => record.fromServiceWorker).length, failed: records.filter((record) => record.status === null).length,
          requestBodyBytes: records.reduce((total, record) => total + (record.requestBodyBytes ?? 0), 0),
          responseBodyBytes: records.reduce((total, record) => total + (record.responseBodyBytes ?? 0), 0),
        }]
      })),
    })
    write('storage.json', { day: this.n, label: this.label_, devices: this.storage, server: serverStorage({ owner, outsider }) })
    write('push.json', { day: this.n, label: this.label_, crons: this.crons, messages: this.pushes, receiverErrors: this.push.errors })
    write('console.json', this.consoleLog)
  }

  failures(): string[] {
    return this.checks.filter((check) => !check.pass).map((check) => `${check.name}${check.error ? ` — ${check.error.split('\n')[0]}` : ''}`)
  }
}

interface DayFile { day: number; label: string; dayKey: string; edges: string[]; notes: string[]; passed: number; failed: number; checks: Record<string, CheckResult> }

/** summary.md: a day × feature table, the edge cases each day carried, totals and the honesty labels. */
export function writeSummary(): void {
  if (!existsSync(EVIDENCE_DIR)) return
  const days = readdirSync(EVIDENCE_DIR).filter((name) => /^day-\d\d$/.test(name)).sort()
    .flatMap((name) => existsSync(join(EVIDENCE_DIR, name, 'checks.json')) ? [{ name, file: JSON.parse(readFileSync(join(EVIDENCE_DIR, name, 'checks.json'), 'utf8')) as DayFile }] : [])
  const features: Feature[] = [...CARD_FEATURES, 'push', 'accounts', 'invariants']
  const cell = (file: DayFile, feature: Feature) => {
    const results = Object.values(file.checks).filter((check) => check.feature === feature)
    if (!results.length) return '—'
    const failed = results.filter((check) => !check.pass).length
    return failed ? `**FAIL ${failed}/${results.length}**` : `${results.length}/${results.length}`
  }
  const lines = [
    '# Selfie a Day — ten-day simulation', '',
    `Run: ${new Date().toISOString()} (real time). Simulated calendar: America/Los_Angeles, ${DAY_KEYS[0]} to ${DAY_KEYS.at(-1)}.`, '',
    '## Day × feature (passed/total checks)', '',
    `| Day | ${features.join(' | ')} | Total |`,
    `|---|${features.map(() => '---').join('|')}|---|`,
    ...days.map(({ file }) => `| ${file.label} | ${features.map((feature) => cell(file, feature)).join(' | ')} | ${file.failed ? `**${file.passed}/${file.passed + file.failed}**` : `${file.passed}/${file.passed}`} |`),
    '', '## Edge cases by day', '',
    ...days.flatMap(({ file }) => [`- **${file.label}**`, ...file.edges.map((edge) => `  - ${edge}`), ...file.notes.map((note) => `  - Note: ${note}`)]),
    '', '## Failed checks', '',
  ]
  const failed = days.flatMap(({ file }) => Object.entries(file.checks).filter(([, check]) => !check.pass).map(([name, check]) => `- ${file.label}: ${name}${check.error ? ` — ${check.error.split('\n')[0]}` : ''}`))
  lines.push(...(failed.length ? failed : ['None.']))
  let requests = 0
  let api = 0
  let fromServiceWorker = 0
  let pushes = 0
  let crons = 0
  for (const { name } of days) {
    const file = join(EVIDENCE_DIR, name)
    const recorded = JSON.parse(readFileSync(join(file, 'requests.json'), 'utf8')) as { totals: Record<string, { requests: number; api: number; fromServiceWorker: number }> }
    for (const total of Object.values(recorded.totals)) { requests += total.requests; api += total.api; fromServiceWorker += total.fromServiceWorker }
    const pushed = JSON.parse(readFileSync(join(file, 'push.json'), 'utf8')) as { crons: unknown[]; messages: unknown[] }
    pushes += pushed.messages.length
    crons += pushed.crons.length
  }
  const checks = days.reduce((total, { file }) => total + file.passed + file.failed, 0)
  lines.push('', '## Totals', '',
    `- Days: ${days.length}; checks: ${checks}; failed: ${failed.length}.`,
    `- Browser requests recorded: ${requests} (${api} to /api, ${fromServiceWorker} answered by the service worker).`,
    `- Cron runs: ${crons}; push messages delivered and decrypted: ${pushes}.`,
    '', '## Honesty labels', '', ...Object.values(HONESTY).map((label) => `- ${label}`),
    '', '## Not verified', '', ...NOT_VERIFIED.map((item) => `- ${item}: Not verified.`), '')
  writeFileSync(join(EVIDENCE_DIR, 'summary.md'), lines.join('\n'))
}
