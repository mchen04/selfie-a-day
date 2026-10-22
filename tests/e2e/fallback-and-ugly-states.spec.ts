import { expect, test } from '@playwright/test'
import { completeOnboarding } from '../e2e-support/helpers.ts'
import { seedPhoto, snapshot } from '../e2e-support/api.ts'

test('failed optimistic trash restores the photo and shows an error', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  const photo = await seedPhoto(page, '2026-08-09')
  await page.goto(`/photo/${photo.id}`)
  await page.route(`**/api/photos/${photo.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) })
    else await route.continue()
  })
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('photo-image')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Could not complete' })).toBeVisible()
})

test('download failure clears progress and lets the user retry', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await seedPhoto(page, '2026-08-09')
  await seedPhoto(page, '2026-08-08')
  await page.goto('/settings')
  await page.route('**/api/photos/*/master', (route) => route.abort())
  await page.getByTestId('download-photos').click()
  await expect(page.getByTestId('download-photos')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
})

test('the file camera fallback compresses and uploads a picked image', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }))
  await page.goto('/')
  await completeOnboarding(page)
  await expect(page.getByTestId('shutter')).toHaveAttribute('data-mode', 'file')
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 300; canvas.height = 400
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#57ba9f'; ctx.fillRect(0, 0, 300, 400)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  await page.getByTestId('file-fallback-input').setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await expect.poll(async () => (await snapshot(page.request)).photos.length).toBe(1)
  const saved = (await snapshot(page.request)).photos[0]!
  expect(['image/jpeg', 'image/webp']).toContain(saved.mime)
  expect(saved.width / saved.height).toBeCloseTo(.75)
})
