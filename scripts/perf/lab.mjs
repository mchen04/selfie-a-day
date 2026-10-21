import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, access } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { loadavg } from 'node:os'
import { cli, envelope, fail, isMain, jsonFile, machine, positiveInt, targetSpec, validateSample,
  SETTINGS, SCENARIOS, stats, buildIdentity, VERSION, validateLabOutput } from './common.mjs'
import { calibrate } from './assets.mjs'
import { ENCODINGS, staticHandler, listen } from './serve.mjs'
import { CAMERA_FIXTURE, launchBrowser, newPage, ready, offlineReady, credentialsState, syntheticImage, completeOnboarding } from './browser.mjs'
import { summarize } from './summarize.mjs'
import { regressionChecks } from './regressions.mjs'

export function argumentsFor(args) {
  const { values, positionals } = cli({ target: { type: 'string', multiple: true }, runs: { type: 'string', default: '9' },
    out: { type: 'string' }, encoding: { type: 'string', default: 'br11' }, port: { type: 'string', default: '4319' },
    'calibration-asset': { type: 'string' }, 'self-check': { type: 'boolean', default: false },
    scenario: { type: 'string', multiple: true }, 'build-mode': { type: 'string', default: 'production' } }, args)
  if (positionals.length) throw new Error('Unexpected positional arguments')
  if (values['self-check']) {
    if (args.length !== 1) throw new Error('--self-check runs alone')
    return { selfCheck: true }
  }
  if (!values.target?.length || !values.out) throw new Error('Usage: lab.mjs --target name=<dist>[,api] ... --runs 9 --out <dir>')
  const targets = values.target.map(targetSpec)
  if (new Set(targets.map((target) => target.name)).size !== targets.length) throw new Error('Target names must be unique')
  if (!ENCODINGS.includes(values.encoding)) throw new Error('Unknown encoding')
  const scenarios = values.scenario ?? SCENARIOS
  if (new Set(scenarios).size !== scenarios.length || scenarios.some((scenario) => !SCENARIOS.includes(scenario))) throw new Error('Invalid scenarios')
  if (!values['build-mode'].trim()) throw new Error('Build mode must be recorded')
  for (const target of targets) {
    const path = relative(target.dist, resolve(values.out))
    if (!path || (!path.startsWith('..') && !isAbsolute(path))) throw new Error('Output must be outside every dist directory')
  }
  return { targets, scenarios, runs: positiveInt(values.runs, 'runs'), out: resolve(values.out), encoding: values.encoding,
    port: positiveInt(values.port, 'port', 65535), calibrationAsset: values['calibration-asset'] ?? process.env.PERF_ORIGINAL_ASSET,
    buildMode: values['build-mode'] }
}

const metric = (value, unit) => ({ value, unit })
const skip = (reason) => ({ status: 'skipped', reason, metrics: {} })

async function navigationMetrics(session, result) {
  const network = session.network()
  await session.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const observed = await session.page.evaluate((cutoff) => ({
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    lcpMs: globalThis.__perf.lcp,
    longTaskMs: globalThis.__perf.longTasks.filter((entry) => entry.start < cutoff)
      .reduce((sum, entry) => sum + Math.min(entry.duration, cutoff - entry.start), 0),
    blockingMs: globalThis.__perf.longTasks.filter((entry) => entry.start < cutoff)
      .reduce((sum, entry) => sum + Math.max(0, Math.min(entry.duration, cutoff - entry.start) - 50), 0),
  }), result.readyMs)
  const heap = await session.cdp.send('Runtime.getHeapUsage')
  if (network.failedCritical.length) throw new Error('Navigation has failed critical requests')
  const metrics = { readyMs: metric(result.readyMs, 'ms'), transferBytes: metric(network.transferBytes, 'bytes'),
    requestCount: metric(network.requestCount, 'count'), longTaskMs: metric(observed.longTaskMs, 'ms'),
    blockingMs: metric(observed.blockingMs, 'ms'), heapBytes: metric(heap.usedSize, 'bytes') }
  for (const key of ['fcpMs', 'lcpMs']) if (observed[key] !== null) metrics[key] = metric(observed[key], 'ms')
  return { status: 'ok', metrics, evidence: { firstScreen: result.mode, observed, network } }
}

