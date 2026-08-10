import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  captureOnce,
  completeOnboarding,
  countPhotos,
  delayCanvasEncoding,
  evidencePath,
  gotoApp,
  listStoredPhotos,
  shot,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'
import { decodePNG } from '../e2e-support/png.ts'

/** Hide getUserMedia before any app code runs, as an old iOS PWA would. */
const HIDE_GET_USER_MEDIA = `
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
`

/**
 * Gate 7: when the live camera is unavailable, the file-input fallback is
 * chosen automatically, is reachable, and actually stores a photo.
 */
test.describe('capture fallback', () => {
  test('falls back automatically when getUserMedia is missing', async ({ page }) => {
    await page.addInitScript(HIDE_GET_USER_MEDIA)
    await gotoApp(page)
    await completeOnboarding(page)

    // No dead button: the shutter switches to the file path by itself.
    await expect(page.getByTestId('shutter')).toHaveAttribute('data-mode', 'file')
    await expect(page.getByTestId('shutter')).toBeEnabled()
    await expect(page.getByTestId('camera-status')).toHaveAttribute('data-state', 'fallback')
    await expect(page.getByTestId('camera-status')).toContainText('Camera roll mode')

    const input = page.getByTestId('file-fallback-input')
    await expect(input).toHaveAttribute('accept', 'image/*')
    await expect(input).toHaveAttribute('capture', 'user')

    await shot(page, `fallback-1-camera-roll-mode-${test.info().project.name}.png`)
  })

  test('a picked file becomes a stored photo in frame space', async ({ page }) => {
    await page.addInitScript(HIDE_GET_USER_MEDIA)
    await gotoApp(page)
    await completeOnboarding(page)

    // A landscape source, so the crop has real work to do.
    const source = evidencePath('picked-source.png')
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 800
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#202030'
      ctx.fillRect(0, 0, 1200, 800)
      ctx.fillStyle = '#e04040'
      ctx.beginPath()
      ctx.arc(600, 300, 90, 0, Math.PI * 2)
      ctx.fill()
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'))
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    writeFileSync(source, Buffer.from(png))

    const selectedAt = new Date('2026-08-10T06:59:59.500Z')
    await page.clock.install({ time: selectedAt })
    await delayCanvasEncoding(page, 1_000)
    await page.getByTestId('file-fallback-input').setInputFiles(source)
    await page.clock.runFor(2_000)
    await expect(page.getByTestId('toast')).toContainText('Saved')
    await expect.poll(async () => await countPhotos(page)).toBe(1)

    const [stored] = await listStoredPhotos(page)
    expect(stored!.source).toBe('file')
    // Cropped into frame space like any other capture, and written in the same
    // mirroring space as a live capture so the library stays consistent.
    expect(stored!.width / stored!.height).toBeCloseTo(0.75, 3)
    expect(stored!.mirrored).toBe(true)
    expect(stored!.dayKey).toBe('2026-08-09')
    expect(stored!.capturedAt).toBeGreaterThanOrEqual(selectedAt.getTime())
    expect(stored!.capturedAt).toBeLessThan(Date.parse('2026-08-10T07:00:00Z'))

    // It becomes the ghost, exactly like a live capture would.
    await page.reload()
    await completeOnboarding(page)
    await expect(page.getByTestId('ghost-image')).toBeVisible()
    await shot(page, `fallback-2-file-became-ghost-${test.info().project.name}.png`)
  })

  test('rejects a non-image file with a readable message', async ({ page }) => {
    await page.addInitScript(HIDE_GET_USER_MEDIA)
    await gotoApp(page)
    await completeOnboarding(page)

    const notAnImage = evidencePath('not-an-image.txt')
    writeFileSync(notAnImage, 'definitely not a photograph')

    await page.getByTestId('file-fallback-input').setInputFiles(notAnImage)
    await expect(page.getByTestId('toast')).toContainText('not an image')
    expect(await countPhotos(page)).toBe(0)
  })
})

