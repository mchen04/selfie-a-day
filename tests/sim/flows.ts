import { expect } from '@playwright/test'
import { OWNER, type SimAccount } from './config.ts'
import { simStamp } from './calendar.ts'
import { PushDevice, type Device, type LocalPhoto } from './device.ts'
import type { PushEvent, PushMessage } from './push.ts'
import { serverAlbums, serverPhotos, serverPrefs, serverSubscriptions, userId, type ServerPhoto } from './server.ts'
import type { Day } from './sim.ts'

export const phonePush = new PushDevice('phone')

export const owner = (): string => {
  const id = userId(OWNER.username)
  if (!id) throw new Error('The owner account does not exist yet')
  return id
}

export const live = (photos: ServerPhoto[]) => photos.filter((photo) => photo.purgedAt === null)
export const active = (photos: ServerPhoto[]) => photos.filter((photo) => photo.purgedAt === null && photo.deletedAt === null)
const albumName = (albumId: string) => serverAlbums(owner()).find((album) => album.id === albumId)?.name ?? albumId

/** The newest active photo in an album: what the ghost should show. */
export function newestIn(albumId: string): ServerPhoto | null {
  return active(serverPhotos(owner())).filter((photo) => photo.albumId === albumId)
    .sort((a, b) => b.capturedAt - a.capturedAt || b.id.localeCompare(a.id))[0] ?? null
}

// --- Navigation --------------------------------------------------------------

/** Back to the camera from wherever the app is, with the app's own back buttons. */
export async function home(device: Device): Promise<void> {
  for (let hop = 0; hop < 5; hop++) {
    if (await device.testId('capture-screen').isVisible()) return
    for (const back of ['playback-close', 'photo-back', 'trash-back', 'timeline-back', 'settings-back']) {
      const button = device.testId(back)
      if (await button.isVisible()) {
        await device.press(button)
        break
      }
    }
    await device.page.waitForTimeout(150)
  }
  await expect(device.testId('capture-screen')).toBeVisible()
}

export async function inAlbum(device: Device, albumId: string): Promise<void> {
  await home(device)
  if ((await device.local()).activeAlbumId !== albumId) await device.selectAlbum(albumId)
}

/** Wait for the device's next completed /api/sync after `seq`. */
export async function synced(day: Day, device: Device, after: number, timeout = 20_000): Promise<void> {
  await expect.poll(() => day.requests.some((record) => record.context === device.name && record.seq > after && record.path.startsWith('/api/sync') && record.status === 200),
    { timeout, message: `${device.name} never finished a sync` }).toBe(true)
}

// --- Opening the app ---------------------------------------------------------

/**
 * Open the app the way that day's device would: the phone reopens with its
 * cached account (or, after eviction, with only the hint cookie); the desktop
 * signs in through the form. Checks the screens painted and the /api/auth/me count.
 */
