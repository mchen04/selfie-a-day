import { expect, type Page } from '@playwright/test'
import { snapshot } from './api.ts'
import { ensureSignedIn, gotoApp, waitForCameraLive } from './helpers.ts'

export interface CameraPhoto {
  id: string
  albumId: string
  dayKey: string
  capturedAt: number
  timerSeconds: number
  deletedAt: number | null
}

export async function openCamera(page: Page, live = true) {
  await gotoApp(page)
  await ensureSignedIn(page)
  if (live) await waitForCameraLive(page)

  return {
    photos: async (): Promise<CameraPhoto[]> => {
      const [remote, pending] = await Promise.all([
        snapshot(page.request),
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('selfie-a-day')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error ?? new Error('Could not read photos'))
          })
          function read<T>(store: string, key?: string): Promise<T> {
            return new Promise((resolve, reject) => {
              const request = key === undefined ? db.transaction(store).objectStore(store).getAll() : db.transaction(store).objectStore(store).get(key)
              request.onsuccess = () => resolve(request.result as T)
              request.onerror = () => reject(request.error ?? new Error('Could not read photos'))
            })
          }
          try {
            const user = await read<{ id: string } | undefined>('kv', 'user')
            const entries = await read<Array<{ userId: string; meta: CameraPhoto }>>('outbox')
            return entries.filter((entry) => entry.userId === user?.id).map((entry) => entry.meta)
          } finally { db.close() }
        }),
      ])
      const photos = new Map<string, CameraPhoto>(remote.photos.map((photo) => [photo.id, photo]))
      for (const meta of pending) {
        for (const photo of photos.values()) {
          if (photo.id !== meta.id && photo.albumId === meta.albumId && photo.dayKey === meta.dayKey && photo.deletedAt === null) {
            photos.set(photo.id, { ...photo, deletedAt: meta.capturedAt })
          }
        }
        photos.set(meta.id, meta)
      }
      return [...photos.values()].filter((photo) => photo.deletedAt === null)
    },
  }
}

export async function pauseCameraClock(page: Page) {
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-21T12:00:01Z'))
}

export async function expectNoCameraPhoto(photos: () => Promise<CameraPhoto[]>) {
  expect(await photos()).toEqual([])
}
