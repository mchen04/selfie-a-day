import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { randomInt, randomUUID } from 'node:crypto'
import type { PhotoDTO, SyncResponse } from '../../src/api/client.ts'

export interface SyntheticAccount { username: string; password: string }
export const apiOrigin = () => new URL(process.env.E2E_BASE_URL ?? 'http://localhost:4319').origin
export const mutationHeaders = () => ({ Origin: apiOrigin(), 'X-Selfie-CSRF': '1' })

export async function createAccount(request: APIRequestContext): Promise<SyntheticAccount> {
  const account = { username: `test-${randomUUID().replaceAll('-', '').slice(0, 20)}`, password: randomUUID() + randomUUID() }
  const ip = `198.18.${randomInt(1, 255)}.${randomInt(1, 255)}`
  const response = await request.post('/api/auth/signup', { data: account, headers: { ...mutationHeaders(), 'CF-Connecting-IP': ip, 'X-Forwarded-For': ip } })
  expect(response.status()).toBe(201)
  await snapshot(request)
  return account
}

export async function signIn(page: Page, account: SyntheticAccount): Promise<void> {
  const response = await page.request.post('/api/auth/login', { data: account, headers: mutationHeaders() })
  expect(response.status()).toBe(200)
  await page.goto('/')
  await expect(page.getByTestId('capture-screen')).toBeVisible()
}

export async function snapshot(request: APIRequestContext): Promise<SyncResponse> {
  const response = await request.get('/api/sync')
  expect(response.ok()).toBe(true)
  return await response.json() as SyncResponse
}

export async function seedPhoto(page: Page, dayKey: string, albumId = 'selfies'): Promise<PhotoDTO> {
  const buffer = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 120; canvas.height = 160
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, 120, 160)
    gradient.addColorStop(0, '#e34242'); gradient.addColorStop(1, '#387bea')
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 120, 160)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', .8))
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  const id = randomUUID().replaceAll('-', '').slice(0, 20)
  const response = await page.request.put(`/api/photos/${id}`, { headers: mutationHeaders(), multipart: {
    meta: JSON.stringify({ albumId, dayKey, capturedAt: Date.parse(`${dayKey}T12:00:00Z`), timeZone: 'UTC', tzOffsetMinutes: 0,
      width: 120, height: 160, mime: 'image/jpeg', mirrored: false, source: 'file', timerSeconds: 0 }),
    master: { name: 'master.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(buffer) },
    thumb: { name: 'thumb.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(buffer) },
  } })
  expect(response.status()).toBe(201)
  return (await response.json() as { photo: PhotoDTO }).photo
}

export async function syncPage(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}
