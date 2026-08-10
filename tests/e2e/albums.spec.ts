import { expect, test } from '@playwright/test'
import {
  captureOnce,
  completeOnboarding,
  delayCanvasEncoding,
  gotoApp,
  listStoredPhotos,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'

test.describe('albums and calendar days', () => {
  test('the album picker traps focus and restores it to its trigger', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)

    const trigger = page.getByTestId('active-album-picker')
    await trigger.click()
    const picker = page.getByRole('dialog', { name: 'Choose album' })
    await expect(picker.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    expect(
      await page.getByTestId('album-picker').evaluate((layer) =>
        Array.from(layer.parentElement!.children)
          .filter((child) => child !== layer)
          .every((child) => (child as HTMLElement).inert),
      ),
    ).toBe(true)

    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab')
      expect(await picker.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })

  test('same-day captures stay separate and the chosen album survives reload', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    await captureOnce(page)
    const first = (await listStoredPhotos(page))[0]!
    expect(first.albumId).toBe('selfies')
    expect(first.timeZone).toBe(
      await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    )

    await page.getByTestId('active-album-picker').click()
    await page.getByTestId('new-album').click()
    await page.getByTestId('new-album-name').fill('Physique')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('active-album-picker')).toContainText('Physique')

    await page.reload()
    await completeOnboarding(page)
    await expect(page.getByTestId('active-album-picker')).toContainText('Physique')
    await waitForCameraLive(page)
    await captureOnce(page)

    const photos = await listStoredPhotos(page)
    expect(photos).toHaveLength(2)
    expect(new Set(photos.map((photo) => photo.albumId)).size).toBe(2)
    expect(new Set(photos.map((photo) => photo.dayKey)).size).toBe(1)

    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    await page.getByTestId('timeline-album-picker').click()
    await page.getByTestId('album-option').filter({ hasText: 'Selfies' }).click()
    await expect(page.getByTestId('timeline-count')).toHaveText('1 photo')
    await expect(page.getByTestId('timeline-album-picker')).toContainText('Selfies')
  })

  test('an open capture screen rolls over at midnight without a reload', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-10T06:59:40Z') })
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    await captureOnce(page)
    await expect(page.getByTestId('today-status')).toHaveText('Today saved')

    await page.clock.runFor(60_000)
    await expect(page.getByTestId('today-status')).toHaveText('Today')
    await expect(page.getByTestId('streak-label')).toHaveText('1 day in a row')

    await captureOnce(page)
    const photos = await listStoredPhotos(page)
    expect(photos.map((photo) => photo.dayKey).sort()).toEqual(['2026-08-09', '2026-08-10'])
  })

  test('a capture keeps the shutter instant when encoding crosses midnight', async ({ page }) => {
    const shutterAt = new Date('2026-08-10T06:59:59.500Z')
    await page.clock.install({ time: shutterAt })
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    await delayCanvasEncoding(page, 1_000)

    await page.getByTestId('shutter').click()
    await page.clock.runFor(2_000)
    await expect.poll(async () => (await listStoredPhotos(page)).length).toBe(1)

    const [photo] = await listStoredPhotos(page)
    expect(photo?.dayKey).toBe('2026-08-09')
    expect(photo?.capturedAt).toBeGreaterThanOrEqual(shutterAt.getTime())
    expect(photo?.capturedAt).toBeLessThan(Date.parse('2026-08-10T07:00:00Z'))
  })

  test('an album timezone override controls its day boundary', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-09T16:30:00Z') })
    await gotoApp(page)
    await completeOnboarding(page)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('album-timezone-select').selectOption('Asia/Tokyo')
    await page.getByTestId('save-album-settings').click()
    await expect(page.getByTestId('toast')).toContainText('Album settings saved')

    await page.getByTestId('settings-back').click()
    await waitForCameraLive(page)
    await captureOnce(page)

    const photo = (await listStoredPhotos(page))[0]!
    expect(photo.timeZone).toBe('Asia/Tokyo')
    expect(photo.dayKey).toBe('2026-08-10')
  })

  test('returning to an earlier local day still recognizes its saved photo', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-10T18:00:00Z') })
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const currentId = await captureOnce(page)

    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('selfie-a-day')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      })
      const read = db.transaction(['photos', 'masters', 'thumbs'], 'readonly')
      const request = <T,>(value: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          value.onsuccess = () => resolve(value.result)
          value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'))
        })
      const photoRequest = read.objectStore('photos').get(id) as IDBRequest<
        Record<string, unknown> & { capturedAt: number }
      >
      const masterRequest = read.objectStore('masters').get(id) as IDBRequest<
        Record<string, unknown>
      >
      const thumbRequest = read.objectStore('thumbs').get(id) as IDBRequest<
        Record<string, unknown>
      >
      const [meta, master, thumb] = await Promise.all([
        request(photoRequest),
        request(masterRequest),
        request(thumbRequest),
      ])
      const futureId = 'future-local-day'
      const write = db.transaction(['photos', 'masters', 'thumbs'], 'readwrite')
      write.objectStore('photos').put({
        ...meta,
        id: futureId,
        dayKey: '2026-08-11',
        capturedAt: meta.capturedAt + 86_400_000,
      })
      write.objectStore('masters').put({ ...master, id: futureId })
      write.objectStore('thumbs').put({ ...thumb, id: futureId })
      await new Promise<void>((resolve, reject) => {
        write.oncomplete = () => resolve()
        write.onerror = () => reject(write.error ?? new Error('IndexedDB write failed'))
      })
      db.close()
    }, currentId)

    await page.reload()
    await completeOnboarding(page)
    await expect(page.getByTestId('today-status')).toHaveText('Today saved')
    await expect(page.getByTestId('shutter')).toHaveAttribute('aria-label', "Retake today's photo")
  })
})