export async function openApp(day: Day, device: Device, mode: 'cached' | 'hint' | 'form' | 'signup', account: SimAccount = OWNER): Promise<void> {
  const start = day.nextSeq()
  const hold = mode === 'cached' || mode === 'hint' ? await device.holdSessionCheck() : null
  let painted: { whileHeld: boolean; held: boolean; screens: string[] } | null = null
  const opening = device.page.goto('/')
  if (hold) {
    // With /api/auth/me held, a cached account must still reach the camera; an evicted one must wait.
    const camera = await expect(device.testId('capture-screen')).toBeVisible({ timeout: mode === 'cached' ? 15_000 : 3_000 }).then(() => true, () => false)
    painted = { whileHeld: camera, held: hold.held(), screens: (await device.observed().catch(() => ({ screens: [] as string[] }))).screens }
    await hold.release()
  }
  const response = await opening
  await expect(device.page.locator('[data-testid="account-screen"], [data-testid="capture-screen"], [data-testid="boot-error"]').first()).toBeVisible({ timeout: 30_000 })
  const document = { status: response?.status() ?? null, fromServiceWorker: response?.fromServiceWorker() ?? false }
  if (mode === 'signup') {
    const taps = await device.signUp(account)
    day.check('login: sign-up through the form lands on the camera', 'login', true, { taps, username: account.username, document })
  } else if (mode === 'form') {
    const taps = await device.signIn(account)
    const landed = await device.screen()
    day.check(`login: ${device.name} signs in through the form`, 'login', landed === 'capture-screen', { taps, landed, document })
  } else {
    await expect(device.testId('capture-screen')).toBeVisible({ timeout: 20_000 })
  }
  await synced(day, device, start)
  const meRecords = () => day.requests.filter((record) => record.context === device.name && record.seq > start && record.path === '/api/auth/me')
  // The record lands at requestfinished, which can trail the sync that followed it.
  if (hold) await expect.poll(() => meRecords().length, { timeout: 10_000 }).toBeGreaterThan(0).catch(() => undefined)
  await day.settle()
  const observed = await device.observed()
  const me = meRecords()
  if (mode === 'cached') {
    day.check('login: phone reopens signed in, camera first while /api/auth/me is still out (cached account, no sign-in screen)', 'login',
      !observed.screens.includes('account-screen') && observed.screens.includes('capture-screen') && !!painted?.held && painted.whileHeld,
      { painted, screens: observed.screens, cameraPaintedMs: Math.round(observed.captureAt), meAnsweredMs: Math.round(observed.meAt), document })
  } else if (mode === 'hint') {
    day.check('login: after storage eviction the hint cookie keeps the session (waits for /api/auth/me, no sign-in screen)', 'login',
      !observed.screens.includes('account-screen') && observed.screens.includes('capture-screen') && !!painted?.held && !painted.whileHeld && observed.captureAt >= observed.meAt,
      { painted, screens: observed.screens, cameraPaintedMs: Math.round(observed.captureAt), meAnsweredMs: Math.round(observed.meAt), document, cookies: await device.cookies() })
  }
  if (mode === 'cached' || mode === 'hint') {
    day.check(`login: ${device.name} opens with one /api/auth/me`, 'login', me.length === 1, { requests: me.map((record) => ({ status: record.status, step: record.step })) })
    day.check('offline: the app shell document comes from the service worker', 'offline', document.fromServiceWorker === (mode === 'cached'), document)
  }
}

// --- Capture -----------------------------------------------------------------

export interface Shot { id: string; meta: LocalPhoto; countdown: number[]; flashes: number }

/**
 * One shutter tap with the given timer (and flash) in the given album: the
 * countdown runs, exactly one photo is saved carrying timerSeconds, and — when
 * online — it reaches the server once.
 */
export async function capture(day: Day, device: Device, options: { album: string; timer: 3 | 5 | 10; flash?: boolean; upload?: boolean; label?: string }): Promise<Shot> {
  const { album, timer, flash = true, upload = true } = options
  await inAlbum(device, album)
  await device.live()
  await device.setTimer(timer)
  await device.setFlash(flash)
  const before = await device.local()
  const known = new Set([...before.photos, ...before.outbox].map((photo) => photo.id))
  const replaced = before.photos.find((photo) => photo.albumId === album && photo.dayKey === day.dayKey && photo.deletedAt === null) ?? null
  await device.resetObserved()
  await device.press(device.testId('shutter'))
  let created: LocalPhoto[] = []
  await expect.poll(async () => {
    const state = await device.local()
    created = [...state.outbox, ...state.photos].filter((photo, index, all) => !known.has(photo.id) && all.findIndex((item) => item.id === photo.id) === index)
    return created.length
  }, { timeout: 30_000, message: 'no photo was saved after the shutter tap' }).toBeGreaterThan(0)
  await device.page.waitForTimeout(300)
  const after = await device.local()
  created = [...after.outbox, ...after.photos].filter((photo, index, all) => !known.has(photo.id) && all.findIndex((item) => item.id === photo.id) === index)
  const meta = created[0]!
  const observed = await device.observed()
  const label = options.label ?? `${albumName(album)} ${timer}s`
  const countdown = Array.from({ length: timer }, (_, index) => timer - index)
  day.check(`capture: ${label} — one tap counts down ${timer}…1`, 'capture', JSON.stringify(observed.countdown) === JSON.stringify(countdown), { countdown: observed.countdown })
  if (flash) day.check(`capture: ${label} — flash fires once (screen flash)`, 'capture', observed.flashes === 1, { flashes: observed.flashes })
  day.check(`capture: ${label} — exactly one photo saved, timerSeconds ${timer}, today, ${albumName(album)}`, 'capture',
    created.length === 1 && meta.timerSeconds === timer && meta.dayKey === day.dayKey && meta.albumId === album,
    { id: meta.id, dayKey: meta.dayKey, albumId: meta.albumId, timerSeconds: meta.timerSeconds, created: created.length, capturedAt: simStamp(meta.capturedAt) })
  if (replaced) {
    day.check(`capture: retake replaces ${replaced.id} on this device`, 'capture',
      after.photos.some((photo) => photo.id === replaced.id && photo.deletedAt !== null) || after.outbox.some((photo) => photo.id === meta.id))
  }
  if (upload) await uploaded(day, device, meta.id, label)
  return { id: meta.id, meta, countdown: observed.countdown, flashes: observed.flashes }
}

