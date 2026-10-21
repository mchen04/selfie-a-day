import { readFile } from 'node:fs/promises'
import { randomInt, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { ROOT, SETTINGS, localURL } from './common.mjs'

export const CAMERA_FIXTURE = resolve(process.env.PERF_CAMERA_FIXTURE ?? resolve(ROOT, 'tests/fixtures/alignment-target.y4m'))

export async function launchBrowser() {
  await readFile(CAMERA_FIXTURE)
  const { chromium } = await import('@playwright/test')
  return chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${CAMERA_FIXTURE}`, '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=localhost;127.0.0.1;[::1]'] })
}

export async function newPage(browser, { serviceWorkers = 'block', storageState } = {}) {
  const { viewport, screen, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, colorScheme } = SETTINGS
  const context = await browser.newContext({ viewport, screen, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId,
    colorScheme, permissions: ['camera'], serviceWorkers, storageState })
  context.setDefaultTimeout(SETTINGS.timeoutMs)
  await context.addInitScript(() => {
    globalThis.__perf = { lcp: null, longTasks: [], actions: {} }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) globalThis.__perf.lcp = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) globalThis.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-testid]')
      if (target) globalThis.__perf.actions[target.dataset.testid] = performance.now()
    }, true)
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', SETTINGS.network)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SETTINGS.cpuSlowdown })
  const requests = new Map()
  cdp.on('Network.requestWillBeSent', (event) => {
    requests.set(event.requestId, { url: event.request.url, method: event.request.method, type: event.type,
      requestBytes: event.request.postData ? Buffer.byteLength(event.request.postData) : 0, transferBytes: 0, fromSW: false })
  })
  cdp.on('Network.responseReceived', (event) => {
    const row = requests.get(event.requestId)
    if (row) Object.assign(row, { status: event.response.status, fromSW: !!event.response.fromServiceWorker,
      cached: !!event.response.fromDiskCache, encoding: event.response.headers['content-encoding'] ?? event.response.headers['Content-Encoding'] ?? 'identity' })
  })
  cdp.on('Network.dataReceived', (event) => {
    const row = requests.get(event.requestId)
    if (row && !row.fromSW && !row.cached) row.transferBytes += event.encodedDataLength
  })
  cdp.on('Network.loadingFinished', (event) => {
    const row = requests.get(event.requestId)
    if (row) Object.assign(row, { finished: true, transferBytes: row.fromSW || row.cached ? 0 : event.encodedDataLength })
  })
  cdp.on('Network.loadingFailed', (event) => {
    const row = requests.get(event.requestId)
    if (row) Object.assign(row, { failed: true, error: event.errorText })
  })
  return { context, page, cdp, requests,
    reset: () => requests.clear(),
    network: () => {
      const rows = [...requests.values()].filter((row) => /^https?:/.test(row.url))
      return { transferBytes: rows.reduce((sum, row) => sum + row.transferBytes, 0), requestCount: rows.length,
        networkRequestCount: rows.filter((row) => !row.fromSW && !row.cached).length,
        failedCritical: rows.filter((row) => row.failed && !new URL(row.url).pathname.startsWith('/api/')
          && ['Document', 'Script', 'Stylesheet'].includes(row.type)).map((row) => ({ url: row.url, error: row.error })),
        requests: rows.map((row) => ({ ...row })) }
    },
  }
}

export async function ready(page, allowAccount = false) {
  const handle = await page.waitForFunction((accountAllowed) => {
    const account = document.querySelector('[data-testid="account-screen"]')
    if (accountAllowed && account && account.getBoundingClientRect().height > 0) {
      const inputs = [...account.querySelectorAll('input')]
      const button = account.querySelector('[data-testid="account-submit"]')
      if (inputs.length >= 2 && inputs.every((input) => !input.disabled) && button && !button.disabled)
        return { mode: 'account', readyMs: performance.now() }
    }
    const shutter = document.querySelector('[data-testid="shutter"]')
    const video = document.querySelector('[data-testid="capture-video"]')
    if (!shutter || shutter.disabled || shutter.dataset.mode !== 'capture' || !video || !video.videoWidth || video.readyState < 2) return false
    const canvas = document.createElement('canvas')
    canvas.width = 32; canvas.height = 32
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(video, 0, 0, 32, 32)
    const { data } = ctx.getImageData(0, 0, 32, 32)
    let min = 255; let max = 0
    for (let i = 0; i < data.length; i += 4) {
      const value = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      min = Math.min(min, value); max = Math.max(max, value)
    }
    return max - min > 30 ? { mode: 'capture', readyMs: performance.now() } : false
  }, allowAccount)
  const result = await handle.jsonValue()
  await handle.dispose()
  return result
}

export async function offlineReady(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    if (registration?.active?.state !== 'activated' || !navigator.serviceWorker.controller) return false
    for (const key of await caches.keys()) {
      for (const entry of await (await caches.open(key)).keys()) {
        if (new URL(entry.url).pathname === '/index.html') return true
      }
    }
    return false
  })
}

export async function account(request, origin) {
  localURL(origin)
  const credentials = { username: `perf-${randomUUID().replaceAll('-', '').slice(0, 20)}`, password: randomUUID() + randomUUID() }
  const ip = `198.18.${randomInt(1, 255)}.${randomInt(1, 255)}`
  const headers = { Origin: origin, 'X-Selfie-CSRF': '1', 'X-Forwarded-For': ip, 'CF-Connecting-IP': ip }
  const response = await request.post(`${origin}/api/auth/signup`, { data: credentials, headers, maxRedirects: 0 })
  if (response.status() !== 201) throw new Error(`Synthetic signup returned ${response.status()}; check local API and ALLOWED_ORIGINS`)
  const sync = await request.get(`${origin}/api/sync`, { maxRedirects: 0 })
  if (sync.status() !== 200) throw new Error(`Initial synthetic sync returned ${sync.status()}`)
}

export async function syntheticImage(browser) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 120; canvas.height = 160
      const ctx = canvas.getContext('2d')
      const gradient = ctx.createLinearGradient(0, 0, 120, 160)
      gradient.addColorStop(0, '#e34242'); gradient.addColorStop(1, '#387bea')
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 120, 160)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    return Buffer.from(bytes)
  } finally { await context.close() }
}

export async function seed(request, origin, count, image) {
  localURL(origin)
  for (let index = 0; index < count; index++) {
    const id = index.toString(36).padStart(20, '0')
    const date = new Date(Date.parse(SETTINGS.seedStart) + index * 86_400_000)
    const response = await request.put(`${origin}/api/photos/${id}`, {
      maxRedirects: 0, headers: { Origin: origin, 'X-Selfie-CSRF': '1' }, multipart: {
        meta: JSON.stringify({ albumId: 'selfies', dayKey: date.toISOString().slice(0, 10), capturedAt: date.getTime(),
          timeZone: 'UTC', tzOffsetMinutes: 0, width: 120, height: 160, mime: 'image/jpeg', mirrored: false, source: 'file', timerSeconds: 0 }),
        master: { name: 'master.jpg', mimeType: 'image/jpeg', buffer: image },
        thumb: { name: 'thumb.jpg', mimeType: 'image/jpeg', buffer: image },
      },
    })
    if (response.status() !== 201) throw new Error(`Synthetic photo ${index + 1} returned ${response.status()}`)
    await response.dispose()
  }
  const response = await request.get(`${origin}/api/sync`, { maxRedirects: 0 })
  const snapshot = await response.json()
  if (response.status() !== 200 || snapshot.photos?.length !== count) throw new Error('Synthetic snapshot count does not match seed')
  await response.dispose()
}

export async function credentialsState(browser, origin, count = 0, image) {
  const context = await browser.newContext()
  try {
    await account(context.request, origin)
    if (count) await seed(context.request, origin, count, image)
    return await context.storageState()
  } finally { await context.close() }
}
