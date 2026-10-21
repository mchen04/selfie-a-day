import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { references } from './assets.mjs'
import { firstScreenReady, completeOnboarding } from './browser.mjs'
import { servedDelivery } from './sizes.mjs'
import { summarize, markdown } from './summarize.mjs'
import { envelope } from './common.mjs'

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
  return checks
}
