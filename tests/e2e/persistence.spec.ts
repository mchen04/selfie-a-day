import { expect, test } from '@playwright/test'
import { completeOnboarding } from '../e2e-support/helpers.ts'
import { seedPhoto } from '../e2e-support/api.ts'
import { readFile } from 'node:fs/promises'
import { readZip } from '../../src/storage/zip.ts'

test('a fresh page loads server photos and downloads a normal ZIP', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  const first = await seedPhoto(page, '2026-08-08')
  const second = await seedPhoto(page, '2026-08-09')
  await page.goto('/timeline')
  await expect(page.getByTestId('timeline-cell')).toHaveCount(2)
  await page.reload()
  await expect(page.getByTestId('timeline-cell')).toHaveCount(2)
  await page.goto('/settings')
  await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }))
  const downloaded = page.waitForEvent('download')
  await page.getByTestId('download-photos').click()
  const file = await downloaded
  expect(file.suggestedFilename()).toMatch(/^selfie-a-day-\d{4}-\d{2}-\d{2}\.zip$/)
  const bytes = new Uint8Array(await readFile((await file.path())))
  const archive = readZip(bytes)
  expect([...archive.keys()].some((name) => name.includes(first.id))).toBe(true)
  expect([...archive.keys()].some((name) => name.includes(second.id))).toBe(true)
  expect(archive.size).toBe(2)
})