/** The states that are easy to skip and expensive to get wrong. */
test.describe('ugly states', () => {
  test('permission denied is recoverable and offers the fallback', async ({ page, context }) => {
    await context.clearPermissions()
    await page.addInitScript(`
      navigator.mediaDevices.getUserMedia = () => {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      };
    `)
    await gotoApp(page)
    await completeOnboarding(page)

    const status = page.getByTestId('camera-status')
    await expect(status).toHaveAttribute('data-state', 'denied')
    await expect(status).toContainText('Camera access is off')
    await expect(page.getByTestId('camera-retry')).toBeVisible()
    await expect(page.getByTestId('camera-use-library')).toBeVisible()
    await shot(page, `ugly-1-permission-denied-${test.info().project.name}.png`)

    // The escape hatch works even though the live camera does not.
    const source = evidencePath('denied-fallback-source.png')
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 900
      canvas.height = 1200
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#3a6'
      ctx.fillRect(0, 0, 900, 1200)
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'))
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    writeFileSync(source, Buffer.from(png))

    await page.getByTestId('file-fallback-input').setInputFiles(source)
    await expect.poll(async () => await countPhotos(page)).toBe(1)
  })

  test('no camera on the device is reported plainly', async ({ page }) => {
    await page.addInitScript(`
      navigator.mediaDevices.getUserMedia = () => {
        const err = new Error('No device');
        err.name = 'NotFoundError';
        return Promise.reject(err);
      };
    `)
    await gotoApp(page)
    await completeOnboarding(page)

    const status = page.getByTestId('camera-status')
    await expect(status).toHaveAttribute('data-state', 'no-camera')
    await expect(status).toContainText('No camera was found')
  })

  test('a same-day retake keeps one active photo and moves the old one to Trash', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const first = await captureOnce(page)
    await expect(page.locator('.pill--done')).toHaveText('Retake')

    const second = await captureOnce(page)
    expect(second).not.toBe(first)

    const stored = await listStoredPhotos(page)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(second)

    const allStored = await listStoredPhotos(page, { includeDeleted: true })
    expect(allStored).toHaveLength(2)
    const superseded = allStored.find((photo) => photo.id === first)
    expect(typeof superseded?.deletedAt).toBe('number')
    expect(superseded?.masterBytes).toBeGreaterThan(0)
  })

  test('deleting the newest photo re-derives the ghost from the one before it', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const older = await captureOnce(page)
    // Backdate it so the next capture is a different day.
    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('IndexedDB request failed'))
      })
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('photos', 'readwrite')
        const store = tx.objectStore('photos')
        const get = store.get(id)
        get.onsuccess = () => {
          const meta = get.result as { dayKey: string; capturedAt: number }
          meta.dayKey = '2026-01-05'
          meta.capturedAt -= 86_400_000 * 40
          store.put(meta)
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error ?? new Error('IndexedDB transaction failed'))
      })
      db.close()
    }, older)

    await page.reload()
    await completeOnboarding(page)
    await waitForCameraLive(page)
    const newest = await captureOnce(page)
    expect(await countPhotos(page)).toBe(2)

    // Delete the newest; the ghost must fall back to the older photo.
    await page.getByTestId('nav-timeline').click()
    await page.locator('[data-testid="timeline-cell"]').first().click()
    await expect(page.getByTestId('photo-screen')).toBeVisible()
    await page.getByTestId('photo-delete').click()
    await expect(page.getByTestId('delete-confirm')).toBeVisible()
    await page.getByTestId('photo-delete').click()

    await expect.poll(async () => await countPhotos(page)).toBe(1)
    const remaining = await listStoredPhotos(page)
    expect(remaining[0]!.id).toBe(older)
    expect(remaining.some((p) => p.id === newest)).toBe(false)

    await page.goto('/')
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await expect(page.getByTestId('ghost-image')).toBeVisible()
    // The remaining photo is from an older day, so the hint points at that day.
    await expect(page.getByTestId('ghost-hint')).toContainText('Line your eyes up with')
  })

  test('deleting the only photo leaves a clean day-one state', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await captureOnce(page)

    await page.getByTestId('nav-timeline').click()
    await page.locator('[data-testid="timeline-cell"]').first().click()
    await page.getByTestId('photo-delete').click()
    await page.getByTestId('photo-delete').click()

    await expect.poll(async () => await countPhotos(page)).toBe(0)
    await expect(page.getByTestId('timeline-empty')).toBeVisible()

    await page.goto('/')
    await completeOnboarding(page)
    await waitForCameraLive(page)
    await expect(page.getByTestId('ghost-image')).toHaveCount(0)
    await expect(page.getByTestId('ghost-toggle')).toBeDisabled()
    await expect(page.getByTestId('streak-label')).toHaveText('Day one')
  })

  test('storage being unavailable is reported instead of failing silently', async ({ page }) => {
    await page.addInitScript(`
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    `)
    await gotoApp(page)

    await expect(page.getByTestId('boot-error')).toBeVisible()
    await expect(page.getByTestId('boot-error')).toContainText('Photo storage is unavailable')
    await shot(page, `ugly-2-no-storage-${test.info().project.name}.png`)
  })

  test('a corrupt backup file is refused with a specific reason', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await page.getByTestId('nav-settings').click()

    const junk = evidencePath('corrupt-backup.zip')
    writeFileSync(junk, Buffer.from('PK this is not really a zip file at all'))

    await page.getByTestId('import-input').setInputFiles(junk)
    await expect(page.getByTestId('toast')).toBeVisible()
    const message = await page.getByTestId('toast').textContent()
    expect(message).toMatch(/zip|backup|damaged|not/i)
    expect(await countPhotos(page)).toBe(0)
  })

  test('a rotated device keeps the frame square with the capture', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    // Landscape: the frame must letterbox rather than stretch.
    await page.setViewportSize({ width: 844, height: 390 })
    const box = await page.getByTestId('capture-frame').boundingBox()
    expect(box!.width / box!.height).toBeCloseTo(0.75, 2)

    const id = await captureOnce(page)
    const stored = (await listStoredPhotos(page)).find((p) => p.id === id)!
    expect(stored.width / stored.height).toBeCloseTo(0.75, 3)

    const shotPath = await shot(page, `ugly-3-landscape-${test.info().project.name}.png`)
    const image = decodePNG(readFileSync(shotPath))
    expect(image.width).toBeGreaterThan(0)
  })

  /**
   * Storage full. The brief calls this out, and it is the one storage failure
   * with an obvious remedy — so the app must name the remedy, and must not
   * report a photo as saved when it was not.
   */
  test('a full disk is reported with a remedy, and nothing is silently lost', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    // Make the master-image write fail exactly as a quota exhaustion would.
    await page.evaluate(() => {
      const store = IDBObjectStore.prototype as unknown as Record<string, unknown>
      const original = store.put as (this: IDBObjectStore, ...a: unknown[]) => IDBRequest
      store.put = function (this: IDBObjectStore, ...args: unknown[]): IDBRequest {
        if (this.name === 'masters') {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        }
        return original.apply(this, args)
      }
    })

    await page.getByTestId('shutter').click()

    const toast = page.getByTestId('toast')
    await expect(toast).toBeVisible()
    await expect(toast).toHaveAttribute('data-tone', 'error')
    await expect(toast).toContainText('out of space')
    await expect(toast).toContainText('Export')

    // The failed write must leave nothing behind: no metadata without pixels.
    expect(await countPhotos(page)).toBe(0)
    await expect(page.getByTestId('ghost-image')).toHaveCount(0)

    // And the app is still usable rather than wedged.
    await expect(page.getByTestId('shutter')).toBeEnabled()
  })

  /**
   * Backgrounded and resumed. On iOS the OS pauses capture and surfaces it as
   * track.muted with readyState still "live" — so a naive readyState check
   * leaves a frozen picture that claims to be running.
   */
  test('an interrupted camera offers a tap to resume rather than a frozen frame', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    // Simulate the OS muting the track, which is what backgrounding does.
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('[data-testid="capture-video"]')
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0]
      if (!track) throw new Error('no video track')
      Object.defineProperty(track, 'muted', { value: true, configurable: true })
      track.dispatchEvent(new Event('mute'))
    })

    const status = page.getByTestId('camera-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveAttribute('data-state', 'interrupted')
    await expect(status).toContainText('Tap to start the camera')

    // The shutter becomes a start button, so the tap happens inside a user
    // gesture — which is what stops iOS re-prompting for permission.
    await expect(page.getByTestId('shutter')).toHaveAttribute('data-mode', 'start')

    await page.getByTestId('shutter').click()
    await waitForCameraLive(page)
    await expect(page.getByTestId('camera-status')).toHaveCount(0)

    // And capture works again afterwards.
    const id = await captureOnce(page)
    expect(id).toBeTruthy()
  })

  /**
   * Regression: settings persistence used to read its value out of a React
   * state updater. When a second update was queued before the first committed,
   * the updater ran later and DEFAULT_SETTINGS reached disk — wiping
   * onboardingCompleteAt and dumping the user back into onboarding.
   *
   * Two independent reviewers found this; one reproduced it in 2 of 3 runs by
   * clicking through onboarding as fast as the button appeared.
   */
  test('rapid settings changes persist the merged result, not defaults', async ({ page }) => {
    await gotoApp(page)
    // Click the instant it appears: the fast path that triggered the bug.
    await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('capture-screen')).toBeVisible()
    await waitForCameraLive(page)

    // The ghost slider only enables once there is a photo to show through.
    await captureOnce(page)

    // Fire several updates back to back so later ones queue behind earlier ones.
    await page.getByTestId('grid-toggle').click()
    await page.getByTestId('grid-toggle').click()
    await page.getByTestId('ghost-opacity').fill('80')
    await page.getByTestId('ghost-opacity').fill('25')

    const persisted = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('open failed'))
      })
      const row = await new Promise<Record<string, unknown>>((res, rej) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get('settings')
        req.onsuccess = () => res(req.result as Record<string, unknown>)
        req.onerror = () => rej(req.error ?? new Error('read failed'))
      })
      db.close()
      return row
    })

    // Onboarding must still be recorded as complete...
    expect(persisted.onboardingCompleteAt, 'onboarding was reset by a later write').not.toBeNull()
    // ...and the last change of each kind must be the one on disk.
    expect(persisted.gridStyle).toBe('off')
    expect(persisted.ghostOpacity).toBe(0.25)

    // The real symptom: a reload must not send the user back to onboarding.
    await page.reload()
    await expect(page.getByTestId('capture-screen')).toBeVisible()
    await expect(page.getByTestId('onboarding-screen')).toHaveCount(0)
  })

  /**
   * A library that mixes mirrored and un-mirrored photos flips left to right on
   * playback — the "head jumping around" the whole product exists to prevent.
   * Both capture paths must therefore store in the same space.
   */
  test('camera and file captures land in the same mirroring space', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)

    const cameraId = await captureOnce(page)
    const camera = (await listStoredPhotos(page)).find((p) => p.id === cameraId)!
    expect(camera.source).toBe('camera')

    // Now add a photo through the fallback path, on a different day.
    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open('selfie-a-day')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error ?? new Error('open failed'))
      })
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('photos', 'readwrite')
        const store = tx.objectStore('photos')
        const get = store.get(id)
        get.onsuccess = () => {
          const meta = get.result as { dayKey: string; capturedAt: number }
          meta.dayKey = '2026-02-02'
          meta.capturedAt -= 86_400_000 * 60
          store.put(meta)
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error ?? new Error('write failed'))
      })
      db.close()
    }, cameraId)

    await page.reload()
    await completeOnboarding(page)

    const source = evidencePath('mixed-space-source.png')
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 900
      canvas.height = 1200
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#334'
      ctx.fillRect(0, 0, 900, 1200)
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'))
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    writeFileSync(source, Buffer.from(png))
    await page.getByTestId('file-fallback-input').setInputFiles(source)
    await expect.poll(async () => (await listStoredPhotos(page)).length).toBe(2)

    const all = await listStoredPhotos(page)
    const file = all.find((p) => p.source === 'file')!
    expect(file).toBeDefined()
    expect(
      file.mirrored,
      'a picked file must be stored in the same space as a live capture',
    ).toBe(camera.mirrored)

    // One space across the whole library is the property that matters.
    expect(new Set(all.map((p) => p.mirrored)).size).toBe(1)
  })
})
