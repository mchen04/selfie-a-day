import { expect, test } from '@playwright/test'
import { completeOnboarding } from '../../e2e-support/helpers.ts'

test('account and settings fit iPhone widths with usable controls', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('account-screen')).toBeVisible()
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const controls = await page.locator('.account input, .account button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
    expect(controls.every((height) => height >= 44)).toBe(true)
  }
  await completeOnboarding(page)
  await page.getByTestId('nav-settings').click()
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const overflow = await page.locator('.settings input, .settings select, .settings button').evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().right > innerWidth).length)
    expect(overflow).toBe(0)
  }
})
