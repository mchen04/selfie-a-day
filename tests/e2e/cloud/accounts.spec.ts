import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createAccount, mutationHeaders } from '../../e2e-support/api.ts'

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
  await expect(page.getByTestId('settings-screen')).toBeVisible()
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