async function capture(session, origin, cloud) {
  const { page } = session
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const preparation = await completeOnboarding(page)
  if (preparation.mode === 'account') throw new Error('Capture needs a local API and synthetic session')
  session.reset()
  const uploadPromise = cloud ? page.waitForResponse((response) => new URL(response.url()).pathname.match(/^\/api\/photos\/[0-9a-z]{20}$/)
    && response.request().method() === 'PUT') : null
  const toastPromise = page.getByTestId('toast').filter({ hasText: /saved/i }).waitFor({ state: 'visible' })
  const [, upload] = await Promise.all([toastPromise, uploadPromise, page.getByTestId('shutter').click()])
  let uploadBytes = null
  if (upload) {
    const error = await upload.finished()
    if (error || !upload.ok()) throw new Error(`Capture upload failed (${upload.status()})`)
    uploadBytes = await upload.request().sizes()
  }
  const elapsed = await page.evaluate(() => performance.now() - globalThis.__perf.actions.shutter)
  const network = session.network()
  const metrics = { savedMs: metric(elapsed, 'ms'), transferBytes: metric(network.transferBytes, 'bytes') }
  if (uploadBytes) {
    metrics.uploadRequestBytes = metric(uploadBytes.requestBodySize, 'bytes')
    metrics.uploadResponseBytes = metric(uploadBytes.responseBodySize, 'bytes')
  }
  return { status: 'ok', metrics, evidence: { completedOnboarding: !!preparation.completedOnboarding,
    upload: cloud ? 'finished' : 'skipped: local-only build has no upload API', network } }
}

async function timeline(session, origin) {
  const { page } = session
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await ready(page)
  session.reset()
  await page.getByTestId('nav-timeline').click()
  const handle = await page.waitForFunction(async () => {
    const cells = [...document.querySelectorAll('[data-testid="timeline-cell"]')]
    if (cells.length !== 60) return false
    const visible = cells.filter((cell) => {
      const box = cell.getBoundingClientRect()
      return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
    })
    if (!visible.length) return false
    const images = visible.map((cell) => cell.querySelector('img'))
    if (images.some((image) => !image || !image.complete || !image.naturalWidth)) return false
    await Promise.all(images.map((image) => image.decode()))
    return { elapsed: performance.now() - globalThis.__perf.actions['nav-timeline'], decoded: images.length }
  })
  const result = await handle.jsonValue()
  await handle.dispose()
  const network = session.network()
  return { status: 'ok', metrics: { readyMs: metric(result.elapsed, 'ms'), transferBytes: metric(network.transferBytes, 'bytes'),
    requestCount: metric(network.requestCount, 'count') }, evidence: { decodedInViewport: result.decoded, network } }
}

async function sync(session, origin, count) {
  await session.page.goto(`${origin}/favicon.svg`)
  session.reset()
  const result = await session.page.evaluate(async (expected) => {
    const start = performance.now()
    const response = await fetch('/api/sync', { cache: 'no-store' })
    const body = await response.arrayBuffer()
    const elapsed = performance.now() - start
    const snapshot = JSON.parse(new TextDecoder().decode(body))
    if (!response.ok || snapshot.photos?.length !== expected) throw new Error('Snapshot response differs from seeded data')
    return { elapsed, bodyBytes: body.byteLength, photos: snapshot.photos.length }
  }, count)
  const network = session.network()
  return { status: 'ok', metrics: { snapshotMs: metric(result.elapsed, 'ms'), bodyBytes: metric(result.bodyBytes, 'bytes'),
    transferBytes: metric(network.transferBytes, 'bytes') }, evidence: { photos: result.photos, network } }
}

