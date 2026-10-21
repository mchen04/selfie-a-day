import { resolve } from 'node:path'
import { cli, envelope, fail, isMain, jsonFile, localURL, machine, SETTINGS } from './common.mjs'
import { launchBrowser, newPage, ready, offlineReady, credentialsState, completeOnboarding } from './browser.mjs'

export async function main() {
  const { values, positionals } = cli({ url: { type: 'string' }, api: { type: 'string' }, out: { type: 'string' } })
  if (positionals.length || !values.url || !values.out) throw new Error('Usage: pwa.mjs --url <loopback URL> [--api <loopback origin>] --out <dir>')
  const url = localURL(values.url)
  if (values.api) localURL(values.api)
  const result = envelope('pwa', { url: url.href, machine: machine(), settings: SETTINGS, checks: [] })
  const path = resolve(values.out, 'pwa.json')
  const check = async (name, run) => {
    try { result.checks.push({ name, status: 'pass', evidence: await run() }) }
    catch (error) { result.checks.push({ name, status: 'fail', evidence: error.message }); process.exitCode = 1 }
    await jsonFile(path, result)
  }
  let browser; let session
  try {
    browser = await launchBrowser()
    result.browser = browser.version()
    const storageState = values.api ? await credentialsState(browser, url.origin) : undefined
    session = await newPage(browser, { serviceWorkers: 'allow', storageState })
    const { page, cdp, context } = session
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    const first = await completeOnboarding(page)
    let manifest
    await check('manifest fields', async () => {
      const href = await page.locator('link[rel="manifest"]').getAttribute('href')
      if (!href) throw new Error('No manifest link')
      const manifestURL = new URL(href, url)
      if (manifestURL.origin !== url.origin) throw new Error('Manifest must be same-origin')
      const response = await page.request.get(manifestURL.href, { maxRedirects: 0 })
      if (!response.ok()) throw new Error(`Manifest HTTP ${response.status()}`)
      manifest = await response.json()
      for (const field of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color'])
        if (!manifest[field]) throw new Error(`Missing manifest ${field}`)
      const start = new URL(manifest.start_url, manifestURL)
      const scope = new URL(manifest.scope, manifestURL)
      if (start.origin !== url.origin || scope.origin !== url.origin || !start.pathname.startsWith(scope.pathname)) throw new Error('Invalid manifest start URL or scope')
      if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) throw new Error('Manifest display does not support installation')
      return { href: manifestURL.href, manifest }
    })
    await check('manifest and apple icons decode', async () => {
      if (!manifest?.icons?.length) throw new Error('No manifest icons')
      const icons = [...manifest.icons]
      for (const size of ['192x192', '512x512']) if (!icons.some((icon) => icon.sizes?.split(' ').includes(size)
        && (icon.purpose ?? 'any').split(' ').includes('any'))) throw new Error(`Missing any-purpose ${size} icon`)
      if (!icons.some((icon) => icon.purpose?.split(' ').includes('maskable'))) throw new Error('Missing maskable icon')
      const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
      if (!apple) throw new Error('Missing apple-touch-icon')
      icons.push({ src: apple, purpose: 'apple-touch-icon' })
      const evidence = []
      const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
      for (const icon of icons) {
        const iconURL = new URL(icon.src, icon.purpose === 'apple-touch-icon' ? url : new URL(manifestHref, url))
        if (iconURL.origin !== url.origin) throw new Error('Icon must be same-origin')
        const response = await page.request.get(iconURL.href, { maxRedirects: 0 })
        if (!response.ok() || !response.headers()['content-type']?.startsWith('image/')) throw new Error(`Invalid icon response: ${icon.src}`)
        const size = await page.evaluate(async (bytes) => {
          const image = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
          const size = { width: image.width, height: image.height }
          image.close()
          return size
        }, [...await response.body()])
        if (icon.sizes && !icon.sizes.split(' ').includes(`${size.width}x${size.height}`)) throw new Error(`Icon dimensions differ: ${icon.src}`)
        evidence.push({ src: icon.src, purpose: icon.purpose ?? 'any', ...size })
      }
      return evidence
    })
    await check('iOS meta tags', async () => {
      const metas = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('meta[name]')].map((meta) => [meta.name, meta.content])))
      if (metas['apple-mobile-web-app-capable'] !== 'yes' || !metas['apple-mobile-web-app-title']
        || !metas['apple-mobile-web-app-status-bar-style'] || !metas['theme-color']
        || !metas.viewport?.includes('viewport-fit=cover')) throw new Error(`Incomplete iOS tags: ${JSON.stringify(metas)}`)
      return metas
    })
    await check('service worker controls the page', async () => {
      await offlineReady(page)
      return page.evaluate(() => ({ controller: navigator.serviceWorker.controller.scriptURL }))
    })
    await check('Chromium installability', async () => {
      await cdp.send('Page.enable')
      const evidence = await cdp.send('Page.getInstallabilityErrors')
      if (evidence.installabilityErrors.length) throw new Error(JSON.stringify(evidence))
      return evidence
    })
    await check('API bypasses service worker cache online', async () => {
      session.reset()
      const response = await page.evaluate(async () => {
        const response = await fetch('/api/sync?perf_probe=v1', { cache: 'no-store' })
        await response.text()
        return { status: response.status, type: response.headers.get('content-type') }
      })
      const apiRequests = session.network().requests.filter((row) => new URL(row.url).pathname.startsWith('/api/'))
      if (!apiRequests.length || apiRequests.some((row) => row.fromSW)) throw new Error('API response comes from the service worker')
      const cached = await page.evaluate(async () => {
        const urls = []
        for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
          if (/^\/api(?:\/|$)/.test(new URL(request.url).pathname)) urls.push(request.url)
        }
        return urls
      })
      if (cached.length) throw new Error(`API entries in Cache Storage: ${JSON.stringify(cached)}`)
      if (values.api && (response.status !== 200 || !response.type?.includes('application/json'))) throw new Error('Synthetic API snapshot is not JSON 200')
      return { response, cached, requests: apiRequests }
    })
    await context.setOffline(true)
    await cdp.send('Network.emulateNetworkConditions', { ...SETTINGS.network, offline: true })
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await check('API cannot return cached data offline', async () => {
      const response = await page.evaluate(async () => {
        try { const response = await fetch('/api/sync?perf_probe=v1', { cache: 'no-store' }); return { served: true, status: response.status, body: (await response.text()).slice(0, 80) } }
        catch { return { served: false } }
      })
      if (response.served) throw new Error(`Offline API returns a response: ${JSON.stringify(response)}`)
      return response
    })
    await check('offline cold document renders shell and capture', async () => {
      if (first.mode === 'account') throw new Error('Signed-in capture needs --api and a local API proxy')
      await page.goto('about:blank')
      session.reset()
      await page.goto(url.href, { waitUntil: 'domcontentloaded' })
      const capture = await ready(page)
      if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) throw new Error('Offline document is not SW controlled')
      const network = session.network()
      if (network.failedCritical.length) throw new Error(JSON.stringify(network.failedCritical))
      const document = network.requests.find((row) => row.type === 'Document')
      if (!document?.fromSW) throw new Error('Offline document does not come from the service worker')
      return { capture, httpCacheDisabled: true, document, localOnlyBuild: !values.api }
    })
    await check('API navigation never falls back to cached shell', async () => {
      const response = await page.goto(`${url.origin}/api/sync?perf_probe=v1`, { waitUntil: 'domcontentloaded' }).catch(() => null)
      if (response && response.status() < 400) throw new Error(`Offline API navigation returns HTTP ${response.status()}`)
      return { responseStatus: response?.status() ?? null, navigationFailed: response === null }
    })
  } catch (error) {
    result.checks.push({ name: 'setup', status: 'fail', evidence: error.message }); process.exitCode = 1
  } finally {
    if (session) await session.context.close()
    if (browser) await browser.close()
    result.passed = result.checks.length > 0 && result.checks.every((check) => check.status === 'pass')
    await jsonFile(path, result)
  }
}

if (isMain(import.meta)) main().catch(fail)
