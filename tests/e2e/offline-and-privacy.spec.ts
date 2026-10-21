import { expect, test } from '@playwright/test'
import { captureOnce, completeOnboarding, waitForCameraLive, waitForOfflineReady } from '../e2e-support/helpers.ts'

test('cached account and metadata open offline without caching API responses in the service worker', async ({ page, context }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await waitForCameraLive(page)
  await captureOnce(page)
  await waitForOfflineReady(page)
  await context.setOffline(true)
  const reopened = await page.reload()
  expect(reopened?.fromServiceWorker()).toBe(true)
  await expect(page.getByTestId('capture-screen')).toBeVisible()
  await expect(page.getByTestId('ghost-image')).toBeVisible()
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated')
  const apiCacheEntries = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) if (new URL(request.url).pathname.startsWith('/api/')) urls.push(request.url)
    return urls
  })
  expect(apiCacheEntries).toEqual([])
  await context.setOffline(false)
})