async function sample(browser, target, scenario, origin, image) {
  const cloud = target.hasAccount
  if ((!cloud || !target.api) && ['cold-signed-in', 'timeline-60', 'sync-60', 'sync-365'].includes(scenario))
    return skip(cloud ? 'Synthetic accounts need --target name=dist,<local API>' : 'Local-only build has no account or photo API')
  if (cloud && !target.api && scenario !== 'cold') return skip('Signed-in capture needs a local API proxy')
  if (['warm', 'offline-warm'].includes(scenario) && !target.hasSW) return skip('Build has no service worker')
  const seeded = scenario === 'timeline-60' || scenario === 'sync-60' ? 60 : scenario === 'sync-365' ? 365 : 0
  let storageState
  if (cloud && scenario !== 'cold') {
    if (scenario === 'capture') storageState = await credentialsState(browser, origin)
    else {
      if (!target.states.has(seeded)) target.states.set(seeded, await credentialsState(browser, origin, seeded, image))
      storageState = target.states.get(seeded)
    }
  }
  const warm = ['warm', 'offline-warm'].includes(scenario)
  const session = await newPage(browser, { serviceWorkers: warm ? 'allow' : 'block', storageState })
  try {
    if (scenario === 'capture') return await capture(session, origin, cloud)
    if (scenario === 'timeline-60') return await timeline(session, origin)
    if (scenario.startsWith('sync-')) return await sync(session, origin, seeded)
    let completedOnboarding = false
    if (warm) {
      await session.page.goto(origin, { waitUntil: 'domcontentloaded' })
      const first = await completeOnboarding(session.page)
      completedOnboarding = !!first.completedOnboarding
      if (first.mode === 'account') return skip('Capture needs a local API and synthetic session')
      await offlineReady(session.page)
      if (scenario === 'offline-warm') {
        await session.page.goto(origin, { waitUntil: 'domcontentloaded' })
        await ready(session.page)
        await session.context.setOffline(true)
        await session.cdp.send('Network.emulateNetworkConditions', { ...SETTINGS.network, offline: true })
        await session.cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      }
    }
    session.reset()
    await session.page.goto(origin, { waitUntil: 'domcontentloaded' })
    const result = await ready(session.page, scenario === 'cold')
    const row = await navigationMetrics(session, result)
    if (warm) row.evidence.completedOnboarding = completedOnboarding
    if (warm && !await session.page.evaluate(() => !!navigator.serviceWorker.controller)) throw new Error('Warm page is not service worker controlled')
    if (scenario === 'offline-warm' && row.evidence.network.failedCritical.length) throw new Error('Offline reload has failed critical requests')
    return row
  } finally { await session.context.close() }
}

export async function guardedSample(history, { target, scenario, round }, run) {
  const key = JSON.stringify([target, scenario])
  const first = history.get(key) ?? []
  const suppressed = first.length === 2 && first.every((sample) => sample.status === 'error') && first[0].reason === first[1].reason
  const before = loadavg()
  let result
  if (suppressed) result = { status: 'error', reason: first[0].reason, metrics: {} }
  else {
    try { result = await run() }
    catch (error) { result = { status: 'error', reason: error.message, metrics: {} } }
    if (first.length < 2) history.set(key, [...first, { status: result.status, reason: result.reason, round }])
  }
  return { ...result, evidence: { ...result.evidence, executed: !suppressed, loadavg: { before, after: loadavg() },
    ...(suppressed ? { failFast: { failedRounds: first.map((sample) => sample.round), reason: first[0].reason } } : {}) } }
}

export async function selfCheck() {
  let checks = 0
  const rejects = (fn) => { assert.throws(fn); checks++ }
  const parsed = argumentsFor(['--target', 'original=./dist', '--target', 'candidate=./dist,http://127.0.0.1:8787', '--out', './results'])
  assert.equal(parsed.runs, 9); assert.equal(parsed.targets.length, 2); checks += 2
  for (const args of [[], ['--target', 'x=dist', '--out', 'out', '--runs', '0'],
    ['--target', 'x=dist,https://example.com', '--out', 'out'], ['--target', 'x=dist', '--target', 'x=dist', '--out', 'out'],
    ['--target', 'x=dist', '--out', 'out', '--encoding', 'wat'], ['--target', 'x=dist', '--out', 'out', '--scenario', 'wat'],
    ['--target', 'x=dist', '--out', 'out', '--unknown'], ['--self-check', '--out', 'out']]) rejects(() => argumentsFor(args))
  const row = { target: 'original', scenario: 'cold', round: 1, status: 'ok', metrics: { readyMs: metric(100, 'ms') } }
  assert.equal(validateSample(row), row); checks++
  rejects(() => validateSample({ ...row, metrics: { readyMs: metric(NaN, 'ms') } }))
  rejects(() => validateSample({ ...row, metrics: {} }))
  rejects(() => validateSample({ ...row, status: 'skipped' }))
  rejects(() => validateSample({ ...row, metrics: { bad: metric(3, 'unknown') } }))
  assert.deepEqual(stats([1, 2, 3, 4, 5]), { n: 5, median: 3, p25: 2, p75: 4, spread: 2, min: 1, max: 5 }); checks++
  const output = envelope('lab', { settings: SETTINGS, machine: { hostname: 'synthetic' }, buildMode: 'production', runs: 1,
    targets: [{ name: 'original', build: { sha256: '0'.repeat(64), files: [] } }], samples: [row] })
  assert.equal(JSON.parse(JSON.stringify(output)).harnessVersion, VERSION); checks++
  assert.equal(validateLabOutput(output), output); checks++
  rejects(() => validateLabOutput({ ...output, harnessVersion: 'unknown' }))
  rejects(() => validateLabOutput({ ...output, samples: [{ ...row, target: 'unknown' }] }))
  rejects(() => validateLabOutput({ ...output, samples: [{ ...row, round: 2 }] }))
  rejects(() => validateLabOutput({ ...output, samples: [row, row] }))
  const pair = summarize([envelope('lab', { samples: [row, { ...row, target: 'candidate', metrics: { readyMs: metric(90, 'ms') } }] })])
  assert.equal(pair.tables[0].comparisons[0].keep, false); checks++
  const gain = summarize([envelope('lab', { samples: [row, { ...row, target: 'candidate', metrics: { readyMs: metric(40, 'ms') } }] })])
  assert.equal(gain.tables[0].comparisons[0].keep, true); checks++
  checks += await regressionChecks(guardedSample)
  return envelope('self-check', { status: 'pass', checks, browsersLaunched: 0 })
}

