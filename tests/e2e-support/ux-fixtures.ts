import { expect, type Page, type TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { AlbumDTO, PhotoDTO, PushPreference } from '../../src/api/client.ts'
import { waitForCameraLive } from './helpers.ts'
import { press } from './ux.ts'

export type ReminderMode = 'off' | 'on' | 'unsupported' | 'not-installed' | 'denied'
export interface UxOptions {
  signedIn?: boolean
  photos?: number
  trash?: number
  reminders?: ReminderMode
  fallback?: boolean
  authError?: boolean
}

export async function uxFixtures(page: Page, options: UxOptions = {}) {
  const portrait = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 400
    const context = canvas.getContext('2d')!
    const background = context.createLinearGradient(0, 0, 300, 400)
    background.addColorStop(0, '#334b57')
    background.addColorStop(1, '#14222b')
    context.fillStyle = background
    context.fillRect(0, 0, 300, 400)
    context.fillStyle = '#69887e'
    context.beginPath()
    context.ellipse(150, 400, 115, 120, 0, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#ccaa8e'
    context.beginPath()
    context.ellipse(150, 185, 66, 88, 0, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#453b39'
    context.fillRect(118, 170, 12, 5)
    context.fillRect(170, 170, 12, 5)
    context.fillRect(136, 223, 28, 3)
    return [...new Uint8Array(atob(canvas.toDataURL('image/jpeg', .8).split(',')[1]!).split('').map((character) => character.charCodeAt(0)))]
  }))
  const now = Date.now()
  const user = { id: `ux-${randomUUID()}`, username: 'daily-selfie' }
  const albums: AlbumDTO[] = [
    { id: 'selfies', name: 'Selfies', timeZone: 'UTC', createdAt: now, updatedAt: now, deletedAt: null },
    { id: 'album-00000000000000000001', name: 'A very long album name for daily portraits', timeZone: null, createdAt: now, updatedAt: now, deletedAt: null },
  ]
  const photos: PhotoDTO[] = Array.from({ length: (options.photos ?? 0) + (options.trash ?? 0) }, (_, index) => {
    const capturedAt = now - (index + 1) * 86_400_000
    return {
      id: index.toString(36).padStart(20, '0'), albumId: 'selfies', dayKey: new Date(capturedAt).toISOString().slice(0, 10),
      capturedAt, timeZone: 'UTC', tzOffsetMinutes: 0, width: 300, height: 400, mime: 'image/jpeg', mirrored: false,
      source: 'file', timerSeconds: 0, masterBytes: portrait.length, thumbBytes: portrait.length,
      deletedAt: index >= (options.photos ?? 0) ? now : null,
    }
  })
  const prefs: PushPreference[] = albums.map((album) => ({ albumId: album.id, enabled: options.reminders === 'on', time: '09:00', timeZone: 'UTC' }))
  let signedIn = options.signedIn ?? true
  let releaseUploads: (() => void) | undefined
  let releaseMasters: (() => void) | undefined
  const controls = {
    photos, albums, portrait,
    uploads: [] as string[],
    unexpected: [] as string[],
    offline: false,
    holdUploads: false,
    holdMasters: false,
    releaseUploads: () => { controls.holdUploads = false; releaseUploads?.() },
    releaseMasters: () => { controls.holdMasters = false; releaseMasters?.() },
  }
  await page.addInitScript(({ fallback, reminders }) => {
    if (fallback) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: reminders !== 'not-installed' })
    if (reminders === 'not-installed') Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone AppleWebKit Safari' })
    if (reminders === 'unsupported') {
      Object.defineProperty(window, 'PushManager', { configurable: true, value: undefined })
      return
    }
    let permission: NotificationPermission = reminders === 'denied' ? 'denied' : reminders === 'on' ? 'granted' : 'default'
    const notification = { get permission() { return permission }, requestPermission: () => { permission = 'granted'; return Promise.resolve(permission) } }
    Object.defineProperty(window, 'Notification', { configurable: true, value: notification })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
    const subscription = {
      endpoint: 'https://web.push.apple.com/ux-synthetic',
      toJSON: () => ({ endpoint: 'https://web.push.apple.com/ux-synthetic', keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth' } }),
      unsubscribe: () => Promise.resolve(true),
    }
    const registration = { pushManager: { getSubscription: () => Promise.resolve(subscription), subscribe: () => Promise.resolve(subscription) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), getRegistration: () => Promise.resolve(registration), register: () => Promise.resolve(registration), addEventListener: () => undefined } })
  }, { fallback: options.fallback ?? true, reminders: options.reminders ?? 'off' })

  await page.route('**/api/**', async (route) => {
    if (controls.offline) return route.abort('internetdisconnected')
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/auth/me') return signedIn ? json({ user }) : json({ error: 'unauthenticated' }, 401)
    if (path === '/api/auth/signup' || path === '/api/auth/login') {
      if (options.authError) return json({ error: 'invalid_credentials' }, 401)
      signedIn = true
      return json({ user }, path.endsWith('signup') ? 201 : 200)
    }
    if (path === '/api/auth/logout') { signedIn = false; return route.fulfill({ status: 204 }) }
    if (path === '/api/sync') return json({ albums, photos, removed: [], cursor: String(Date.now()), serverTime: Date.now() })
    if (path === '/api/push/prefs') return json({ prefs })
    if (path.startsWith('/api/push/prefs/')) {
      const pref = { ...request.postDataJSON() as Omit<PushPreference, 'albumId'>, albumId: path.split('/').at(-1)! }
      prefs.splice(prefs.findIndex((item) => item.albumId === pref.albumId), 1, pref)
      return json({ pref })
    }
    if (path === '/api/push/config') return json({ publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    if (path === '/api/push/subscription') return route.fulfill({ status: 204 })
    if (path.startsWith('/api/albums/')) {
      const album = { ...request.postDataJSON() as Pick<AlbumDTO, 'name' | 'timeZone' | 'createdAt'>, id: path.split('/').at(-1)!, updatedAt: Date.now(), deletedAt: null }
      const index = albums.findIndex((item) => item.id === album.id)
      if (index < 0) albums.push(album)
      else albums.splice(index, 1, album)
      return json({ album })
    }
    if (/\/photos\/[^/]+\/(master|thumb)$/.test(path)) {
      if (controls.holdMasters && path.endsWith('/master')) await new Promise<void>((resolve) => { releaseMasters = resolve })
      return route.fulfill({ contentType: 'image/jpeg', body: portrait })
    }
    const id = path.match(/^\/api\/photos\/([^/]+)$/)?.[1]
    if (id && method === 'PUT') {
      const form = await new Request(request.url(), { method, headers: request.headers(), body: new Uint8Array(request.postDataBuffer()!) }).formData()
      const encoded = form.get('meta')
      if (typeof encoded !== 'string') throw new Error('Missing synthetic upload metadata')
      const meta = JSON.parse(encoded) as Omit<PhotoDTO, 'id' | 'masterBytes' | 'thumbBytes' | 'deletedAt'>
      const photo: PhotoDTO = { ...meta, id, masterBytes: portrait.length, thumbBytes: portrait.length, deletedAt: null }
      controls.uploads.push(id)
      if (controls.holdUploads) await new Promise<void>((resolve) => { releaseUploads = resolve })
      const replaced = photos.filter((item) => item.deletedAt === null && item.albumId === photo.albumId && item.dayKey === photo.dayKey)
      for (const item of replaced) item.deletedAt = Date.now()
      photos.push(photo)
      return json({ photo, replaced: replaced.map((item) => item.id) }, 201)
    }
    if (id && method === 'PATCH') {
      const photo = photos.find((item) => item.id === id)
      if (!photo) return json({ error: 'not_found' }, 404)
      photo.deletedAt = (request.postDataJSON() as { deletedAt: number | null }).deletedAt
      return json({ photo })
    }
    if (id && method === 'DELETE') { photos.splice(photos.findIndex((item) => item.id === id), 1); return route.fulfill({ status: 204 }) }
    if (path === '/api/trash/empty') {
      const removed = photos.filter((photo) => photo.deletedAt !== null)
      for (const photo of removed) photos.splice(photos.indexOf(photo), 1)
      return json({ deleted: removed.length })
    }
    controls.unexpected.push(`${method} ${path}`)
    return json({ error: 'unexpected_ux_request' }, 500)
  })
  return controls
}

export async function openUx(page: Page, options: UxOptions = {}, path = '/') {
  const fixture = await uxFixtures(page, options)
  // A signed-in browser carries the session hint cookie, so startup waits for
  // the session check instead of painting the account form first.
  if (options.signedIn !== false) await page.context().addCookies([{ name: 'sad_hint', value: '1', url: process.env.E2E_BASE_URL ?? 'http://localhost:4319' }])
  await page.goto(path)
  await expect(page.getByTestId(options.signedIn === false ? 'account-screen' : path.startsWith('/photo/') ? 'photo-screen' : path === '/' ? 'capture-screen' : `${path.slice(1)}-screen`)).toBeVisible()
  if (path === '/' && options.signedIn !== false && options.fallback === false) await waitForCameraLive(page)
  if ((options.photos ?? 0) > 0 && path === '/timeline') await expect(page.getByTestId('timeline-cell')).toHaveCount(options.photos!)
  return fixture
}

export async function saveUxPhoto(page: Page, fixture: Awaited<ReturnType<typeof uxFixtures>>, info: TestInfo) {
  if (await page.getByTestId('shutter').getAttribute('data-mode') === 'file') {
    const chooser = page.waitForEvent('filechooser')
    await press(page.getByTestId('shutter'), info)
    await (await chooser).setFiles({ name: 'synthetic-portrait.jpg', mimeType: 'image/jpeg', buffer: fixture.portrait })
  } else await press(page.getByTestId('shutter'), info)
  await expect(page.getByTestId('toast')).toContainText('Saved')
  if (!fixture.holdUploads) await expect.poll(() => fixture.uploads.length).toBeGreaterThan(0)
}
