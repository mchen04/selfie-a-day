import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { hostname } from 'node:os'
import { JSDOM } from 'jsdom'
import { references } from './assets.mjs'
import { firstScreenReady, completeOnboarding, newPage, offlineReady } from './browser.mjs'
import { servedDelivery } from './sizes.mjs'
import { summarize, markdown } from './summarize.mjs'
import { envelope, validateSample, validateLabOutput, SETTINGS } from './common.mjs'
import { prepareAction, actionStamp, savedToastStamp, actionTiming, timelineDecoded, requestBodyDetails, uploadMeasurements } from './measurements.mjs'

function screen(html) {
  const dom = new JSDOM(html)
  const { document } = dom.window
  for (const element of document.querySelectorAll('*')) element.getBoundingClientRect = () => ({ width: 390, height: 45 })
  const video = document.querySelector('video')
  if (video) {
    Object.defineProperty(video, 'videoWidth', { value: 120, configurable: true })
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true })
  }
  const createElement = document.createElement.bind(document)
  document.createElement = (name, ...args) => name !== 'canvas' ? createElement(name, ...args) : {
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) }) }),
  }
  return { document, close: () => dom.window.close() }
}

function evaluate(predicate, document, allow) {
  return runInNewContext(`(${predicate.toString()})(allow)`, { document, allow, performance: { now: () => 123 } })
}

