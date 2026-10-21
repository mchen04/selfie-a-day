import { expect, type Page } from '@playwright/test'
import { completeOnboarding, gotoApp, waitForCameraLive } from './helpers.ts'

export interface CameraPhoto {
  id: string
  albumId: string
  dayKey: string
  capturedAt: number
  timerSeconds: number
  deletedAt: number | null
}

export async function openCamera(page: Page, live = true) {
  const uploaded = new Map<string, CameraPhoto>()
  const images = new Map<string, { bytes: Buffer; mime: string }>()
  const album = { id: 'selfies', name: 'Selfies', timeZone: null, createdAt: 1, updatedAt: 1, deletedAt: null }
  let cursor = 0
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: 'synthetic-camera-user', username: 'camera-test' } } })
      return
    }
    if (path === '/api/sync') {
      await route.fulfill({ json: { albums: [album], photos: [...uploaded.values()], removed: [], cursor: `${cursor}`, serverTime: Date.now() } })
      return
    }
    const photoPath = /^\/api\/photos\/([^/]+)$/.exec(path)
    if (photoPath && request.method() === 'PUT') {
      const data = await new Response(new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)), {
        headers: { 'content-type': request.headers()['content-type'] ?? '' },
      }).formData()
      const metaPart = data.get('meta')
      const meta = JSON.parse(typeof metaPart === 'string' ? metaPart : await metaPart!.text()) as CameraPhoto
      const id = photoPath[1]!
      const replaced: string[] = []
      for (const previous of uploaded.values()) {
        if (previous.albumId === meta.albumId && previous.dayKey === meta.dayKey && previous.deletedAt === null) {
          previous.deletedAt = Date.now()
          replaced.push(previous.id)
        }
      }
      const sizes: Record<string, number> = {}
      for (const kind of ['master', 'thumb']) {
        const part = data.get(kind)
        if (part && typeof part !== 'string') {
          const bytes = Buffer.from(await part.arrayBuffer())
          images.set(`${id}/${kind}`, { bytes, mime: part.type })
          sizes[`${kind}Bytes`] = bytes.byteLength
        }
      }
      const photo = { ...meta, ...sizes, id, deletedAt: null }
      uploaded.set(id, photo)
      cursor++
      await route.fulfill({ status: 201, json: { photo, replaced } })
      return
    }
    const imagePath = /^\/api\/photos\/([^/]+\/(?:master|thumb))$/.exec(path)
    const image = imagePath ? images.get(imagePath[1]!) : null
    if (image) {
      await route.fulfill({ body: image.bytes, contentType: image.mime })
      return
    }
    if (path === '/api/push/prefs') {
      await route.fulfill({ json: { prefs: [] } })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'not_found' } })
  })
  await gotoApp(page)
  await completeOnboarding(page)
  if (live) await waitForCameraLive(page)

  return {
    photos: async (): Promise<CameraPhoto[]> => {
      if (uploaded.size) return [...uploaded.values()].filter((photo) => photo.deletedAt === null)
      return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('selfie-a-day')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error ?? new Error('Could not read photos'))
        })
        try {
          if (!db.objectStoreNames.contains('photos')) return []
          return await new Promise<CameraPhoto[]>((resolve, reject) => {
            const request = db.transaction('photos').objectStore('photos').getAll()
            request.onsuccess = () => resolve((request.result as CameraPhoto[]).filter((photo) => photo.deletedAt === null))
            request.onerror = () => reject(request.error ?? new Error('Could not read photos'))
          })
        } finally {
          db.close()
        }
      })
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
