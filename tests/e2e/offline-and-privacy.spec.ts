import { expect, test, type Request } from '@playwright/test'
import {
  captureOnce,
  completeOnboarding,
  countPhotos,
  gotoApp,
  listStoredPhotos,
  shot,
  waitForCameraLive,
  waitForOfflineReady,
} from '../e2e-support/helpers.ts'

/** Gate 5: capture works with the network disabled. */
test.describe('offline', () => {
  test('the app cold-starts and captures with the network off', async ({ page, context }) => {
    // Registering and precaching a service worker is genuinely slow, and this
    // test then does a full cold start on top of it. The default 60s budget is
    // not a meaningful signal here — a real failure shows up as an assertion.
    test.setTimeout(120_000)

    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await waitForOfflineReady(page)

    // Cut the network entirely, then cold-start from the precached shell.
    await context.setOffline(true)
    try {
      await page.reload()
      await completeOnboarding(page)
      await waitForCameraLive(page)
      await shot(page, `offline-1-cold-start-${test.info().project.name}.png`)

      const id = await captureOnce(page)
      expect(id).toBeTruthy()
      expect(await countPhotos(page)).toBe(1)
      await shot(page, `offline-2-captured-${test.info().project.name}.png`)

      // In-app navigation still works with no network.
      await page.getByTestId('nav-timeline').click()
      await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    } finally {
      // The context is already gone if the test timed out; do not let a
      // teardown failure mask the assertion that actually failed.
      await context.setOffline(false).catch(() => undefined)
    }
  })

  test('a deep link cold-starts offline from the precached shell', async ({ page, context }) => {
    test.setTimeout(120_000)

    await gotoApp(page)
    await completeOnboarding(page)
    await waitForOfflineReady(page)

    await context.setOffline(true)
    try {
      // Straight to a sub-route with no network: the service worker must serve
      // the shell for it, or an installed app opens on a browser error page.
      await page.goto('/settings')
      await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 30_000 })

      await page.goto('/timeline')
      await expect(page.getByTestId('timeline-screen')).toBeVisible({ timeout: 30_000 })
    } finally {
      await context.setOffline(false).catch(() => undefined)
    }
  })

  test('a photo taken offline is still there once the network returns', async ({ page, context }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await waitForOfflineReady(page)

    await context.setOffline(true)
    const id = await captureOnce(page)
    await context.setOffline(false)

    await page.reload()
    await completeOnboarding(page)
    expect((await listStoredPhotos(page))[0]?.id).toBe(id)
  })
})

/**
 * Gate 8: no request carries image bytes, and nothing leaves the origin.
 *
 * Every request the page makes is recorded, including ones the service worker
 * would serve from cache, and inspected for a body or a foreign host.
 */
test.describe('privacy', () => {
  test('capture makes no network request carrying image data', async ({ page, context }) => {
    const requests: { url: string; method: string; postDataLength: number; resourceType: string }[] = []

    const record = (request: Request) => {
      const post = request.postData()
      requests.push({
        url: request.url(),
        method: request.method(),
        postDataLength: post ? post.length : 0,
        resourceType: request.resourceType(),
      })
    }

    // context, NOT page. `page.on('request')` cannot see requests made by the
    // service worker: a fresh-eyes verifier demonstrated a build whose only
    // change was exfiltration inside sw.js passing this whole suite green while
    // 114 KB of image/webp left for a foreign origin. Head to head in one
    // session, context-level recording saw 17 foreign worker POSTs and
    // page-level saw none.
    context.on('request', record)

    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    // Everything before this point is app loading. Only judge the capture.
    requests.length = 0

    await captureOnce(page)
    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    await page.getByTestId('timeline-cell').first().click()
    await expect(page.getByTestId('photo-image')).toBeVisible()

    // blob: and data: URLs never touch the network — they are how the app shows
    // stored photos. Anything else is a real request.
    const networkRequests = requests.filter(
      (r) => !r.url.startsWith('blob:') && !r.url.startsWith('data:'),
    )

    expect(
      networkRequests.map((r) => `${r.method} ${r.url}`),
      'capturing and viewing a photo should make no network requests at all',
    ).toEqual([])

    // Deliberately NOT asserting on post-body size. Playwright reports 0 bytes
    // for a Blob body, so that assertion can never fire for the exact vector it
    // would be named after. The load-bearing assertion is the one above: no
    // request of any kind, from the page or the worker.
  })

  test('the whole session never contacts another origin', async ({ page, context, baseURL }) => {
    const foreign: string[] = []
    context.on('request', (request) => {
      const url = request.url()
      if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('about:')) return
      if (baseURL && url.startsWith(baseURL)) return
      foreign.push(`${request.method()} ${url}`)
    })

    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-screen')).toBeVisible()
    await page.getByTestId('request-persistence').click().catch(() => undefined)
    await page.getByTestId('settings-back').click()

    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')

    expect(foreign, 'the app must not contact any origin but its own').toEqual([])
  })

  test('no credential or connection string is present in the served bundle', async ({ page, baseURL }) => {
    // Collect every script and stylesheet the page actually loads, and read it
    // back over HTTP — the bytes a user's browser really receives.
    await gotoApp(page)
    await completeOnboarding(page)

    const assets = await page.evaluate(() => {
      const urls = new Set<string>()
      for (const el of Array.from(document.querySelectorAll('script[src]'))) {
        urls.add((el as HTMLScriptElement).src)
      }
      for (const el of Array.from(
        document.querySelectorAll('link[rel="stylesheet"], link[rel="manifest"]'),
      )) {
        urls.add((el as HTMLLinkElement).href)
      }
      return [...urls]
    })

    expect(assets.length).toBeGreaterThan(0)
    const toCheck = [...assets, `${baseURL}/sw.js`, `${baseURL}/manifest.webmanifest`]

    const forbidden = [
      /postgres(?:ql)?:\/\//i,
      /npg_[A-Za-z0-9]{8,}/,
      /neondb_owner/i,
      /neon\.tech/i,
      /sslmode=require/i,
    ]

    const offenders: string[] = []
    for (const url of toCheck) {
      const response = await page.request.get(url)
      expect(response.status(), `${url} should be served`).toBe(200)
      const body = await response.text()
      for (const pattern of forbidden) {
        if (pattern.test(body)) offenders.push(`${url} matches ${pattern.source}`)
      }
    }

    expect(offenders, 'no secret may appear in anything shipped to the browser').toEqual([])
  })
})
