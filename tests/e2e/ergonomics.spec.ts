import { expect, test } from '@playwright/test'
import { completeOnboarding, waitForCameraLive } from '../e2e-support/helpers.ts'

test('capture has no horizontal scroll and keeps the shutter reachable', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await waitForCameraLive(page)
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 })
    const shutter = await page.getByTestId('shutter').boundingBox()
    expect(shutter).not.toBeNull()
    expect(shutter!.width).toBeGreaterThanOrEqual(44)
    expect(shutter!.height).toBeGreaterThanOrEqual(44)
    expect(shutter!.y + shutter!.height).toBeLessThanOrEqual(740)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
