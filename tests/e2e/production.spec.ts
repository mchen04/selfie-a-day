import { expect, test } from '@playwright/test'
import { completeOnboarding } from '../e2e-support/helpers.ts'

const base = process.env.E2E_BASE_URL

test.skip(!base?.startsWith('https://'), 'Requires the deployed HTTPS app')
test('deployment serves the app shell, API, and security headers', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("img-src 'self' blob: data:")
  await completeOnboarding(page)
  const me = await page.request.get('/api/auth/me')
  expect(me.status()).toBe(200)
  expect(me.headers()['cache-control']).toContain('no-store')
  await page.goto('/settings')
  await expect(page.getByTestId('logout')).toBeVisible()
})