/** The photo reached the server exactly once and left the outbox. */
export async function uploaded(day: Day, device: Device, id: string, label: string, timeout = 30_000): Promise<boolean> {
  let row: ServerPhoto | undefined
  const reached = await expect.poll(() => {
    row = serverPhotos(owner()).find((photo) => photo.id === id)
    return row !== undefined
  }, { timeout }).toBe(true).then(() => true, () => false)
  await expect.poll(async () => (await device.local()).outbox.length, { timeout: 10_000 }).toBe(0).catch(() => undefined)
  await day.settle()
  const puts = day.requests.filter((record) => record.method === 'PUT' && record.path === `/api/photos/${id}`)
  const outbox = (await device.local()).outbox.length
  return day.check(`capture: ${label} — uploaded exactly once (one 201 PUT, one server row, outbox empty)`, 'capture',
    reached && puts.filter((record) => record.status === 201).length === 1 && serverPhotos(owner()).filter((photo) => photo.id === id).length === 1 && outbox === 0,
    { puts: puts.map((record) => ({ status: record.status, failure: record.failure, at: record.at, requestBodyBytes: record.requestBodyBytes })), server: row ?? null, outbox })
}

// --- Ghost -------------------------------------------------------------------

/** The camera shows the album's newest photo as the ghost (or none for a new album). */
export async function ghost(day: Day, device: Device, album: string, label: string): Promise<void> {
  await inAlbum(device, album)
  await device.live()
  const expected = newestIn(album)
  if (!expected) {
    await device.page.waitForTimeout(500)
    day.check(`ghost: ${label} — no ghost in an album with no photos`, 'ghost',
      await device.testId('ghost-image').count() === 0 && await device.testId('ghost-hint').count() === 0)
    return
  }
  await expect(device.testId('ghost-image')).toBeVisible()
  await expect.poll(() => device.testId('ghost-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  let stored: string[] = []
  await expect.poll(async () => {
    stored = (await device.local()).ghosts.filter((entry) => entry.albumId === album).map((entry) => entry.imageId)
    return stored.length === 1 && stored[0] === expected.id
  }, { timeout: 15_000 }).toBe(true).catch(() => undefined)
  const hint = await device.testId('ghost-hint').textContent()
  const source = await device.testId('ghost-image').getAttribute('src')
  day.check(`ghost: ${label} — shows the album's newest photo (${expected.dayKey})`, 'ghost', stored.length === 1 && stored[0] === expected.id && !!hint,
    { expected: expected.id, expectedDay: expected.dayKey, ghostCache: stored, hint, source: source?.startsWith('blob:') ? 'local copy' : source })
}

// --- Trash and Undo ------------------------------------------------------------

/** Trash a photo from its photo screen, then Undo: device and server agree at each point. */
export async function trashAndUndo(day: Day, device: Device, photo: ServerPhoto, label: string): Promise<void> {
  await inAlbum(device, photo.albumId)
  await device.press(device.testId('nav-timeline'))
  await device.press(device.page.locator(`[data-testid="timeline-cell"][data-day="${photo.dayKey}"]`))
  await expect(device.testId('photo-screen')).toBeVisible()
  await device.press(device.testId('photo-delete'))
  await expect(device.testId('undo-trash')).toBeVisible()
  const trashed = await expect.poll(() => serverPhotos(owner()).find((row) => row.id === photo.id)?.deletedAt ?? null, { timeout: 5_000 }).not.toBeNull().then(() => true, () => false)
  const localTrashed = (await device.local()).photos.find((row) => row.id === photo.id)?.deletedAt ?? null
  day.check(`trash: ${label} — moved to Trash on device and server`, 'trash', trashed && localTrashed !== null)
  await device.screenshot('trash-undo')
  await device.press(device.testId('undo-trash-action'))
  await expect(device.testId('undo-trash')).toHaveCount(0)
  const deletedAt = (row: { deletedAt: number | null } | undefined) => row ? row.deletedAt : 'missing'
  const restored = await expect.poll(() => deletedAt(serverPhotos(owner()).find((row) => row.id === photo.id)), { timeout: 5_000 }).toBeNull().then(() => true, () => false)
  await expect.poll(async () => deletedAt((await device.local()).photos.find((row) => row.id === photo.id))).toBeNull().catch(() => undefined)
  const local = (await device.local()).photos.find((row) => row.id === photo.id)
  const patches = day.requests.filter((record) => record.method === 'PATCH' && record.path === `/api/photos/${photo.id}`).slice(-2)
  day.check(`trash: ${label} — Undo restores it on device and server`, 'trash', restored && local?.deletedAt === null,
    { patches: patches.map((record) => ({ status: record.status, at: record.at })) })
  await home(device)
}

// --- Timelapse -----------------------------------------------------------------

/** Play the album's timelapse through to its last frame; the frame count matches the server. */
export async function timelapse(day: Day, device: Device, album: string): Promise<void> {
  const expected = active(serverPhotos(owner())).filter((photo) => photo.albumId === album).length
  await inAlbum(device, album)
  await device.press(device.testId('nav-timeline'))
  await expect(device.testId('timeline-screen')).toBeVisible()
  await expect(device.testId('timeline-cell')).toHaveCount(expected)
  if (expected < 2) {
    day.check(`timelapse: ${albumName(album)} has ${expected} photo — play stays hidden until there are two`, 'timelapse', await device.testId('play-timelapse').count() === 0, { frames: expected })
    await home(device)
    return
  }
  await device.press(device.testId('play-timelapse'))
  await expect(device.testId('playback-summary')).toContainText(`${expected} frames`)
  await expect(device.testId('playback-position')).toContainText(`${expected} of ${expected}`, { timeout: 60_000 })
  await expect.poll(() => device.testId('playback-frame').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  const masters = day.requests.filter((record) => record.context === device.name && /^\/api\/photos\/[^/]+\/master$/.test(record.path) && record.step === day.label().step)
  day.check(`timelapse: ${albumName(album)} plays all ${expected} frames to the end`, 'timelapse', true,
    { frames: expected, position: await device.testId('playback-position').textContent(), mastersFetched: masters.length })
  await device.screenshot('timelapse-end')
  await home(device)
}

// --- Download my photos (ZIP) -----------------------------------------------------

function zipEntries(bytes: Buffer): string[] {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('Not a ZIP file')
  const count = bytes.readUInt16LE(end + 10)
  const names: string[] = []
  let offset = bytes.readUInt32LE(end + 16)
  for (let entry = 0; entry < count; entry++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Broken ZIP central directory')
    const nameLength = bytes.readUInt16LE(offset + 28)
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString())
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  return names
}

/** Settings → Download my photos: the ZIP (read in memory, never saved) holds one entry per active photo. */
export async function downloadZip(day: Day, device: Device): Promise<void> {
  const expected = active(serverPhotos(owner()))
  await home(device)
  await device.press(device.testId('nav-settings'))
  let bytes: Buffer
  let path: string
  if (device.name === 'phone') {
    await device.page.evaluate(() => { (window as unknown as { __simShared: unknown }).__simShared = null })
    await device.press(device.testId('download-photos'))
    await expect.poll(() => device.page.evaluate(() => (window as unknown as { __simShared: unknown }).__simShared !== null), { timeout: 60_000 }).toBe(true)
    const shared = await device.page.evaluate(async () => {
      const file = (window as unknown as { __simShared: File }).__simShared
      const data = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000))
      return { name: file.name, type: file.type, base64: btoa(binary) }
    })
    bytes = Buffer.from(shared.base64, 'base64')
    path = `share sheet: ${shared.name} (${shared.type})`
  } else {
    const download = device.page.waitForEvent('download', { timeout: 60_000 })
    await device.press(device.testId('download-photos'))
    const file = await download
    const stream = await file.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    bytes = Buffer.concat(chunks)
    path = `download: ${file.suggestedFilename()}`
    await file.delete()
  }
  const names = zipEntries(bytes)
  const ids = new Set(expected.map((photo) => photo.id))
  day.check(`timelapse: ${device.name} "Download my photos" ZIP has one entry per active photo (${expected.length})`, 'timelapse',
    names.length === expected.length && names.every((name) => ids.has((name.split('/')[1] ?? '').slice(11).replace(/\.(jpg|webp)$/, ''))),
    { path, bytes: bytes.length, entries: names.length, active: expected.length, sample: names.slice(0, 3) })
  await home(device)
}

// --- Offline ----------------------------------------------------------------------

/**
 * Go offline and reopen: the shell comes from the service worker, cached
 * thumbnails draw, and nothing under /api is in Cache Storage. Optionally
 * takes a photo while offline (it waits in the outbox).
 */
export async function offlineVisit(day: Day, device: Device, album: string, during?: () => Promise<void>): Promise<void> {
  await device.setOffline(true)
  const response = await device.page.reload()
  await expect(device.testId('capture-screen')).toBeVisible({ timeout: 20_000 })
  // Recorded because Chromium's emulation reports a document loaded while offline as online (see backOnline).
  const onLine = await device.page.evaluate(() => navigator.onLine)
  day.check(`offline: ${device.name} reopens offline from the service worker`, 'offline', response?.fromServiceWorker() === true && response.status() === 200,
    { status: response?.status() ?? null, fromServiceWorker: response?.fromServiceWorker() ?? false, navigatorOnLine: onLine })
  await during?.()
  await inAlbum(device, album)
  await device.press(device.testId('nav-timeline'))
  const cells = device.testId('timeline-cell')
  await expect(cells.first()).toBeVisible()
  // Every cell on screen must draw its thumbnail (cells further down load as they near the viewport).
  const onScreen = () => cells.evaluateAll((buttons: HTMLElement[]) => buttons.filter((cell) => {
    const rect = cell.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight
  }).map((cell) => {
    const image = cell.querySelector('img')
    return { day: cell.dataset.day, loaded: !!image && image.complete && image.naturalWidth > 0, source: !image ? 'none' : image.src.startsWith('blob:') ? 'local' : 'http-cache' }
  }))
  await expect.poll(async () => (await onScreen()).every((cell) => cell.loaded), { timeout: 15_000 }).toBe(true).catch(() => undefined)
  const visible = await onScreen()
  day.check(`offline: ${device.name} timeline thumbnails on screen draw offline`, 'offline', visible.length > 0 && visible.every((cell) => cell.loaded),
    { cells: await cells.count(), onScreen: visible.length, loaded: visible.filter((cell) => cell.loaded).length, missing: visible.filter((cell) => !cell.loaded), sources: visible.map((cell) => cell.source) })
  await device.screenshot('offline-timeline')
  const storage = await device.storage() as { cacheStorage: Array<{ name: string; entries: number; apiEntries: number }> } | null
  day.check(`offline: ${device.name} Cache Storage holds no /api responses`, 'offline', !!storage && storage.cacheStorage.every((cache) => cache.apiEntries === 0),
    storage?.cacheStorage.map((cache) => ({ name: cache.name, entries: cache.entries, apiEntries: cache.apiEntries })))
  await home(device)
}

export interface Reconnect { at: number; pageAt: number; afterSeq: number; onlineEvent: 'browser' | 'harness'; nudged: boolean }

/**
 * Back online, as the phone's OS would deliver it. Chromium's network emulation
 * fires no `online` event in a document that was loaded while offline (it even
 * reports navigator.onLine as true there), which a real phone does fire; when the
 * page saw none within a second, the harness dispatches it and says so.
 * `nudged` means the app only synced after the harness raised visibilitychange.
 */
export async function backOnline(day: Day, device: Device): Promise<Reconnect> {
  const afterSeq = day.nextSeq()
  const pageAt = await device.page.evaluate(() => Date.now())
  const at = day.simNow()
  await device.setOffline(false)
  const delivered = () => device.observed().then((observed) => observed.events.some((event) => event.type === 'online' && event.at >= pageAt))
  const browser = await expect.poll(delivered, { timeout: 1000 }).toBe(true).then(() => true, () => false)
  if (!browser) await device.page.evaluate(() => window.dispatchEvent(new Event('online')))
  const nudged = await synced(day, device, afterSeq, 30_000).then(() => false, async () => { await device.sync(); return true })
  return { at, pageAt, afterSeq, onlineEvent: browser ? 'browser' : 'harness', nudged }
}

/** Seconds (simulated) from reconnecting to the photo's upload starting, with the first request and the page's own events. */
export async function reconnectTiming(day: Day, device: Device, reconnect: Reconnect, id: string) {
  const seconds = (ms: number, from: number) => Math.round((ms - from) / 100) / 10
  const after = day.requests.filter((record) => record.context === device.name && record.seq > reconnect.afterSeq).sort((a, b) => a.seq - b.seq)
  const put = after.find((record) => record.method === 'PUT' && record.path === `/api/photos/${id}` && record.status === 201)
  const first = after.find((record) => record.path.startsWith('/api/'))
  const events = (await device.observed()).events.filter((event) => event.at >= reconnect.pageAt)
  return {
    uploadStartedSeconds: put ? seconds(put.ms, reconnect.at) : null,
    firstRequest: first ? { method: first.method, path: first.path.replace(/\?.*$/, ''), seconds: seconds(first.ms, reconnect.at) } : null,
    onlineEvent: reconnect.onlineEvent,
    nudged: reconnect.nudged,
    pageEvents: events.map((event) => ({ ...event, at: seconds(event.at, reconnect.pageAt) })),
  }
}

// --- Albums, reminders, accounts ------------------------------------------------------

/** The device's local copy matches the server: same albums, same active and trashed photos. */
export async function matchesServer(day: Day, device: Device, name: string, feature: 'sync' | 'albums' = 'sync'): Promise<boolean> {
  const server = live(serverPhotos(owner()))
  const albums = serverAlbums(owner())
  let detail: unknown = null
  const pass = await expect.poll(async () => {
    const local = await device.local()
    const ids = (photos: Array<{ id: string; deletedAt: number | null }>, trashed: boolean) => photos.filter((photo) => (photo.deletedAt !== null) === trashed).map((photo) => photo.id).sort().join()
    detail = {
      activeLocal: local.photos.filter((photo) => photo.deletedAt === null).length, activeServer: active(server).length,
      trashedLocal: local.photos.filter((photo) => photo.deletedAt !== null).length, trashedServer: server.length - active(server).length,
      albums: local.albums.map((album) => album.name), outbox: local.outbox.length,
    }
    return ids(local.photos, false) === ids(server, false) && ids(local.photos, true) === ids(server, true) &&
      local.albums.map((album) => `${album.id}:${album.name}`).sort().join() === albums.map((album) => `${album.id}:${album.name}`).sort().join()
  }, { timeout: 15_000 }).toBe(true).then(() => true, () => false)
  return day.check(name, feature, pass, detail)
}

export async function openSettings(device: Device): Promise<void> {
  await home(device)
  await device.press(device.testId('nav-settings'))
  await expect(device.testId('reminders')).toBeVisible()
}

/** Change one album's reminder from Settings and wait for the server to have it. */
export async function reminder(day: Day, device: Device, album: string, change: { enabled?: boolean; time?: string }, label: string): Promise<void> {
  await openSettings(device)
  const row = device.testId(`reminder-${album}`)
  const toggle = device.testId(`reminder-toggle-${album}`)
  const taps = device.taps
  await expect(toggle).toBeEnabled()
  if (change.time) {
    const saved = device.page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/api/push/prefs') && response.request().method() !== 'GET')
    await row.locator('input[type="time"]').fill(change.time)
    await saved
    await expect(row).toHaveAttribute('aria-busy', 'false')
  }
  if (change.enabled !== undefined && (await toggle.getAttribute('aria-checked') === 'true') !== change.enabled) {
    await device.press(toggle)
    await expect(toggle).toHaveAttribute('aria-checked', String(change.enabled))
    await expect(row).toHaveAttribute('aria-busy', 'false')
  }
  let pref: ReturnType<typeof serverPrefs>[number] | undefined
  const pass = await expect.poll(() => {
    pref = serverPrefs(owner()).find((item) => item.albumId === album)
    return !!pref && (change.enabled === undefined || !!pref.enabled === change.enabled) && (!change.time || pref.time === change.time)
  }).toBe(true).then(() => true, () => false)
  day.check(`push: ${label}`, 'push', pass, { pref, subscriptions: serverSubscriptions(owner()).length, tapsInSettings: device.taps - taps })
  await home(device)
}

export function pushDetail(messages: PushMessage[]) {
  return messages.map((message) => ({
    album: message.payload.albumId, event: message.event, title: message.payload.title, body: message.payload.body, url: message.payload.url,
    tag: message.payload.tag, receivedAt: message.receivedAt, ttl: message.headers.ttl, urgency: message.headers.urgency,
    vapid: message.vapid,
  }))
}

/** Run the cron at `time` and check exactly these pushes arrived. */
export async function cronExpect(day: Day, time: string, expected: Array<{ album: string; event: PushEvent }>, name: string): Promise<PushMessage[]> {
  const messages = await day.cron(time)
  day.check(`push: ${name}`, 'push',
    messages.length === expected.length && expected.every((item) => messages.some((message) => message.payload.albumId === item.album && message.event === item.event)),
    { cron: `${day.dayKey} ${time}`, received: pushDetail(messages) })
  return messages
}

export async function signOut(day: Day, device: Device): Promise<void> {
  await openSettings(device)
  await device.press(device.testId('logout'))
  await expect(device.testId('account-screen')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await device.local()).user).toBeNull()
  const state = await device.storage() as { indexedDB: Record<string, { count: number; keys?: string[] }>; localStorage: Array<{ key: string }> }
  const userScoped = (state.indexedDB.kv?.keys ?? []).filter((key) => key === 'user' || key.startsWith('user:'))
  day.check(`accounts: ${device.name} logs out and keeps no user data`, 'accounts',
    userScoped.length === 0 && (state.indexedDB.outbox?.count ?? 0) === 0 && (state.indexedDB.ghosts?.count ?? 0) === 0 && !state.localStorage.some((item) => item.key.startsWith('sad.camera.')),
    { kvKeys: state.indexedDB.kv?.keys ?? [], outbox: state.indexedDB.outbox?.count ?? 0, ghosts: state.indexedDB.ghosts?.count ?? 0, localStorage: state.localStorage.map((item) => item.key), cookies: await device.cookies() })
}

/** End-of-day: nothing waiting to upload, and the device agrees with the server. */
export async function endOfDay(day: Day, device: Device): Promise<void> {
  if (day.offlineByDesign.includes(device.name)) return
  const outbox = (await device.local()).outbox
  day.check(`invariant: ${device.name} outbox empty at the end of the day`, 'invariants', outbox.length === 0, outbox)
}
