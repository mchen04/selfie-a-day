import { expect, test } from '@playwright/test'
import { captureOnce, completeOnboarding, listStoredPhotos, waitForCameraLive } from '../e2e-support/helpers.ts'
import { snapshot } from '../e2e-support/api.ts'

test('server albums keep separate daily photos and save their name and zone', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await waitForCameraLive(page)
  await captureOnce(page)
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-album-picker').click()
  await page.getByTestId('new-album').click()
  await page.getByTestId('new-album-name').fill('Training')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('album-picker')).toHaveCount(0)
  await page.getByTestId('album-name').fill('Progress')
  await page.getByTestId('album-timezone').selectOption('America/New_York')
  await page.getByTestId('save-album').click()
  await expect.poll(async () => (await snapshot(page.request)).albums.find((album) => album.name === 'Progress')?.timeZone).toBe('America/New_York')
  await page.getByTestId('settings-back').click()
  await waitForCameraLive(page)
  await captureOnce(page)
  expect(new Set((await listStoredPhotos(page)).map((photo) => photo.albumId)).size).toBe(2)
  await page.reload()
  await expect(page.getByTestId('capture-screen')).toContainText('Progress')
})
