import { expect, test } from '@playwright/test'
import {
  captureOnce,
  completeOnboarding,
  countPhotos,
  gotoApp,
  listStoredPhotos,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'

async function trashCurrentPhoto(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('nav-timeline').click()
  await page.getByTestId('timeline-cell').click()
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('delete-confirm')).toBeVisible()
  await page.getByTestId('photo-delete').click()
  await expect(page.getByTestId('timeline-screen')).toBeVisible()
}

test.describe('reversible trash', () => {
  test('a removed photo can be undone immediately or restored from Trash', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const id = await captureOnce(page)

    await trashCurrentPhoto(page)
    expect(await countPhotos(page)).toBe(0)
    expect(await listStoredPhotos(page, { includeDeleted: true })).toMatchObject([
      { id, deletedAt: expect.any(Number) },
    ])
    await expect(page.getByTestId('undo-trash')).toContainText('Photo moved to Trash')

    await page.getByTestId('undo-trash-action').click()
    await expect(page.getByTestId('undo-trash')).toHaveCount(0)
    expect(await countPhotos(page)).toBe(1)
    await expect(page.getByTestId('timeline-cell')).toHaveCount(1)

    await page.getByTestId('timeline-cell').click()
    await page.getByTestId('photo-delete').click()
    await expect(page.getByTestId('delete-confirm')).toBeVisible()
    await page.getByTestId('photo-delete').click()
    await expect(page.getByTestId('timeline-screen')).toBeVisible()
    await page.goto('/settings')
    await page.getByTestId('review-trash').click()
    await expect(page.getByTestId('trash-item')).toHaveCount(1)
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect(page.getByTestId('trash-empty')).toBeVisible()
    expect(await countPhotos(page)).toBe(1)
  })

  test('permanent deletion removes the retained pixels', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const id = await captureOnce(page)
    await trashCurrentPhoto(page)

    await page.goto('/trash')
    const remove = page.getByTestId('trash-delete-permanently')
    await remove.click()
    await expect(remove).toContainText('Delete forever?')
    await remove.click()
    await expect(page.getByTestId('trash-empty')).toBeVisible()
    expect(await listStoredPhotos(page, { includeDeleted: true })).toHaveLength(0)

    const master = await page.evaluate(async (photoId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('selfie-a-day')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      })
      const row = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('masters', 'readonly').objectStore('masters').get(photoId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      })
      db.close()
      return row ?? null
    }, id)
    expect(master).toBeNull()
  })
})
