import { expect, test } from '@playwright/test'
import { captureOnce, ensureSignedIn, gotoApp, waitForCameraLive } from '../e2e-support/helpers.ts'

test('save a photo, browse it, and return to its ghost', async ({ page }) => {
  await gotoApp(page)
  await ensureSignedIn(page)
  await waitForCameraLive(page)
  const id = await captureOnce(page)
  await expect(page.getByTestId('ghost-image')).toBeVisible()
  await page.getByTestId('nav-timeline').click()
  await expect(page.getByTestId('timeline-cell')).toHaveCount(1)
  await page.getByTestId('timeline-cell').click()
  await expect(page.getByTestId('photo-image')).toHaveAttribute('src', `/api/photos/${id}/master`)
  await expect.poll(() => page.getByTestId('photo-image').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.getByTestId('photo-back').click()
  await page.getByTestId('timeline-back').click()
  await expect(page.getByTestId('ghost-image')).toBeVisible()
})
