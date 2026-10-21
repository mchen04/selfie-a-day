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
  await expect(page.getByTestId('trash-delete-permanently')).toHaveText('Delete forever?')
  await page.getByTestId('trash-delete-permanently').click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  expect((await page.request.get(`/api/photos/${photo.id}/master`)).status()).toBe(404)
})

test('Empty requires an inline second tap before deleting server photos', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  const photo = await seedPhoto(page, '2026-08-09')
  await page.goto(`/photo/${photo.id}`)
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('undo-trash')).toBeVisible()
  await page.goto('/trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(1)
  await page.getByTestId('empty-trash').click()
  await expect(page.getByTestId('empty-trash')).toHaveText('Confirm')
  expect((await snapshot(page.request)).photos).toHaveLength(1)
  await page.getByTestId('empty-trash').click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  expect((await snapshot(page.request)).photos).toEqual([])
})

test('a delayed restore stays visible until a full navigation can read the restored photo', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  const photo = await seedPhoto(page, '2026-08-09')
  await page.goto(`/photo/${photo.id}`)
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('undo-trash')).toBeVisible()
  await page.goto('/trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(1)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered: (() => void) | undefined
  const requested = new Promise<void>((resolve) => { entered = resolve })
  await page.route(`**/api/photos/${photo.id}`, async (route) => {
    if (route.request().method() === 'PATCH') { entered!(); await gate }
    await route.continue()
  })
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await requested
  try {
    await expect(page.getByTestId('trash-item')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled()
    await expect(page.getByTestId('trash-empty')).toHaveCount(0)
  } finally { release!() }
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  await page.goto(`/photo/${photo.id}`)
  await expect(page.getByTestId('photo-delete')).toBeVisible()
  await expect(page.getByTestId('photo-image')).toBeVisible()
  expect((await snapshot(page.request)).photos.find((item) => item.id === photo.id)?.deletedAt).toBeNull()
})
