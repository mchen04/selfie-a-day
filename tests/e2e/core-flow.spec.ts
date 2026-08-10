import { expect, test } from '@playwright/test'
import {
  captureOnce,
  completeOnboarding,
  gotoApp,
  listStoredPhotos,
  shot,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'

/**
 * Gate 3 walked end to end in a real browser:
 * permission -> live preview with grid and ghost -> capture -> cold restart ->
 * that photo is now the ghost.
 */
test.describe('core flow', () => {
  test('first run: onboarding, permission, live preview with guides', async ({ page }) => {
    await gotoApp(page)

    await expect(page.getByTestId('onboarding-screen')).toBeVisible()
    await shot(page, `core-1-onboarding-${test.info().project.name}.png`)

    // The camera is not touched before the user asks for it.
    await expect(page.getByTestId('capture-screen')).toHaveCount(0)

    await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('capture-screen')).toBeVisible()
    await waitForCameraLive(page)

    // Guides are on by default; the ghost cannot exist yet on day one.
    await expect(page.locator('.frame__grid')).toBeVisible()
    await expect(page.getByTestId('ghost-image')).toHaveCount(0)
    await expect(page.getByTestId('ghost-toggle')).toBeDisabled()
    await expect(page.getByTestId('streak-label')).toHaveText('Day one')

    await shot(page, `core-2-live-preview-day-one-${test.info().project.name}.png`)
  })

  test('capture, cold restart, and the photo is now the ghost', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const id = await captureOnce(page)
    await expect(page.getByTestId('toast')).toContainText('Saved')
    await shot(page, `core-3-after-capture-${test.info().project.name}.png`)

    // A full reload: new document, new JS context, storage read from disk.
    await page.reload()
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const ghost = page.getByTestId('ghost-image')
    await expect(ghost).toBeVisible()
    // The ghost here is today's own photo (a same-day retake), so the hint says
    // so rather than telling the user to line up with "today".
    await expect(page.getByTestId('ghost-hint')).toContainText("Lined up with today's photo")

    // The ghost is derived from the actual latest capture, not from a cache:
    // its bytes must equal the stored master for that id.
    const matches = await page.evaluate(async (photoId) => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="ghost-image"]')
      if (!img) return { ok: false, reason: 'no ghost element' }

      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('IndexedDB request failed'))
      })
      const stored = await new Promise<{ bytes: ArrayBuffer }>((res, rej) => {
        const req = db.transaction('masters', 'readonly').objectStore('masters').get(photoId)
        req.onsuccess = () => res(req.result as { bytes: ArrayBuffer })
        req.onerror = () => rej(req.error ?? new Error('IndexedDB request failed'))
      })
      db.close()

      const shown = await (await fetch(img.src)).arrayBuffer()
      if (shown.byteLength !== stored.bytes.byteLength) {
        return { ok: false, reason: `size ${shown.byteLength} vs ${stored.bytes.byteLength}` }
      }
      const a = new Uint8Array(shown)
      const b = new Uint8Array(stored.bytes)
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return { ok: false, reason: `byte ${i} differs` }
      }
      return { ok: true, reason: 'identical', bytes: a.length }
    }, id)

    expect(matches.ok, `ghost pixels should equal the stored master: ${matches.reason}`).toBe(true)

    await shot(page, `core-4-ghost-after-cold-restart-${test.info().project.name}.png`)
  })

  test('the ghost is adjustable and dismissible without leaving the camera', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    const ghost = page.getByTestId('ghost-image')
    await expect(ghost).toBeVisible()

    // The failure this app exists to kill is a ghost that is hard to see and
    // hard to change. Both controls sit on the capture screen itself.
    await page.getByTestId('ghost-opacity').fill('90')
    await expect(ghost).toHaveAttribute('style', /opacity:\s*0\.9/)
    await page.getByTestId('ghost-opacity').fill('15')
    await expect(ghost).toHaveAttribute('style', /opacity:\s*0\.15/)

    await page.getByTestId('ghost-toggle').click()
    await expect(ghost).toHaveCount(0)
    await page.getByTestId('ghost-toggle').click()
    await expect(page.getByTestId('ghost-image')).toBeVisible()

    // Grid cycles through its three states in place.
    const grid = page.getByTestId('grid-toggle')
    await expect(grid).toHaveAttribute('data-grid', 'thirds')
    await grid.click()
    await expect(grid).toHaveAttribute('data-grid', 'crosshair')
    await grid.click()
    await expect(grid).toHaveAttribute('data-grid', 'off')
    await expect(page.locator('.frame__grid')).toHaveCount(0)
  })

  test('timeline, single photo, and timelapse playback', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    // Backdate the capture so a second one lands on a different day.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('IndexedDB request failed'))
      })
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('photos', 'readwrite')
        const store = tx.objectStore('photos')
        const all = store.getAll()
        all.onsuccess = () => {
          for (const meta of all.result as { dayKey: string; capturedAt: number }[]) {
            meta.dayKey = '2026-01-02'
            meta.capturedAt -= 86_400_000 * 30
            store.put(meta)
          }
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error ?? new Error('IndexedDB transaction failed'))
      })
      db.close()
    })
    await page.reload()
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('2 photos')
    await expect(page.getByTestId('timeline-cell')).toHaveCount(2)
    await shot(page, `core-5-timeline-${test.info().project.name}.png`)

    await page.getByTestId('play-timelapse').click()
    await expect(page.getByTestId('playback')).toBeVisible()
    await expect(page.getByTestId('playback-frame')).toBeVisible()
    await expect(page.getByTestId('playback-position')).toContainText('of 2')
    await shot(page, `core-6-timelapse-${test.info().project.name}.png`)
    await page.getByTestId('playback-close').click()

    await page.getByTestId('timeline-cell').first().click()
    await expect(page.getByTestId('photo-screen')).toBeVisible()
    await expect(page.getByTestId('photo-image')).toBeVisible()
    await shot(page, `core-7-single-photo-${test.info().project.name}.png`)

    const stored = await listStoredPhotos(page)
    expect(stored).toHaveLength(2)
  })
})
