import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createAccount, mutationHeaders } from '../../e2e-support/api.ts'

test('a cookie-only session reaches capture without showing the account form', async ({ page, context }) => {
  await createAccount(page.request)
  expect((await context.cookies()).some((cookie) => ['sad_hint', '__Host-sad_hint'].includes(cookie.name) && cookie.value === '1')).toBe(true)
  await page.addInitScript(() => {
    const selector = '[data-testid="account-screen"]'
    new MutationObserver((records) => {
      for (const record of records) for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) {
          sessionStorage.setItem('account-form-seen', '1')
        }
      }
    }).observe(document, { childList: true, subtree: true })
  })
  let release: (() => void) | undefined
  const validation = new Promise<void>((resolve) => { release = resolve })
  let checks = 0
  await page.route('**/api/auth/me', async (route) => {
    checks++
    await validation
    await route.continue()
  })
  try {
    await page.goto('/')
    await expect.poll(() => checks).toBe(1)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => { requestAnimationFrame(() => resolve()) })))
    await expect(page.getByTestId('boot')).toBeVisible()
    await expect(page.getByTestId('account-screen')).toHaveCount(0)
  } finally { release!() }
  await expect(page.getByTestId('capture-screen')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('account-form-seen'))).toBeNull()
  expect(checks).toBe(1)
})

test('create an account, log out, and sign in with the same account', async ({ page }) => {
  const username = `ui-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const password = randomUUID() + randomUUID()
  await page.goto('/')
  await expect(page.getByTestId('account-screen')).toBeVisible()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByTestId('account-submit').click()
  await expect(page.getByTestId('capture-screen')).toBeVisible()
  await page.getByTestId('nav-settings').click()
  await expect(page.getByRole('heading', { name: username })).toBeVisible()
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('account-screen')).toBeVisible()
  await page.getByRole('button', { name: 'Have an account? Sign in' }).click()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByTestId('account-submit').click()
  // Signing in opens the camera, not the Settings screen logout was tapped on.
  await expect(page.getByTestId('capture-screen')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  await page.getByTestId('nav-settings').click()
  await expect(page.getByRole('heading', { name: username })).toBeVisible()
})

test('incorrect passwords stay inline and preserve the username', async ({ page }) => {
  const account = await createAccount(page.request)
  await page.request.post('/api/auth/logout', { headers: mutationHeaders() })
  await page.goto('/')
  await page.getByRole('button', { name: 'Have an account? Sign in' }).click()
  await page.getByLabel('Username', { exact: true }).fill(account.username)
  await page.getByLabel('Password', { exact: true }).fill(randomUUID())
  await page.getByTestId('account-submit').click()
  await expect(page.getByRole('alert')).toContainText('incorrect')
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue(account.username)
  await expect(page.getByTestId('account-screen')).toBeVisible()
})
