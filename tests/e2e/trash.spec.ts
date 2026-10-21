import { expect, test } from '@playwright/test'
import { completeOnboarding } from '../e2e-support/helpers.ts'
import { seedPhoto, snapshot } from '../e2e-support/api.ts'

test('trash, undo, restore, and permanently delete a server photo', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  const photo = await seedPhoto(page, '2026-08-09')
  await page.goto(`/photo/${photo.id}`)
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('undo-trash')).toBeVisible()
  await page.getByTestId('undo-trash-action').click()
  await expect.poll(async () => (await snapshot(page.request)).photos[0]?.deletedAt).toBeNull()
  await page.goto(`/photo/${photo.id}`)
  await page.getByTestId('photo-delete').click()
  await expect.poll(async () => (await snapshot(page.request)).photos[0]?.deletedAt).not.toBeNull()
  await page.goto('/trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(1)
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  await page.goto(`/photo/${photo.id}`)
  await page.getByTestId('photo-delete').click()
  await expect.poll(async () => (await snapshot(page.request)).photos[0]?.deletedAt).not.toBeNull()
  await page.goto('/trash')
  await page.getByTestId('trash-delete-permanently').click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  expect((await page.request.get(`/api/photos/${photo.id}/master`)).status()).toBe(404)
})
