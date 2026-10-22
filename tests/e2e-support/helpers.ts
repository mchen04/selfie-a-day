import { expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAccount, snapshot } from './api.ts'
import { offlineReadiness } from './offline.ts'

/** Screenshots are artefacts, not source; they go to the ignored test-results directory. */
const EVIDENCE_DIR = resolve(process.env.E2E_EVIDENCE_DIR ?? 'test-results/e2e-evidence')

export function evidencePath(name: string): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  return resolve(EVIDENCE_DIR, name)
}

/**
 * Sign in a new synthetic account for tests that are about something else.
 *
 * Waits for the boot state to resolve first: the app shows a spinner until its
 * stored session is read, and checking for the account screen during that
 * spinner would skip the sign-in and leave the test waiting for the camera.
 */
export async function ensureSignedIn(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="account-screen"], [data-testid="capture-screen"], [data-testid="boot-error"]').first()).toBeVisible({ timeout: 20_000 })
  if (await page.getByTestId('account-screen').isVisible()) {
    await createAccount(page.request)
    await page.reload()
  }
  await expect(page.getByTestId('capture-screen')).toBeVisible()
}

export async function gotoApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
}

/**
 * Wait until the live preview is producing frames with real content.
 *
 * `readyState >= 2` is not enough: Chromium's fake capture device serves a few
 * flat black frames before the fixture file starts playing, and a capture taken
 * in that window stores a black image. Waiting for actual variance in the
 * decoded frame removes the race at its source instead of retrying past it.
 */
export async function waitForCameraLive(page: Page): Promise<void> {
  await expect(page.getByTestId('shutter')).toHaveAttribute('data-mode', 'capture', { timeout: 20_000 })
  await page.waitForFunction(
    () => {
      const video = document.querySelector<HTMLVideoElement>('[data-testid="capture-video"]')
      if (!video || video.videoWidth === 0 || video.readyState < 2) return false

      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return false
      ctx.drawImage(video, 0, 0, 32, 32)

      const { data } = ctx.getImageData(0, 0, 32, 32)
      let min = 255
      let max = 0
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
        if (luma < min) min = luma
        if (luma > max) max = luma
      }
      // A flat frame (all black, all grey) means the fixture has not started.
      return max - min > 30
    },
    undefined,
    { timeout: 20_000 },
  )
}

/**
 * Take a photo and return its id.
 *
 * Waits for a *new* id rather than a higher count: a second capture on the same
 * day replaces the first by design, so counting would hang forever.
 */
export async function captureOnce(page: Page, waitForUpload = true): Promise<string> {
  const before = new Set((await listStoredPhotos(page)).map((p) => p.id))
  await page.getByTestId('shutter').click()

  let created: string | null = null
  await expect
    .poll(
      async () => {
        const now = await listStoredPhotos(page)
        created = now.find((p) => !before.has(p.id))?.id ?? null
        return created
      },
      { timeout: 20_000, message: 'no new photo appeared in IndexedDB after tapping the shutter' },
    )
    .not.toBeNull()

  if (waitForUpload && await page.evaluate(() => navigator.onLine)) {
    await expect.poll(async () => (await snapshot(page.request)).photos.some((photo) => photo.id === created), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await listStoredPhotos(page)).some((photo) => photo.id === created)).toBe(true)
  }
  return created!
}

export interface StoredPhotoInfo {
  id: string
  albumId?: string
  dayKey: string
  capturedAt: number
  deletedAt?: number | null
  width: number
  height: number
  mime: string
  mirrored: boolean
}

export async function listStoredPhotos(
  page: Page,
  options: { includeDeleted?: boolean } = {},
): Promise<StoredPhotoInfo[]> {
  return page.evaluate(async (includeDeleted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('selfie-a-day')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Cannot open storage'))
    })
    function read<T>(store: string, key?: string): Promise<T> {
      return new Promise((resolve, reject) => {
        const request = key === undefined ? db.transaction(store).objectStore(store).getAll() : db.transaction(store).objectStore(store).get(key)
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error ?? new Error('Cannot read storage'))
      })
    }
    try {
      const user = await read<{ id: string } | undefined>('kv', 'user')
      if (!user) return []
      const cached = await read<{ photos: StoredPhotoInfo[] } | undefined>('kv', `user:${user.id}:snapshot`)
      const pending = (await read<Array<{ userId: string; meta: StoredPhotoInfo }>>('outbox')).filter((entry) => entry.userId === user.id)
      const photos = new Map((cached?.photos ?? []).map((photo) => [photo.id, photo]))
      for (const entry of pending) {
        for (const photo of photos.values()) if (photo.deletedAt == null && photo.albumId === entry.meta.albumId && photo.dayKey === entry.meta.dayKey) photos.set(photo.id, { ...photo, deletedAt: entry.meta.capturedAt })
        photos.set(entry.meta.id, entry.meta)
      }
      return [...photos.values()].filter((photo) => includeDeleted || photo.deletedAt == null).sort((a, b) => b.capturedAt - a.capturedAt)
    } finally { db.close() }
  }, options.includeDeleted === true)
}

/**
 * Decode a stored master image in the page and sample its pixels.
 * Returns the image dimensions plus the RGB value at each requested point.
 */
export async function samplePhotoPixels(
  page: Page,
  id: string,
  points: readonly { name: string; u: number; v: number }[],
): Promise<{ width: number; height: number; samples: Record<string, [number, number, number]> }> {
  const response = await page.request.get(`/api/photos/${id}/master`)
  expect(response.ok()).toBe(true)
  const bytes = [...await response.body()]
  return page.evaluate(async ({ bytes, points }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }))
    const { width, height } = bitmap
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const samples: Record<string, [number, number, number]> = {}
    for (const point of points) {
      const d = ctx.getImageData(Math.round(point.u * (width - 1)), Math.round(point.v * (height - 1)), 1, 1).data
      samples[point.name] = [d[0]!, d[1]!, d[2]!]
    }
    bitmap.close()
    return { width, height, samples }
  }, { bytes, points: [...points] })
}

/**
 * Which of red/green/blue dominates a sampled pixel.
 *
 * The other two channels must be genuinely dark, not merely lower. The previous
 * margin-based test (`r > b + 40`) called screen-blended **magenta** red — and
 * magenta over the preview is precisely what a mirror-inverted ghost produces,
 * so a flipped ghost read as a correct one. A fresh-eyes verifier demonstrated
 * that by rendering the ghost fully inverted and watching every alignment test
 * still pass.
 */
export function dominantChannel([r, g, b]: [number, number, number]): 'red' | 'green' | 'blue' | 'none' {
  const max = Math.max(r, g, b)
  if (max < 90) return 'none'
  const quiet = max * 0.55
  if (r === max && g < quiet && b < quiet) return 'red'
  if (g === max && r < quiet && b < quiet) return 'green'
  if (b === max && r < quiet && g < quiet) return 'blue'
  return 'none'
}

/**
 * Wait until the app can genuinely survive losing the network.
 *
 * Three conditions, not one. `registration.active` is set while the worker is
 * still "activating", and a worker that has activated has not necessarily
 * finished writing its precache — going offline in either window leaves the
 * next reload with no shell to load, which is a flaky test rather than a real
 * offline failure.
 */
export async function waitForOfflineReady(page: Page): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(offlineReadiness),
      { timeout: 30_000, message: 'service worker never became offline-ready' },
    )
    .toBe('ready')
}