export async function main() {
  const options = argumentsFor(process.argv.slice(2))
  if (options.selfCheck) { process.stdout.write(`${JSON.stringify(await selfCheck(), null, 2)}\n`); return }
  await mkdir(options.out, { recursive: true })
  const outputPath = resolve(options.out, 'lab.json')
  try { await access(outputPath); throw new Error('Output already exists; choose a new directory') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const calibration = options.encoding === 'br-dynamic' ? await calibrate(options.calibrationAsset
    ?? resolve(options.targets[0].dist, 'assets/index-C7aPkNJ7.js')) : null
  const targets = []
  for (const target of options.targets) {
    const app = await staticHandler(target.dist, { encoding: options.encoding, api: target.api, calibration })
    const build = await buildIdentity(target.dist)
    const hasAccount = build.files.filter((file) => /\.js$/.test(file.path)).some((file) => app.sourceText.get(`/${file.path}`)?.includes('account-screen'))
    targets.push({ ...target, ...app, build, hasAccount, hasSW: build.files.some((file) => file.path === 'sw.js'), states: new Map() })
  }
  let active = targets[0]
  const server = await listen((req, res) => active.handler(req, res), options.port)
  const output = envelope('lab', { settings: SETTINGS, machine: machine(), buildMode: options.buildMode,
    encoding: options.encoding, calibration, origin: server.origin, runs: options.runs,
    schedule: 'scenario, round, target (input order); fresh context per sample',
    targets: targets.map(({ name, dist, api, build, metadata, hasAccount, hasSW }) => ({ name, dist, api, build, server: metadata,
      features: { account: hasAccount, serviceWorker: hasSW } })), samples: [] })
  let browser
  try {
    const fixture = await readFile(CAMERA_FIXTURE)
    output.camera = { sha256: createHash('sha256').update(fixture).digest('hex'), bytes: fixture.length }
    browser = await launchBrowser()
    output.browser = browser.version()
    const image = await syntheticImage(browser)
    output.syntheticImage = { sha256: createHash('sha256').update(image).digest('hex'), bytes: image.length, width: 120, height: 160 }
    await jsonFile(outputPath, validateLabOutput(output))
    const history = new Map()
    for (const scenario of options.scenarios) for (let round = 1; round <= options.runs; round++) for (const target of targets) {
      active = target
      const result = await guardedSample(history, { target: target.name, scenario, round }, () => sample(browser, target, scenario, server.origin, image))
      if (result.status === 'error') process.exitCode = 1
      const row = validateSample({ target: target.name, scenario, round, order: output.samples.length + 1, ...result })
      output.samples.push(row)
      await jsonFile(outputPath, validateLabOutput(output))
      process.stdout.write(`${target.name} ${scenario} ${round}/${options.runs}: ${row.status}${row.evidence.executed ? '' : ' (not run: repeated failure)'}${row.reason ? ` (${row.reason})` : ''}\n`)
    }
    for (const target of targets) {
      if ((await buildIdentity(target.dist)).sha256 !== target.build.sha256) throw new Error(`Build changed during measurement: ${target.name}`)
    }
    output.buildsUnchanged = true
    await jsonFile(outputPath, output)
  } catch (error) {
    output.fatalError = error.message
    await jsonFile(outputPath, output)
    throw error
  } finally { if (browser) await browser.close(); await server.close() }
}

if (isMain(import.meta)) main().catch(fail)
