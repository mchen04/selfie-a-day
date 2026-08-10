import { expect, test } from '@playwright/test'
import { completeOnboarding, gotoApp, shot, waitForCameraLive } from '../e2e-support/helpers.ts'

/**
 * Gate 6, run against the deployed production URL rather than a local build.
 *
 * Enabled only when E2E_BASE_URL points at production:
 *   E2E_BASE_URL=https://selfie-a-day.vercel.app npx playwright test production
 *
 * A local preview server proves the code works. It does not prove the *deploy*
 * works — headers, rewrites, MIME types and the service-worker scope are all
 * Vercel's job, and all four can be wrong while every local test is green.
 */
const BASE = process.env.E2E_BASE_URL
test.skip(!BASE || !BASE.startsWith('https://'), 'set E2E_BASE_URL to an https:// deployment')

interface Manifest {
  name?: string
  short_name?: string
  start_url?: string
  display?: string
  icons?: { src: string; sizes: string; type?: string; purpose?: string }[]
  theme_color?: string
}

test.describe('production deployment', () => {
  test('serves over https with the expected security headers', async ({ request }) => {
    const response = await request.get(`${BASE}/`)
    expect(response.status()).toBe(200)
    expect(new URL(response.url()).protocol).toBe('https:')

    const headers = response.headers()
    // getUserMedia needs a secure context; these are the rest of the promise.
    expect(headers['content-security-policy']).toContain("default-src 'self'")
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['permissions-policy']).toContain('camera=(self)')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  test('the manifest satisfies every installability requirement', async ({ request }) => {
    const response = await request.get(`${BASE}/manifest.webmanifest`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/manifest+json')

    const manifest = (await response.json()) as Manifest

    expect(manifest.name, 'name is required').toBeTruthy()
    expect(manifest.short_name, 'short_name is required for the home screen').toBeTruthy()
    expect(manifest.start_url, 'start_url is required').toBeTruthy()
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display)
    expect(manifest.theme_color).toBeTruthy()

    const icons = manifest.icons ?? []
    const sizes = icons.map((i) => i.sizes)
    expect(sizes, 'a 192px icon is required').toContain('192x192')
    expect(sizes, 'a 512px icon is required').toContain('512x512')
    expect(
      icons.some((i) => i.purpose?.includes('maskable')),
      'a maskable icon is required for a good Android home-screen icon',
    ).toBe(true)

    // Every declared icon must actually exist and be a real PNG.
    for (const icon of icons) {
      const iconResponse = await request.get(new URL(icon.src, BASE).toString())
      expect(iconResponse.status(), `${icon.src} must be served`).toBe(200)
      expect(iconResponse.headers()['content-type']).toContain('image/png')
      const body = await iconResponse.body()
      expect([...body.subarray(0, 4)], `${icon.src} must be a PNG`).toEqual([0x89, 0x50, 0x4e, 0x47])
    }

    // start_url must itself load, or the installed icon opens a 404.
    const start = await request.get(new URL(manifest.start_url!, BASE).toString())
    expect(start.status()).toBe(200)
  })

  test('serves the iOS-specific install requirements', async ({ request }) => {
    const html = await (await request.get(`${BASE}/`)).text()

    // iOS reads these instead of the manifest for home-screen behaviour.
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('apple-touch-icon')
    expect(html, 'viewport-fit=cover is required for safe-area insets').toContain('viewport-fit=cover')

    const touchIcon = await request.get(`${BASE}/icons/apple-touch-icon.png`)
    expect(touchIcon.status()).toBe(200)
    expect(touchIcon.headers()['content-type']).toContain('image/png')
  })

  test('the service worker is served, registers and controls the page', async ({ page, request }) => {
    const sw = await request.get(`${BASE}/sw.js`)
    expect(sw.status()).toBe(200)
    expect(sw.headers()['content-type']).toContain('javascript')

    await gotoApp(page, `${BASE}/`)
    await completeOnboarding(page)

    // `serviceWorker.ready` resolves as soon as there *is* an active worker,
    // which can still be in "activating". Poll for the state that matters.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration()
            return registration?.active?.state ?? 'none'
          }),
        { timeout: 30_000, message: 'service worker never reached "activated"' },
      )
      .toBe('activated')

    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      return {
        scope: registration.scope,
        active: registration.active?.state ?? null,
        controlled: !!navigator.serviceWorker.controller,
        script: registration.active?.scriptURL ?? null,
      }
    })

    expect(state.active).toBe('activated')
    expect(state.scope).toBe(`${BASE}/`)
    expect(state.script).toContain('/sw.js')

    // The precache must actually hold the shell, or "installable" is a lie the
    // moment the user is on a train.
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys()
      let total = 0
      for (const key of keys) {
        total += (await (await caches.open(key)).keys()).length
      }
      return { buckets: keys.length, entries: total }
    })
    expect(cached.buckets).toBeGreaterThan(0)
    expect(cached.entries).toBeGreaterThan(5)
  })

  test('deep links resolve through the SPA rewrite', async ({ request }) => {
    for (const path of ['/timeline', '/settings', '/photo/abc123']) {
      const response = await request.get(`${BASE}${path}`)
      expect(response.status(), `${path} should serve the app shell`).toBe(200)
      expect(response.headers()['content-type']).toContain('text/html')
    }
  })

  test('the real deployment captures a photo end to end', async ({ page }) => {
    await gotoApp(page, `${BASE}/`)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const before = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('open failed'))
      })
      const n = await new Promise<number>((res, rej) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').count()
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('count failed'))
      })
      db.close()
      return n
    })

    await page.getByTestId('shutter').click()
    await expect(page.getByTestId('toast')).toContainText('Saved')
    await expect(page.getByTestId('ghost-image')).toBeVisible()

    await page.reload()
    await completeOnboarding(page)
    await expect(page.getByTestId('ghost-image')).toBeVisible()

    await shot(page, `production-capture-${test.info().project.name}.png`)
    expect(before).toBe(0)
  })

  test('production ships no secret', async ({ page, request }) => {
    await gotoApp(page, `${BASE}/`)
    const assets = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((el) => (el as HTMLScriptElement).src),
    )
    expect(assets.length).toBeGreaterThan(0)

    const forbidden = [/postgres(?:ql)?:\/\//i, /npg_[A-Za-z0-9]{8,}/, /neondb_owner/i, /neon\.tech/i]
    const offenders: string[] = []
    for (const url of [...assets, `${BASE}/sw.js`, `${BASE}/`]) {
      const body = await (await request.get(url)).text()
      for (const pattern of forbidden) {
        if (pattern.test(body)) offenders.push(`${url} matches ${pattern.source}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
