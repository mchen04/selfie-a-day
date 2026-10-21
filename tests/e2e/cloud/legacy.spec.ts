import { expect, test } from '@playwright/test'

test('opening a v2 installation removes its legacy photo stores', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded-v2')) return
    sessionStorage.setItem('seeded-v2', '1')
    const request = indexedDB.open('selfie-a-day', 2)
    request.onupgradeneeded = () => {
      for (const name of ['photos', 'masters', 'thumbs', 'albums', 'meta']) request.result.createObjectStore(name)
      request.transaction!.objectStore('masters').put(new ArrayBuffer(16), 'synthetic-old-photo')
    }
    request.onsuccess = () => request.result.close()
  })
  await page.goto('/')
  await expect(page.getByTestId('account-screen')).toBeVisible()
  const stores = await page.evaluate(async () => {
    const request = indexedDB.open('selfie-a-day')
    return new Promise<string[]>((resolve) => { request.onsuccess = () => { const stores = Array.from(request.result.objectStoreNames); request.result.close(); resolve(stores) } })
  })
  expect(stores).toEqual(['ghosts', 'kv', 'outbox'])
})
