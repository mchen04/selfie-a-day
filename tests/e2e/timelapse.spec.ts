import { expect, test } from '@playwright/test'
import { ensureSignedIn } from '../e2e-support/helpers.ts'
import { seedPhoto } from '../e2e-support/api.ts'

test('server masters play and export as a video', async ({ page }) => {
  await page.goto('/')
  await ensureSignedIn(page)
  await seedPhoto(page, '2026-08-08')
  await seedPhoto(page, '2026-08-09')
  await page.goto('/timeline')
  await expect(page.getByTestId('timeline-cell')).toHaveCount(2)
  await page.getByTestId('play-timelapse').click()
  await expect(page.getByTestId('playback-frame')).toBeVisible()
  await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }))
  const downloaded = page.waitForEvent('download')
  await page.getByTestId('playback-export').click()
  expect((await downloaded).suggestedFilename()).toMatch(/timelapse.*\.(webm|mp4)$/)
  await page.getByTestId('playback-close').click()
  await expect(page.getByTestId('timeline-screen')).toBeVisible()
})

test('video export can be cancelled while a master is loading', async ({ page }) => {
  await page.goto('/')
  await ensureSignedIn(page)
  await seedPhoto(page, '2026-08-08')
  await seedPhoto(page, '2026-08-09')
  await page.goto('/timeline')
  await page.getByTestId('play-timelapse').click()
  await expect(page.getByTestId('playback-frame')).toBeVisible()
  await page.route('**/api/photos/*/master', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.continue().catch(() => undefined)
  })
  await page.getByTestId('playback-export').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('playback-export')).toHaveText('Export video')
})

test('date ranges and date labels work with synced photos', async ({ page }) => {
  await page.goto('/')
  await ensureSignedIn(page)
  for (const day of ['2025-08-09', '2026-06-08', '2026-08-08', '2026-08-09']) await seedPhoto(page, day)
  await page.goto('/timeline')
  await page.getByTestId('play-timelapse').click()
  await page.getByTestId('playback-options').click()
  await page.getByTestId('playback-range').selectOption('30-days')
  await expect(page.getByText('2 photos selected')).toBeVisible()
  await page.getByTestId('playback-show-dates').click()
  await page.getByTestId('playback-options-sheet').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('playback-date')).toBeVisible()
  await expect(page.getByTestId('playback-summary')).toContainText('2 frames')
})
