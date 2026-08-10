import { expect, test } from '@playwright/test'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  captureOnce,
  completeOnboarding,
  countPhotos,
  evidencePath,
  gotoApp,
  listStoredPhotos,
  waitForCameraLive,
  waitForOfflineReady,
} from '../e2e-support/helpers.ts'

const SW_PATH = resolve(import.meta.dirname, '../../dist/sw.js')

/**
 * Gate 4: photos survive an app restart and a service-worker update, and the
 * whole set can be exported and restored.
 */
test.describe('durability', () => {
  test('photos survive a cold restart', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const id = await captureOnce(page)

    await page.reload()
    await completeOnboarding(page)

    expect(await countPhotos(page)).toBe(1)
    expect((await listStoredPhotos(page))[0]?.id).toBe(id)
  })

  test('photos survive a genuine service-worker update', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const id = await captureOnce(page)
    await waitForOfflineReady(page)

    const before = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      return { script: reg?.active?.scriptURL ?? null }
    })
    expect(before.script).toContain('sw.js')

    // Change the deployed worker's bytes for real, so the browser sees a
    // genuinely different script rather than a simulated one.
    const original = readFileSync(SW_PATH, 'utf8')
    try {
      appendFileSync(SW_PATH, `\n// build ${Date.now()}\n`)

      const updated = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg) return { installed: false, reason: 'no registration' }
        await reg.update()
        // Wait for a worker to appear in installing/waiting, then let it take over.
        const pending = await new Promise<ServiceWorker | null>((res) => {
          if (reg.waiting) return res(reg.waiting)
          if (reg.installing) return res(reg.installing)
          const timer = setTimeout(() => res(reg.waiting ?? reg.installing ?? null), 8000)
          reg.addEventListener('updatefound', () => {
            clearTimeout(timer)
            res(reg.installing)
          })
        })
        if (!pending) return { installed: false, reason: 'no new worker appeared' }

        await new Promise<void>((res) => {
          if (pending.state === 'installed' || pending.state === 'activated') return res()
          pending.addEventListener('statechange', () => {
            if (pending.state === 'installed' || pending.state === 'activated') res()
          })
        })

        // This is the message our own worker listens for when the user accepts
        // an update; nothing here touches IndexedDB. Wait for the handover to
        // finish before reloading — clientsClaim() changes the controller, and
        // reloading into that transition aborts the navigation.
        let handedOver = false
        const handover = new Promise<void>((res) => {
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              handedOver = true
              res()
            },
            { once: true },
          )
          setTimeout(res, 8000)
        })
        pending.postMessage({ type: 'SKIP_WAITING' })
        await handover
        return { installed: true, handedOver, reason: pending.state }
      })

      expect(updated.installed, `service worker did not update: ${updated.reason}`).toBe(true)

      /**
       * The handover must actually happen.
       *
       * Polling `registration.active.state === 'activated'` looks like this
       * check but is vacuous: the OLD worker is already activated, so it is
       * satisfied whether or not anything took over. `controllerchange` fires
       * only when a different worker assumes control, which is the event a user
       * would actually experience.
       */
      expect(
        updated.handedOver,
        'the replacement worker never took control (no controllerchange)',
      ).toBe(true)

      // Additionally purge every Cache Storage bucket — a harsher version of
      // what an update can do — to show photo data is in a different place.
      const cachesCleared = await page.evaluate(async () => {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
        return keys.length
      })
      expect(cachesCleared).toBeGreaterThan(0)

      await page.reload()
      await completeOnboarding(page)

      expect(await countPhotos(page)).toBe(1)
      expect((await listStoredPhotos(page))[0]?.id).toBe(id)

      // Check again after the worker has had time to finish anything it queued.
      // A destroy inside `event.waitUntil(...)` lands after the first reload, and
      // a single early check reported success three times in a row while photos
      // were in fact being destroyed — demonstrated by a fresh-eyes verifier.
      await page.waitForTimeout(1500)
      await page.reload()
      await completeOnboarding(page)
      expect(await countPhotos(page), 'photos disappeared after the worker settled').toBe(1)
      expect((await listStoredPhotos(page))[0]?.id).toBe(id)
    } finally {
      writeFileSync(SW_PATH, original)
    }
  })

  test('export produces a real zip and import restores every photo', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    const originals = await listStoredPhotos(page)
    expect(originals).toHaveLength(1)

    await page.getByTestId('nav-settings').click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('export-backup').click()
    const download = await downloadPromise

    const zipPath = evidencePath(`backup-${test.info().project.name}.zip`)
    await download.saveAs(zipPath)
    expect(download.suggestedFilename()).toMatch(/^selfie-a-day-backup-\d{4}-\d{2}-\d{2}\.zip$/)

    // A real ZIP: the local file header signature, readable by any unzip tool.
    const bytes = readFileSync(zipPath)
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(bytes.length).toBeGreaterThan(1000)

    // Wipe the device, then restore from that exact file.
    await page.getByTestId('delete-all').click()
    await page.getByTestId('delete-all').click()
    await expect.poll(async () => await countPhotos(page)).toBe(0)

    await page.getByTestId('import-input').setInputFiles(zipPath)
    await expect(page.getByTestId('toast')).toContainText('Restored 1 photo')
    await expect.poll(async () => await countPhotos(page)).toBe(1)

    const restored = await listStoredPhotos(page)
    expect(restored[0]?.dayKey).toBe(originals[0]!.dayKey)
    expect(restored[0]?.width).toBe(originals[0]!.width)
    expect(restored[0]?.height).toBe(originals[0]!.height)
    expect(restored[0]?.mirrored).toBe(originals[0]!.mirrored)
    expect(restored[0]?.masterBytes).toBe(originals[0]!.masterBytes)
  })

  test('a 200-photo timeline stays responsive and lazily loads thumbnails', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)

    // Seed directly: 200 real captures would take minutes and prove less.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('IndexedDB request failed'))
      })

      // A tiny valid image, reused for every seeded row.
      const canvas = document.createElement('canvas')
      canvas.width = 60
      canvas.height = 80
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#4a8'
      ctx.fillRect(0, 0, 60, 80)
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.7))
      const bytes = await blob.arrayBuffer()

      await new Promise<void>((res, rej) => {
        const tx = db.transaction(['photos', 'thumbs', 'masters'], 'readwrite')
        const base = Date.parse('2025-01-01T09:00:00Z')
        for (let i = 0; i < 200; i++) {
          const at = base + i * 86_400_000
          const d = new Date(at)
          const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          const id = `${at.toString(36).padStart(10, '0')}seed${String(i).padStart(6, '0')}`
          tx.objectStore('photos').put({
            id,
            dayKey,
            capturedAt: at,
            tzOffsetMinutes: 0,
            width: 1080,
            height: 1440,
            mime: 'image/jpeg',
            mirrored: true,
            source: 'camera',
            masterBytes: bytes.byteLength,
            thumbBytes: bytes.byteLength,
            schema: 1,
          })
          tx.objectStore('thumbs').put({ id, mime: 'image/jpeg', width: 60, height: 80, bytes })
          tx.objectStore('masters').put({ id, mime: 'image/jpeg', width: 1080, height: 1440, bytes })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error ?? new Error('IndexedDB transaction failed'))
      })
      db.close()
    })

    const started = Date.now()
    await page.reload()
    await completeOnboarding(page)
    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('200 photos')
    const elapsed = Date.now() - started

    // All 200 cells exist in the DOM...
    await expect(page.getByTestId('timeline-cell')).toHaveCount(200)

    // ...but only the ones near the viewport have decoded an image, which is
    // what keeps a multi-year timeline from stalling on open.
    const loadedImages = await page.locator('.cell__media img').count()
    expect(loadedImages).toBeGreaterThan(0)
    expect(
      loadedImages,
      `${loadedImages} of 200 thumbnails decoded on open — lazy loading is not working`,
    ).toBeLessThan(120)

    expect(elapsed, `timeline took ${elapsed}ms to open with 200 photos`).toBeLessThan(15_000)
  })
})
