import { expect, test } from '@playwright/test'
import {
  captureOnce,
  completeOnboarding,
  gotoApp,
  listStoredPhotos,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'

test.describe('albums and calendar days', () => {
  test('same-day captures stay separate and the chosen album survives reload', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    await captureOnce(page)
    const first = (await listStoredPhotos(page))[0]!
    expect(first.albumId).toBe('selfies')
    expect(first.timeZone).toBe(
      await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    )

    await page.getByTestId('active-album-picker').click()
    await page.getByTestId('new-album').click()
    await page.getByTestId('new-album-name').fill('Physique')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('active-album-picker')).toContainText('Physique')

    await page.reload()
    await completeOnboarding(page)
    await expect(page.getByTestId('active-album-picker')).toContainText('Physique')
    await waitForCameraLive(page)
    await captureOnce(page)

    const photos = await listStoredPhotos(page)
    expect(photos).toHaveLength(2)
    expect(new Set(photos.map((photo) => photo.albumId)).size).toBe(2)
    expect(new Set(photos.map((photo) => photo.dayKey)).size).toBe(1)

    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    await page.getByTestId('timeline-album-picker').click()
    await page.getByTestId('album-option').filter({ hasText: 'Selfies' }).click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    await expect(page.getByTestId('timeline-album-picker')).toContainText('Selfies')
  })

  test('an open capture screen rolls over at midnight without a reload', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-10T06:59:40Z') })
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    await captureOnce(page)
    await expect(page.getByTestId('today-status')).toHaveText('Today saved')

    await page.clock.runFor(60_000)
    await expect(page.getByTestId('today-status')).toHaveText('Today')
    await expect(page.getByTestId('streak-label')).toHaveText('1 day in a row')

    await captureOnce(page)
    const photos = await listStoredPhotos(page)
    expect(photos.map((photo) => photo.dayKey).sort()).toEqual(['2026-08-09', '2026-08-10'])
  })

  test('an album timezone override controls its day boundary', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-09T16:30:00Z') })
    await gotoApp(page)
    await completeOnboarding(page)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('album-timezone-select').selectOption('Asia/Tokyo')
    await page.getByTestId('save-album-settings').click()
    await expect(page.getByTestId('toast')).toContainText('Album settings saved')

    await page.getByTestId('settings-back').click()
    await waitForCameraLive(page)
    await captureOnce(page)

    const photo = (await listStoredPhotos(page))[0]!
    expect(photo.timeZone).toBe('Asia/Tokyo')
    expect(photo.dayKey).toBe('2026-08-10')
  })
})
