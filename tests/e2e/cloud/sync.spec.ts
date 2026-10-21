import { expect, test } from '@playwright/test'
import { captureOnce, completeOnboarding, listStoredPhotos, waitForCameraLive } from '../../e2e-support/helpers.ts'
import { createAccount, seedPhoto, signIn, snapshot, syncPage } from '../../e2e-support/api.ts'

test('a second device sees uploads and retakes replace the day on both devices', async ({ page, browser }) => {
  const account = await createAccount(page.request)
  await page.goto('/')
  await waitForCameraLive(page)
  const secondContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4319' })
  try {
    const second = await secondContext.newPage()
    await signIn(second, account)
    await second.goto('/timeline')
    const first = await captureOnce(page)
    await syncPage(second)
    await expect(second.getByTestId('timeline-cell')).toHaveCount(1)
    await expect.poll(async () => (await listStoredPhotos(second))[0]?.id).toBe(first)
    const retake = await captureOnce(page)
    await syncPage(second)
    await expect.poll(async () => (await listStoredPhotos(second))[0]?.id).toBe(retake)
    expect((await snapshot(page.request)).photos.find((photo) => photo.id === first)?.deletedAt).not.toBeNull()
    await expect(second.getByTestId('timeline-cell')).toHaveCount(1)
    await second.goto('/trash')
    await expect(second.getByTestId('trash-item')).toHaveCount(1)
  } finally { await secondContext.close() }
})

test('another account sees neither the timeline nor a guessed photo URL', async ({ page, browser }) => {
  await createAccount(page.request)
  await page.goto('/')
  const own = await seedPhoto(page, '2026-08-09')
  const secondContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4319' })
  try {
    const second = await secondContext.newPage()
    await createAccount(second.request)
    await second.goto('/timeline')
    await expect(second.getByTestId('timeline-empty')).toBeVisible()
    await second.goto(`/photo/${own.id}`)
    await expect(second.getByTestId('photo-missing')).toBeVisible()
    expect((await second.request.get(`/api/photos/${own.id}/master`)).status()).toBe(404)
  } finally { await secondContext.close() }
})

test('an offline capture queues locally and uploads after reconnect', async ({ page, context }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await waitForCameraLive(page)
  await context.setOffline(true)
  const id = await captureOnce(page)
  await expect(page.getByTestId('cloud-status')).toContainText('1 photo to upload · Waiting for a connection.')
  await context.setOffline(false)
  await expect.poll(async () => (await snapshot(page.request)).photos.some((photo) => photo.id === id), { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('selfie-a-day'); request.onsuccess = () => resolve(request.result) })
    const count = await new Promise<number>((resolve) => { const request = db.transaction('outbox').objectStore('outbox').count(); request.onsuccess = () => resolve(request.result) })
    db.close(); return count
  })).toBe(0)
})

test('logout warns once about pending photos and clears local account data', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await waitForCameraLive(page)
  await page.route('**/api/photos/*', async (route) => {
    if (route.request().method() === 'PUT') await route.abort()
    else await route.continue()
  })
  await captureOnce(page, false)
  await page.getByTestId('nav-settings').click()
  let dialogs = 0
  page.on('dialog', async (dialog) => { dialogs++; expect(dialog.message()).toContain('deletes them'); await dialog.accept() })
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('account-screen')).toBeVisible()
  expect(dialogs).toBe(1)
  expect(await listStoredPhotos(page)).toHaveLength(0)
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('selfie-a-day'); request.onsuccess = () => resolve(request.result) })
    const counts = await Promise.all(['kv', 'outbox', 'ghosts'].map((name) => new Promise<number>((resolve) => { const request = db.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result) })))
    db.close(); return counts
  })).toEqual([0, 0, 0])
})

test('an expired session keeps an offline capture until the same account signs back in', async ({ page, context }) => {
  const account = await createAccount(page.request)
  await page.goto('/')
  await waitForCameraLive(page)
  await page.route('**/api/photos/*', async (route) => {
    if (route.request().method() === 'PUT') await route.abort()
    else await route.continue()
  })
  const id = await captureOnce(page, false)
  await context.clearCookies()
  await syncPage(page)
  await expect(page.getByTestId('account-screen')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('account-screen')).toBeVisible()
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('selfie-a-day'); request.onsuccess = () => resolve(request.result) })
    const count = await new Promise<number>((resolve) => { const request = db.transaction('outbox').objectStore('outbox').count(); request.onsuccess = () => resolve(request.result) })
    db.close(); return count
  })).toBe(1)
  await page.unroute('**/api/photos/*')
  await signIn(page, account)
  await expect.poll(async () => (await snapshot(page.request)).photos.some((photo) => photo.id === id), { timeout: 30_000 }).toBe(true)
})