export async function regressionChecks(guardedSample) {
  let checks = 0
  const minified = 'const a=String("from");try{const J=await rp(et),g=await fp(J,{makeThumbnail:uh,onProgress:(D,U)=>G(`Restoring ${D} of ${U}…`)});g.skipped>0&&G("done")}catch{};s.jsx("div",{children:[s.jsx("span",{children:"from"})]}),s.jsxs("section",{});'
  assert.deepEqual(references(minified, 'js'), []); checks++
  const module = [
    'import "./direct.js";import{a}from"./named.js";export{a}from"./export.js";export*from"./all.js";',
    'new URL("./icon.png",import.meta.url);new URL(`./plain.svg`,import.meta.url);import("./lazy.js");',
    'const text=\'import "./fake.js"\';',
  ].join('')
  assert.deepEqual(references(module, 'js').sort(), ['./all.js', './direct.js', './export.js', './icon.png', './named.js', './plain.svg']); checks++
  assert.deepEqual(references('const pattern=/from"ghost"/;const text=`import "./fake.js"`;new URL("./no.png",other.url);', 'js'), []); checks++
  assert.deepEqual(references('<script src="/real.js"></script><!-- <img src="/fake.png"> --><script>const html="<img src=\'/ghost.png\'>"</script><link href="/real.css"><img data-src="/later.png" src="/real.png">', 'html'), ['/real.js', '/real.css', '/real.png']); checks++
  assert.deepEqual(references('body{background:url("/real.png")}', 'css'), ['/real.png']); checks++

  const delivery = servedDelivery([
    { path: '/assets/main.js', served: [
      { requestedEncoding: 'br', status: 200, contentEncoding: 'br', bodyBytes: 92421, contentLength: null },
      { requestedEncoding: 'gzip', status: 200, contentEncoding: 'gzip', bodyBytes: 90548, contentLength: null },
    ] },
    { path: '/favicon.svg', served: ['br', 'gzip'].map((requestedEncoding) => ({ requestedEncoding, status: 200,
      contentEncoding: 'identity', bodyBytes: 358, contentLength: '358' })) },
  ])
  assert.equal(delivery.servedAssets.length, 4); checks++
  assert.equal(delivery.servedAssets[0].path, '/assets/main.js'); checks++
  assert.equal(delivery.servedTotals[0].bodyBytes, 92779); checks++
  assert.equal(delivery.servedTotals[1].bodyBytes, 90906); checks++
  assert.equal(delivery.servedTotals[0].contentLengthBytes, null); checks++
  assert.deepEqual(delivery.servedTotals[0].contentEncodings, { br: 1, identity: 1 }); checks++
  assert.deepEqual(servedDelivery([]), { servedAssets: [], servedTotals: [] }); checks++

  const onboarding = screen('<div data-testid="onboarding-screen"><button data-testid="onboarding-start">Turn on the camera</button></div>')
  const account = screen('<main data-testid="account-screen"><input name="username"><input name="password"><button data-testid="account-submit">Create account</button></main>')
  const capture = screen('<div data-testid="capture-screen"><video data-testid="capture-video"></video><button data-testid="shutter" data-mode="capture">Capture</button></div>')
  try {
    assert.equal(evaluate(firstScreenReady, onboarding.document, true).mode, 'onboarding'); checks++
    assert.equal(evaluate(firstScreenReady, onboarding.document, false), false); checks++
    onboarding.document.querySelector('button').disabled = true
    assert.equal(evaluate(firstScreenReady, onboarding.document, true), false); checks++
    onboarding.document.querySelector('button').disabled = false
    assert.equal(evaluate(firstScreenReady, account.document, true).mode, 'account'); checks++
    assert.equal(evaluate(firstScreenReady, account.document, false), false); checks++
    account.document.querySelector('button').disabled = true
    assert.equal(evaluate(firstScreenReady, account.document, true), false); checks++
    account.document.querySelector('button').disabled = false
    assert.equal(evaluate(firstScreenReady, capture.document, false).mode, 'capture'); checks++
    capture.document.querySelector('button').disabled = true
    assert.equal(evaluate(firstScreenReady, capture.document, false), false); checks++
    capture.document.querySelector('button').disabled = false
    Object.defineProperty(capture.document.querySelector('video'), 'videoWidth', { value: 0, configurable: true })
    assert.equal(evaluate(firstScreenReady, capture.document, false), false); checks++
    Object.defineProperty(capture.document.querySelector('video'), 'videoWidth', { value: 120, configurable: true })
    let document = onboarding.document
    const clicks = []
    const page = {
      async waitForFunction(predicate, allow) {
        const value = evaluate(predicate, document, allow)
        assert.ok(value, 'Readiness predicate must resolve')
        return { jsonValue: async () => value, dispose() {} }
      },
      getByTestId(id) { return { async click() { clicks.push(id); document = capture.document } } },
    }
    const result = await completeOnboarding(page)
    assert.equal(result.mode, 'capture'); assert.equal(result.completedOnboarding, true); checks++
    assert.deepEqual(clicks, ['onboarding-start']); checks++
    document = account.document
    assert.equal((await completeOnboarding(page)).mode, 'account'); assert.equal(clicks.length, 1); checks++
  } finally { onboarding.close(); account.close(); capture.close() }

  const history = new Map()
  const samples = []
  let executions = 0
  for (let round = 1; round <= 9; round++) samples.push({ target: 'original', scenario: 'cold', round,
    ...await guardedSample(history, { target: 'original', scenario: 'cold', round }, async () => {
      executions++
      throw new Error('page.waitForFunction: Timeout 45000ms exceeded.')
    }),
  })
  assert.equal(executions, 2); checks++
  assert.equal(samples.length, 9); assert.ok(samples.every((sample) => sample.status === 'error')); checks++
  assert.equal(samples[2].evidence.executed, false); checks++
  assert.deepEqual(samples[2].evidence.failFast.failedRounds, [1, 2]); checks++
  assert.ok(samples.every((sample) => sample.evidence.loadavg.before.length === 3 && sample.evidence.loadavg.after.every(Number.isFinite))); checks++
  for (const identity of [{ target: 'candidate', scenario: 'cold', round: 3 }, { target: 'original', scenario: 'warm', round: 3 }]) {
    const other = await guardedSample(history, identity, async () => ({ status: 'ok', metrics: { readyMs: { value: 100, unit: 'ms' } } }))
    assert.equal(other.evidence.executed, true); checks++
  }
  let differentExecutions = 0
  const differing = new Map()
  for (let round = 1; round <= 3; round++) await guardedSample(differing, { target: 'original', scenario: 'cold', round }, async () => {
    differentExecutions++
    throw new Error(`Different failure ${round}`)
  })
  assert.equal(differentExecutions, 3); checks++
  const loaded = { target: 'candidate', scenario: 'cold', round: 1, status: 'ok', metrics: { readyMs: { value: 123, unit: 'ms' } },
    evidence: { executed: true, loadavg: { before: [4.7, 6, 7.6], after: [5, 6, 7] } } }
  const summary = summarize([envelope('lab', { samples: [...samples, loaded] })])
  assert.equal(summary.loadAverages.length, 10); checks++
  assert.equal(summary.tables[0].targets[0].n, 1); checks++
  assert.match(markdown(summary), /4\.70 \/ 6 \/ 7\.60/); checks++
  for (const value of [NaN, -1, Infinity, undefined]) {
    const bad = await guardedSample(new Map(), { target: 'candidate', scenario: 'timeline-60', round: 1 }, async () => ({
      status: 'ok', metrics: { readyMs: { value, unit: 'ms' } },
    }))
    assert.equal(bad.status, 'error'); assert.ok(bad.reason.includes(`readyMs: value=${String(value)}`)); checks++
    assert.deepEqual(bad.metrics, {}); checks++
    validateSample({ ...bad, target: 'candidate', scenario: 'timeline-60', round: 1 })
  }
  const invalidTimeline = await guardedSample(new Map(), { target: 'candidate', scenario: 'timeline-60', round: 1 }, async () => ({
    status: 'ok', metrics: { readyMs: { value: 300 - ({})['nav-timeline'], unit: 'ms' } },
  }))
  const nextSync = await guardedSample(new Map(), { target: 'candidate', scenario: 'sync-60', round: 1 }, async () => ({
    status: 'ok', metrics: { snapshotMs: { value: 100, unit: 'ms' } },
  }))
  assert.equal(nextSync.status, 'ok'); checks++
  const continued = envelope('lab', { settings: SETTINGS, machine: { hostname: 'synthetic' }, buildMode: 'production', runs: 1,
    targets: [{ name: 'candidate', build: { sha256: '0'.repeat(64), files: [] } }],
    samples: [{ ...invalidTimeline, target: 'candidate', scenario: 'timeline-60', round: 1 }, { ...nextSync, target: 'candidate', scenario: 'sync-60', round: 1 }] })
  assert.equal(validateLabOutput(continued), continued); checks++

  const timeline = screen('<main data-testid="timeline-screen">' + '<button data-testid="timeline-cell"><img></button>'.repeat(60) + '</main>')
  try {
    let clock = 900
    const context = { document: timeline.document, innerHeight: 664, innerWidth: 390, __perf: { actions: {} },
      performance: { timeOrigin: 1792611404000, now: () => clock } }
    const poll = () => runInNewContext(`(${timelineDecoded.toString()})()`, context)
    const action = { testId: 'nav-timeline', fallbackAt: 1792611404849.7 }
    const clickAt = 1792611404881.4
    assert.equal(poll(), false); checks++
    assert.throws(() => actionTiming(action, { clickAt, finishedAt: undefined }), /finish=undefined/); checks++
    let finishDecode
    const decoding = new Promise((resolve) => { finishDecode = resolve })
    for (const cell of timeline.document.querySelectorAll('[data-testid="timeline-cell"]')) cell.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 120 })
    for (const image of timeline.document.querySelectorAll('img')) {
      Object.defineProperty(image, 'complete', { value: true })
      Object.defineProperty(image, 'naturalWidth', { value: 120 })
      image.decode = () => decoding
    }
    assert.equal(poll(), false); checks++
    assert.equal(poll(), false); checks++
    clock = 1001.4
    finishDecode()
    await new Promise((resolve) => setImmediate(resolve))
    const decoded = poll()
    const stamp = runInNewContext(`(${actionStamp.toString()})({testId:'nav-timeline'})`, context)
    const timing = actionTiming(action, { ...stamp, finishedAt: decoded.finishedAt })
    assert.equal(decoded.decoded, 60); checks++
    assert.equal(decoded.finishedAt, 1792611405001.4); checks++
    assert.ok(Math.abs(timing.elapsedMs - 151.7) < 0.001); assert.equal(timing.startSource, 'before-click fallback'); checks++
    validateSample({ target: 'candidate', scenario: 'timeline-60', round: 1, status: 'ok', metrics: { readyMs: { value: timing.elapsedMs, unit: 'ms' } } }); checks++
    const clicked = actionTiming(action, { clickAt, finishedAt: decoded.finishedAt })
    assert.equal(clicked.elapsedMs, 120); assert.equal(clicked.startSource, 'click'); checks++
    assert.throws(() => actionTiming({ testId: 'nav-timeline', fallbackAt: 1200 }, { clickAt: 1500, finishedAt: 1300 }), /Invalid action timing/); checks++
    delete context.__perf.timelineDecode
    for (const image of timeline.document.querySelectorAll('img')) image.decode = async () => { throw new Error('synthetic decode failure') }
    assert.equal(poll(), false); checks++
    await new Promise((resolve) => setImmediate(resolve))
    assert.throws(poll, /synthetic decode failure/); checks++
  } finally { timeline.close() }

  const workerContext = { navigator: { serviceWorker: { controller: { state: 'activated' },
    getRegistration: async () => ({ active: { state: 'activated' } }) } },
    caches: { keys: async () => ['synthetic'], open: async () => ({ keys: async () => [{ url: 'http://127.0.0.1:4319/index.html' }] }) }, URL }
  const workerPage = { async waitForFunction(predicate) {
    const result = runInNewContext(`(${predicate.toString()})()`, workerContext)
    assert.equal(result, true)
  }, async evaluate(predicate) { return runInNewContext(`(${predicate.toString()})()`, workerContext) } }
  await offlineReady(workerPage); checks++
  workerContext.caches.keys = async () => []
  await assert.rejects(offlineReady(workerPage), /no cached app shell/); checks++

  const toast = screen('<button data-testid="shutter">Capture</button><div data-testid="toast" style="display:none"></div>')
  try {
    let clock = 100
    const context = { document: toast.document, __perf: { actions: {} }, performance: { timeOrigin: 1000, now: () => clock },
      MutationObserver: toast.document.defaultView.MutationObserver, getComputedStyle: toast.document.defaultView.getComputedStyle.bind(toast.document.defaultView) }
    const action = runInNewContext(`(${prepareAction.toString()})(document.querySelector('button'),{testId:'shutter',savedToast:true})`, context)
    clock = 150
    toast.document.querySelector('button').click()
    clock = 300
    toast.document.querySelector('[data-testid="toast"]').textContent = 'Saved to Selfies'
    toast.document.querySelector('[data-testid="toast"]').style.display = 'block'
    await new Promise((resolve) => setImmediate(resolve))
    const saved = runInNewContext(`(${savedToastStamp.toString()})('shutter')`, context)
    clock = 900
    const uploaded = runInNewContext(`(${actionStamp.toString()})({testId:'shutter'})`, context)
    assert.equal(actionTiming(action, { ...uploaded, ...saved }).elapsedMs, 150); checks++
    assert.equal(actionTiming(action, uploaded).elapsedMs, 750); checks++
  } finally { toast.close() }

  const partial = { hasPostData: true, headers: { 'Content-Type': 'multipart/form-data; boundary=synthetic' },
    postDataEntries: [{ bytes: Buffer.from('headers').toString('base64') }, {}] }
  assert.equal(requestBodyDetails(partial).requestBytes, null); checks++
  const full = requestBodyDetails({ ...partial, headers: { ...partial.headers, 'Content-Length': '1048' } })
  assert.equal(full.requestBytes, 1048); assert.equal(full.requestBytesSource, 'content-length'); checks++
  const entries = requestBodyDetails({ ...partial, postDataEntries: [{ bytes: Buffer.from('雪').toString('base64') }, { bytes: Buffer.alloc(5).toString('base64') }] })
  assert.equal(entries.requestBytes, 8); assert.equal(entries.requestBytesSource, 'cdp-postDataEntries'); checks++
  const listeners = new Map()
  const cdp = { on(name, callback) { listeners.set(name, callback) }, async send(name) {
    return name === 'Network.getRequestPostData' ? { postData: 'file bytes omitted', base64Encoded: false } : {}
  } }
  const context = { setDefaultTimeout() {}, async addInitScript() {}, async newPage() { return {} }, async newCDPSession() { return cdp } }
  const session = await newPage({ async newContext() { return context } })
  for (const extraFirst of [true, false]) {
    session.reset()
    const extra = () => listeners.get('Network.requestWillBeSentExtraInfo')({ requestId: 'synthetic', headers: { 'Content-Length': '1048' } })
    if (extraFirst) extra()
    listeners.get('Network.requestWillBeSent')({ requestId: 'synthetic', request: { ...partial, url: 'http://127.0.0.1:4319/api/photos/synthetic', method: 'PUT' }, type: 'Fetch' })
    if (!extraFirst) extra()
    const body = await session.requestBody('http://127.0.0.1:4319/api/photos/synthetic', 'PUT')
    assert.equal(body.requestBytes, 1048); checks++
  }
  const request = { url: () => 'http://127.0.0.1:4319/api/photos/synthetic', method: () => 'PUT',
    allHeaders: async () => ({}), sizes: async () => ({ requestBodySize: 0, responseBodySize: 263 }) }
  const response = { request: () => request, json: async () => ({ photo: { masterBytes: 800, thumbBytes: 40 } }) }
  const uploaded = await uploadMeasurements(session, response)
  assert.equal(uploaded.requestBytes, 1048); assert.equal(uploaded.responseBytes, 263); checks++
  assert.deepEqual(uploaded.parts, { masterBytes: 800, thumbBytes: 40 }); checks++
  assert.equal(uploaded.requestBytesSource, 'content-length'); checks++
  await assert.rejects(uploadMeasurements({ requestBody: async () => ({ requestBytes: null }) }, response), /uploadRequestBytes: value=null/); checks++
  assert.equal(envelope('sizes', {}).machine.hostname, hostname()); checks++
  for (const kinds of [['lab', 'lab'], ['lighthouse', 'lighthouse'], ['lab', 'lighthouse']]) {
    const reports = kinds.map((kind, index) => envelope(kind, { machine: { hostname: `synthetic-host-${index}` }, samples: [] }))
    assert.throws(() => summarize(reports), /Measurement hosts differ/); checks++
    reports[1].machine.hostname = reports[0].machine.hostname
    assert.equal(summarize(reports).measurementHost, reports[0].machine.hostname); checks++
  }
  assert.throws(() => summarize([envelope('lab', { machine: {}, samples: [] })]), /hostname missing/); checks++
  return checks
}
