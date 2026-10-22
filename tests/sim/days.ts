import { expect } from '@playwright/test'
import { ORIGIN, OUTSIDER, OWNER, PUSH_PORT, digest, pushEndpoint } from './config.ts'
import { DAY_KEYS, at, simStamp } from './calendar.ts'
import type { Device } from './device.ts'
import {
  active, backOnline, capture, cronExpect, downloadZip, ghost, home, inAlbum, matchesServer, newestIn, offlineVisit, openApp, openSettings, reconnectTiming,
  owner, phonePush, pushDetail, reminder, signOut, synced, timelapse, trashAndUndo, uploaded, endOfDay,
} from './flows.ts'
import { r2Photo, serverAlbums, serverPhotos, serverSubscriptions, userId, type ServerPhoto } from './server.ts'
import type { Day } from './sim.ts'

const SELFIES = 'selfies'
const PHONE_ENDPOINT = pushEndpoint('phone')

const photoOn = (album: string, dayKey: string): ServerPhoto => {
  const photo = active(serverPhotos(owner())).find((item) => item.albumId === album && item.dayKey === dayKey)
  if (!photo) throw new Error(`No active ${album} photo on ${dayKey}`)
  return photo
}

/** A signed-out browser asks /api/auth/me once and gets 401 before showing the form. */
const signedOutProbe = (day: Day, context: 'phone' | 'desktop' | 'outsider') =>
  day.expect({ context, method: 'GET', path: /^\/api\/auth\/me$/, status: 401, why: `signed-out ${context} checks its session on open` })

async function switchAlbum(day: Day, device: Device, album: string, label: string): Promise<void> {
  await home(device)
  await device.selectAlbum(album)
  const name = serverAlbums(owner()).find((item) => item.id === album)?.name ?? album
  await expect(device.testId('active-album-picker')).toContainText(name)
  day.check(`albums: ${device.name} switches to ${label}`, 'albums', (await device.local()).activeAlbumId === album, { album, name })
}

/** The desktop's daily visit: sign in through the form, see the phone's day, do `work`, log out. */
async function desktopVisit(day: Day, time: string, work: (desktop: Device) => Promise<void>): Promise<void> {
  signedOutProbe(day, 'desktop')
  const desktop = await day.desktop(time)
  await day.step('desktop signs in', 'login', () => openApp(day, desktop, 'form'))
  await day.step('desktop sees the phone', 'sync', async () => {
    await matchesServer(day, desktop, 'sync: desktop sees the phone\'s photos and albums (phone → desktop)')
    await desktop.screenshot('camera')
  })
  await work(desktop)
  await day.snapshot('before logout', 'desktop')
  await day.step('desktop logs out', 'accounts', () => signOut(day, desktop))
  await day.snapshot('after logout', 'desktop')
  await day.close('desktop')
}

/** The phone picks up the desktop's change (desktop → phone). */
async function phoneSees(day: Day, phone: Device, what: string): Promise<void> {
  await day.step(`phone sees ${what}`, 'sync', async () => {
    await home(phone)
    await phone.sync()
    await matchesServer(day, phone, `sync: phone sees ${what} (desktop → phone)`)
  })
}

async function evening(day: Day, phone: Device, album: string, nudge: Array<{ album: string; event: 'nudge' }> = []): Promise<void> {
  await day.step('20:35 evening cron', 'push', () => cronExpect(day, '20:35', nudge,
    nudge.length ? 'evening nudge at 20:35 (one)' : 'no evening nudge at 20:35 (nothing missing)'))
  await day.advance('21:30')
  await day.step('offline at night', 'offline', async () => {
    await offlineVisit(day, phone, album)
    await backOnline(day, phone)
  })
  await day.step('end of day', 'invariants', async () => {
    await matchesServer(day, phone, 'sync: phone matches the server at the end of the day')
    await endOfDay(day, phone)
    await phone.screenshot('evening')
  })
  await day.snapshot('evening', 'phone')
}

async function cameraTimer(device: Device): Promise<number> {
  await device.live()
  return Number(await device.testId('camera-timer').getAttribute('data-seconds'))
}

// --- Day 1 · Tue 2026-10-27 -------------------------------------------------------

async function day1(day: Day): Promise<void> {
  day.edge('Sign-up on a fresh phone')
  day.edge('Reminder at the album\'s time before the day\'s photo: one push at 09:05')
  day.edge('No push after the day\'s photo (09:15 cron)')
  signedOutProbe(day, 'phone')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone signs up', 'login', () => openApp(day, phone, 'signup'))
  await day.step('turn on the Selfies reminder', 'push', async () => {
    const taps = phone.taps
    await phone.press(phone.testId('nav-settings'))
    const toggle = phone.testId(`reminder-toggle-${SELFIES}`)
    await expect(toggle).toBeInViewport()
    await expect(toggle).toBeEnabled()
    await phone.press(toggle)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(phone.testId(`reminder-${SELFIES}`)).toHaveAttribute('aria-busy', 'false')
    await phone.screenshot('settings-reminder-on')
    const subscriptions = serverSubscriptions(owner())
    day.check('push: Selfies reminder on in two taps (Settings, switch); permission granted; this phone subscribed', 'push',
      phone.taps - taps === 2 && subscriptions.some((item) => item.endpoint === PHONE_ENDPOINT) && phonePush.read().permission === 'granted',
      { taps: phone.taps - taps, subscriptions: subscriptions.map((item) => ({ endpoint: item.endpoint, timeZone: item.timeZone })) })
    await home(phone)
    await phone.screenshot('camera')
  })
  await day.step('09:05 reminder', 'push', async () => {
    const [message] = await cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'reminder at 09:05 before today\'s photo (one)')
    if (!message) return
    day.check('push: reminder payload names the album and opens it; VAPID for the push origin, 12 h expiry; aes128gcm', 'push',
      message.payload.title === 'Selfies' && message.payload.body === 'Time for today\'s photo.' && message.payload.url === `/?album=${SELFIES}` &&
      message.payload.tag === `album-${SELFIES}` && message.vapid.audience === `http://127.0.0.1:${PUSH_PORT}` && message.vapid.expiresHoursAfterCron === 12 &&
      message.headers.contentEncoding === 'aes128gcm', pushDetail([message]))
  })
  await day.advance('09:10')
  await day.step('create Gym, switch back to Selfies', 'albums', async () => {
    const gym = await phone.createAlbum('Gym')
    day.memo.set('gym', gym)
    day.check('albums: phone creates "Gym"; it becomes the active album and exists on the server', 'albums',
      serverAlbums(owner()).some((album) => album.id === gym && album.name === 'Gym'), { gym })
    await switchAlbum(day, phone, SELFIES, 'Selfies')
  })
  await day.step('no ghost on day 1', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies on day 1'))
  await day.step('capture Selfies 3 s', 'capture', async () => {
    await capture(day, phone, { album: SELFIES, timer: 3 })
    await phone.screenshot('camera-saved')
  })
  await day.step('09:15 cron after the photo', 'push', () => cronExpect(day, '09:15', [], 'no push after today\'s photo (09:15)'))
  await day.step('trash and undo', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, day.dayKey), 'today\'s Selfies photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await desktopVisit(day, '19:00', async (desktop) => {
    await day.step('desktop renames Gym', 'albums', async () => {
      await desktop.renameAlbum(day.memo.need('gym'), 'Gym days')
      day.check('albums: desktop renames "Gym" to "Gym days"', 'albums', serverAlbums(owner()).some((album) => album.name === 'Gym days'))
    })
  })
  await phoneSees(day, phone, 'the rename to "Gym days"')
  await evening(day, phone, SELFIES)
}

// --- Day 2 · Wed 2026-10-28 -------------------------------------------------------

async function day2(day: Day): Promise<void> {
  day.edge('Duplicate cron at the same scheduledTime (09:05 twice) still sends one reminder')
  day.edge('The second device inherits each album\'s timer from its latest photo (Selfies 5 s, Gym days 10 s)')
  const gym = day.memo.need<string>('gym')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('duplicate 09:05 cron', 'push', async () => {
    const first = await day.cron('09:05')
    const second = await day.cron('09:05')
    day.check('push: duplicate cron at the same scheduledTime sends one reminder', 'push',
      first.length === 1 && first[0]?.event === 'reminder' && second.length === 0, { first: pushDetail(first), second: pushDetail(second) })
  })
  await day.step('ghost is yesterday', 'ghost', async () => {
    await ghost(day, phone, SELFIES, 'Selfies shows yesterday')
    day.check('ghost: hint names yesterday', 'ghost', /yesterday/i.test(await phone.testId('ghost-hint').textContent() ?? ''))
  })
  await day.step('capture Selfies 5 s', 'capture', () => capture(day, phone, { album: SELFIES, timer: 5 }))
  await day.step('switch to Gym days and capture 10 s', 'albums', async () => {
    await switchAlbum(day, phone, gym, 'Gym days')
    await ghost(day, phone, gym, 'Gym days before its first photo')
    await capture(day, phone, { album: gym, timer: 10 })
    await switchAlbum(day, phone, SELFIES, 'Selfies')
  })
  await day.step('trash and undo yesterday', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, DAY_KEYS[0]), 'yesterday\'s Selfies photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await desktopVisit(day, '12:00', async (desktop) => {
    await day.step('desktop inherits timers', 'capture', async () => {
      await inAlbum(desktop, SELFIES)
      const selfies = await cameraTimer(desktop)
      await inAlbum(desktop, gym)
      const gymTimer = await cameraTimer(desktop)
      day.check('capture: second device inherits the album timer (Selfies 5 s, Gym days 10 s)', 'capture', selfies === 5 && gymTimer === 10, { selfies, gym: gymTimer })
    })
    await day.step('desktop creates Travel', 'albums', async () => {
      const travel = await desktop.createAlbum('Travel')
      day.memo.set('travel', travel)
      day.check('albums: desktop creates "Travel"', 'albums', serverAlbums(owner()).some((album) => album.id === travel && album.name === 'Travel'), { travel })
    })
  })
  await phoneSees(day, phone, 'the new "Travel" album')
  await evening(day, phone, SELFIES)
}

// --- Day 3 · Thu 2026-10-29 -------------------------------------------------------

async function day3(day: Day): Promise<void> {
  day.edge('Photo taken offline waits in the outbox and uploads exactly once when back online')
  day.edge('A photo taken on the desktop becomes the phone\'s ghost for that album')
  day.edge('"Download my photos" ZIP on the phone (share sheet)')
  const travel = day.memo.need<string>('travel')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('09:05 reminder', 'push', () => cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'reminder at 09:05 (one)'))
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  let offlineId = ''
  await day.step('offline capture Selfies 3 s', 'offline', async () => {
    await offlineVisit(day, phone, SELFIES, async () => {
      const shot = await capture(day, phone, { album: SELFIES, timer: 3, upload: false, label: 'offline Selfies 3s' })
      offlineId = shot.id
      const state = await phone.local()
      day.check('offline: photo taken offline waits in the outbox (not on the server)', 'offline',
        state.outbox.some((entry) => entry.id === offlineId) && !serverPhotos(owner()).some((photo) => photo.id === offlineId),
        { outbox: state.outbox.map((entry) => ({ id: entry.id, attempts: entry.attempts, error: entry.error })) })
      await expect(phone.testId('cloud-status')).toBeVisible()
      day.check('offline: camera says the photo is waiting to upload', 'offline', true, { status: await phone.testId('cloud-status').textContent() })
      await phone.screenshot('offline-outbox')
    })
    const reconnect = await backOnline(day, phone)
    await uploaded(day, phone, offlineId, 'offline Selfies photo after reconnecting')
    const timing = await reconnectTiming(day, phone, reconnect, offlineId)
    day.check('offline: the offline photo starts uploading within 15 s of reconnecting, without a nudge', 'offline',
      !timing.nudged && timing.uploadStartedSeconds !== null && timing.uploadStartedSeconds <= 15, timing)
    day.notes.push(`Offline photo started uploading ${timing.uploadStartedSeconds ?? '–'} s (simulated) after reconnecting`)
  })
  await desktopVisit(day, '10:00', async (desktop) => {
    await day.step('desktop captures in Travel', 'capture', async () => {
      await switchAlbum(day, desktop, travel, 'Travel')
      await ghost(day, desktop, travel, 'Travel before its first photo (desktop)')
      const shot = await capture(day, desktop, { album: travel, timer: 5 })
      day.memo.set('travelPhoto', shot.id)
    })
  })
  await day.advance('10:30')
  await phoneSees(day, phone, 'the desktop\'s Travel photo')
  await day.step('phone ghost is the desktop photo', 'ghost', async () => {
    await switchAlbum(day, phone, travel, 'Travel')
    await ghost(day, phone, travel, 'Travel shows the desktop\'s photo from today')
  })
  await day.step('trash and undo the desktop photo', 'trash', () => trashAndUndo(day, phone, photoOn(travel, day.dayKey), 'the desktop\'s Travel photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await day.step('ZIP on the phone', 'timelapse', () => downloadZip(day, phone))
  await evening(day, phone, SELFIES)
}

// --- Day 4 · Fri 2026-10-30 -------------------------------------------------------

async function day4(day: Day): Promise<void> {
  day.edge('Retake on the same day: the first photo goes to Trash; the desktop sees one active photo')
  day.edge('Restoring the retaken photo → 409 day_taken, shown as a friendly message')
  day.edge('Gym days reminder moved to 07:30 and turned on (fires on day 5)')
  const gym = day.memo.need<string>('gym')
  const travel = day.memo.need<string>('travel')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('09:05 reminder', 'push', () => cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'reminder at 09:05 (one)'))
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  await day.step('capture and retake', 'capture', async () => {
    const first = await capture(day, phone, { album: SELFIES, timer: 10 })
    await day.advance('09:20')
    await ghost(day, phone, SELFIES, 'Selfies shows today\'s first photo before the retake')
    const second = await capture(day, phone, { album: SELFIES, timer: 3, label: 'retake Selfies 3s' })
    day.memo.set('retaken', first.id)
    const today = serverPhotos(owner()).filter((photo) => photo.albumId === SELFIES && photo.dayKey === day.dayKey)
    day.check('capture: retake puts the first photo in Trash; one active Selfies photo today on the server', 'capture',
      today.filter((photo) => photo.deletedAt === null).map((photo) => photo.id).join() === second.id && today.some((photo) => photo.id === first.id && photo.deletedAt !== null),
      today.map((photo) => ({ id: photo.id, trashed: photo.deletedAt !== null, timerSeconds: photo.timerSeconds })))
    await phone.screenshot('camera-retaken')
  })
  await day.step('trash and undo Gym days', 'trash', async () => {
    await switchAlbum(day, phone, gym, 'Gym days')
    await trashAndUndo(day, phone, photoOn(gym, DAY_KEYS[1]), 'the day-2 Gym days photo')
  })
  await day.step('Gym days reminder 07:30', 'push', () => reminder(day, phone, gym, { time: '07:30', enabled: true }, 'Gym days reminder set to 07:30 and on'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  day.expect({ context: 'desktop', method: 'PATCH', path: /^\/api\/photos\/[0-9a-z]{20}$/, status: 409, why: 'restoring the retaken photo while its day has a photo' })
  await desktopVisit(day, '18:00', async (desktop) => {
    await day.step('desktop sees one photo for the retaken day', 'sync', async () => {
      const local = (await desktop.local()).photos.filter((photo) => photo.albumId === SELFIES && photo.dayKey === day.dayKey)
      await inAlbum(desktop, SELFIES)
      await desktop.press(desktop.testId('nav-timeline'))
      const cells = await desktop.page.locator(`[data-testid="timeline-cell"][data-day="${day.dayKey}"]`).count()
      day.check('capture: second device sees one active photo for the retaken day (and the first in Trash)', 'capture',
        cells === 1 && local.filter((photo) => photo.deletedAt === null).length === 1 && local.some((photo) => photo.id === day.memo.get('retaken') && photo.deletedAt !== null),
        { timelineCells: cells, local: local.map((photo) => ({ id: photo.id, trashed: photo.deletedAt !== null })) })
      await home(desktop)
    })
    await day.step('desktop restore → day_taken', 'trash', async () => {
      await desktop.press(desktop.testId('nav-settings'))
      await desktop.press(desktop.testId('open-trash'))
      const item = desktop.testId('trash-item').filter({ hasText: 'Oct 30, 2026' })
      await expect(item).toHaveCount(1)
      await desktop.press(item.getByRole('button', { name: 'Restore' }))
      const toast = desktop.testId('toast')
      await expect(toast).toContainText('This day already has a photo. Move it to Trash first.')
      await desktop.screenshot('trash-day-taken')
      await day.settle()
      const patch = day.requests.filter((record) => record.context === 'desktop' && record.method === 'PATCH' && record.path === `/api/photos/${day.memo.need<string>('retaken')}`)
      const row = serverPhotos(owner()).find((photo) => photo.id === day.memo.get('retaken'))
      day.check('trash: restoring the retaken photo → 409 day_taken, friendly message, photo stays in Trash', 'trash',
        patch.some((record) => record.status === 409) && row?.deletedAt !== null, { toast: await toast.textContent(), patch: patch.map((record) => record.status) })
      await home(desktop)
    })
    await day.step('desktop renames Travel', 'albums', async () => {
      await desktop.renameAlbum(travel, 'Trips')
      day.check('albums: desktop renames "Travel" to "Trips"', 'albums', serverAlbums(owner()).some((album) => album.id === travel && album.name === 'Trips'))
    })
  })
  await phoneSees(day, phone, 'the rename to "Trips"')
  await evening(day, phone, SELFIES)
}

// --- Day 5 · Sat 2026-10-31 -------------------------------------------------------

async function day5(day: Day): Promise<void> {
  day.edge('Overnight site-storage eviction (IndexedDB, localStorage, Cache Storage, service worker; cookies kept) → hint-cookie sign-in path')
  day.edge('Reminder at a second album\'s own time (Gym days 07:30)')
  day.edge('Evening nudge at 20:35 (one); a second cron at 20:40 sends none; nothing after the evening photo (21:05)')
  const gym = day.memo.need<string>('gym')
  const phone = await day.phone('07:20', phonePush, async (device) => {
    const cdp = await device.context.newCDPSession(device.page)
    await cdp.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'indexeddb,local_storage,cache_storage,service_workers' })
    await cdp.detach()
    phonePush.update({ subscribed: false })
  })
  await day.step('phone reopens after eviction', 'login', async () => {
    await openApp(day, phone, 'hint')
    await matchesServer(day, phone, 'offline: evicted local data rebuilt from the server')
  })
  await day.step('device re-subscribes', 'push', async () => {
    await expect.poll(() => day.requests.some((record) => record.context === 'phone' && record.method === 'PUT' && record.path === '/api/push/subscription' && (record.status ?? 0) < 300), { timeout: 15_000 }).toBe(true)
    day.check('push: after eviction the phone re-subscribes on its own (permission kept)', 'push', phonePush.read().subscribed && serverSubscriptions(owner()).some((item) => item.endpoint === PHONE_ENDPOINT))
  })
  await day.step('timer after eviction', 'capture', async () => {
    await inAlbum(phone, SELFIES)
    const latest = newestIn(SELFIES)
    const timer = await cameraTimer(phone)
    day.check('capture: after eviction the Selfies timer comes back from the album\'s latest photo', 'capture', timer === latest?.timerSeconds, { timer, latest: latest?.timerSeconds })
  })
  await day.step('07:35 Gym days reminder', 'push', () => cronExpect(day, '07:35', [{ album: gym, event: 'reminder' }], 'Gym days reminder at 07:35 (its own 07:30 time)'))
  await day.advance('08:00')
  await day.step('capture Gym days', 'capture', async () => {
    await switchAlbum(day, phone, gym, 'Gym days')
    await ghost(day, phone, gym, 'Gym days shows its day-2 photo')
    await capture(day, phone, { album: gym, timer: 5 })
  })
  await day.step('09:05 Selfies reminder', 'push', () => cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'Selfies reminder at 09:05 (one)'))
  await day.step('trash and undo Gym days', 'trash', () => trashAndUndo(day, phone, photoOn(gym, day.dayKey), 'today\'s Gym days photo'))
  await day.step('Gym days reminders off', 'push', () => reminder(day, phone, gym, { enabled: false }, 'Gym days reminders turned off'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, gym))
  await desktopVisit(day, '12:00', async (desktop) => {
    await day.step('desktop creates Reading', 'albums', async () => {
      const reading = await desktop.createAlbum('Reading')
      day.memo.set('reading', reading)
      day.check('albums: desktop creates "Reading"', 'albums', serverAlbums(owner()).some((album) => album.id === reading), { reading })
    })
  })
  await phoneSees(day, phone, 'the new "Reading" album')
  await day.step('switch back to Selfies', 'albums', () => switchAlbum(day, phone, SELFIES, 'Selfies'))
  await day.step('20:35 nudge, 20:40 none', 'push', async () => {
    await cronExpect(day, '20:35', [{ album: SELFIES, event: 'nudge' }], 'evening nudge at 20:35 for Selfies (one)')
    await cronExpect(day, '20:40', [], 'second evening cron at 20:40 sends no second nudge')
  })
  await day.advance('21:00')
  await day.step('evening Selfies photo', 'capture', async () => {
    await ghost(day, phone, SELFIES, 'Selfies shows yesterday')
    await capture(day, phone, { album: SELFIES, timer: 3 })
  })
  await day.step('21:05 none', 'push', () => cronExpect(day, '21:05', [], 'no push after the evening photo (21:05)'))
  await day.advance('21:30')
  await day.step('offline at night', 'offline', async () => {
    await offlineVisit(day, phone, SELFIES)
    await backOnline(day, phone)
  })
  await day.step('end of day', 'invariants', async () => {
    await matchesServer(day, phone, 'sync: phone matches the server at the end of the day')
    await endOfDay(day, phone)
  })
  await day.snapshot('evening', 'phone')
}

// --- Day 6 · Sun 2026-11-01 (daylight saving time ends) --------------------------------

async function day6(day: Day): Promise<void> {
  day.edge('Daylight saving time ends at 02:00: the 09:00 reminder follows local time (08:05 PST none, 09:05 PST one)')
  day.edge('An album with reminders off (Gym days) gets nothing at 07:35')
  day.edge('Thirty simulated minutes offline with a queued photo; upload time after reconnecting is measured')
  day.edge('Desktop "Download my photos" ZIP (download path); desktop trashes a photo the phone then sees in Trash')
  const travel = day.memo.need<string>('travel')
  const phone = await day.phone('07:20', phonePush)
  day.check('calendar: 07:20 on 2026-11-01 is PST (UTC−8)', 'invariants', simStamp(at(day.dayKey, '07:20')).endsWith('PST') && simStamp(at(day.dayKey, '00:30')).endsWith('PDT'),
    { at0030: simStamp(at(day.dayKey, '00:30')), at0720: simStamp(at(day.dayKey, '07:20')) })
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('morning crons across DST', 'push', async () => {
    await cronExpect(day, '07:35', [], 'Gym days reminders off → nothing at 07:35')
    await cronExpect(day, '08:05', [], 'DST: nothing at 08:05 PST (= 09:05 PDT)')
    await cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'DST: Selfies reminder at 09:05 PST (one)')
  })
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows last night\'s photo'))
  await day.step('long offline capture', 'offline', async () => {
    let id = ''
    await offlineVisit(day, phone, SELFIES, async () => {
      id = (await capture(day, phone, { album: SELFIES, timer: 5, upload: false, label: 'offline Selfies 5s' })).id
    })
    await day.runMinutes(30)
    const waiting = (await phone.local()).outbox.find((entry) => entry.id === id)
    day.check('offline: after 30 offline minutes the photo is still queued', 'offline', !!waiting && !serverPhotos(owner()).some((photo) => photo.id === id), waiting)
    const reconnect = await backOnline(day, phone)
    if (!await expect.poll(() => serverPhotos(owner()).some((photo) => photo.id === id), { timeout: 15_000 }).toBe(true).then(() => true, () => false)) {
      for (let minute = 0; minute < 10 && !serverPhotos(owner()).some((photo) => photo.id === id); minute++) await day.runMinutes(1)
    }
    await uploaded(day, phone, id, 'photo queued through 30 offline minutes')
    const timing = await reconnectTiming(day, phone, reconnect, id)
    day.check('offline: after 30 offline minutes the photo starts uploading within 15 s of reconnecting, without a nudge', 'offline',
      !timing.nudged && timing.uploadStartedSeconds !== null && timing.uploadStartedSeconds <= 15, { ...timing, attemptsWhileOffline: waiting?.attempts })
    day.notes.push(`Queued photo started uploading ${timing.uploadStartedSeconds ?? '–'} s (simulated) after reconnecting (${waiting?.attempts ?? '?'} attempts while offline)`)
  })
  await day.step('trash and undo', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, day.dayKey), 'today\'s Selfies photo'))
  await day.step('phone ghost in Trips', 'ghost', async () => {
    await switchAlbum(day, phone, travel, 'Trips')
    await ghost(day, phone, travel, 'Trips shows the desktop\'s day-3 photo')
  })
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await desktopVisit(day, '13:00', async (desktop) => {
    await day.step('desktop trashes the Trips photo', 'trash', async () => {
      const photo = photoOn(travel, DAY_KEYS[2])
      await inAlbum(desktop, travel)
      await desktop.press(desktop.testId('nav-timeline'))
      await desktop.press(desktop.page.locator(`[data-testid="timeline-cell"][data-day="${photo.dayKey}"]`))
      await desktop.press(desktop.testId('photo-delete'))
      await expect(desktop.testId('undo-trash')).toBeVisible()
      const trashed = await expect.poll(() => serverPhotos(owner()).find((row) => row.id === photo.id)?.deletedAt ?? null).not.toBeNull().then(() => true, () => false)
      day.check('trash: desktop moves the day-3 Trips photo to Trash (no Undo)', 'trash', trashed, { id: photo.id })
      await home(desktop)
    })
    await day.step('desktop ZIP', 'timelapse', () => downloadZip(day, desktop))
  })
  await phoneSees(day, phone, 'the desktop\'s Trash')
  await day.step('Trips ghost after trash', 'ghost', () => ghost(day, phone, travel, 'Trips after its only photo went to Trash'))
  await day.step('switch back to Selfies', 'albums', () => switchAlbum(day, phone, SELFIES, 'Selfies'))
  await evening(day, phone, SELFIES)
}

// --- Day 7 · Mon 2026-11-02 -------------------------------------------------------

async function day7(day: Day): Promise<void> {
  day.edge('Reminder still at 09:00 local on the first weekday after DST (09:05 PST)')
  day.edge('The phone inherits a desktop timer change only when that photo is newer than its own setting')
  const gym = day.memo.need<string>('gym')
  const travel = day.memo.need<string>('travel')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('09:05 reminder', 'push', () => cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'DST: Selfies reminder at 09:05 PST on Monday (one)'))
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  await day.step('capture Selfies 10 s', 'capture', () => capture(day, phone, { album: SELFIES, timer: 10 }))
  await desktopVisit(day, '10:00', async (desktop) => {
    await day.step('desktop captures Gym days 10 s', 'capture', () => capture(day, desktop, { album: gym, timer: 10 }))
    await day.advance('10:30')
    await day.step('desktop captures Trips 3 s', 'capture', () => capture(day, desktop, { album: travel, timer: 3 }))
  })
  await day.advance('11:00')
  await phoneSees(day, phone, 'the desktop\'s Gym days and Trips photos')
  await day.step('timer inheritance', 'capture', async () => {
    await switchAlbum(day, phone, gym, 'Gym days')
    const gymTimer = await cameraTimer(phone)
    day.check('capture: phone takes the desktop\'s newer Gym days timer (10 s over its own 5 s from day 5)', 'capture', gymTimer === 10, { timer: gymTimer })
    await ghost(day, phone, gym, 'Gym days shows the desktop\'s photo from today')
    await switchAlbum(day, phone, travel, 'Trips')
    const tripsTimer = await cameraTimer(phone)
    await phone.setTimer(5)
    await phone.page.reload()
    await expect(phone.testId('capture-screen')).toBeVisible()
    const kept = await cameraTimer(phone)
    day.check('capture: phone keeps its own newer Trips timer (5 s) over the older desktop photo (3 s)', 'capture', tripsTimer === 3 && kept === 5, { before: tripsTimer, afterReopen: kept })
  })
  await day.step('trash and undo the desktop Gym photo', 'trash', () => trashAndUndo(day, phone, photoOn(gym, day.dayKey), 'the desktop\'s Gym days photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await day.step('switch back to Selfies', 'albums', () => switchAlbum(day, phone, SELFIES, 'Selfies'))
  await evening(day, phone, travel)
}

// --- Day 8 · Tue 2026-11-03 -------------------------------------------------------

async function day8(day: Day): Promise<void> {
  day.edge('Reminders off → no push at 09:05')
  day.edge('Notification permission "denied" → Settings shows the blocked note and disables the switches')
  day.edge('Stale desktop tab after another account signed in → 409 user_mismatch before any write; the photo uploads once after signing back in')
  const travel = day.memo.need<string>('travel')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('Selfies reminders off', 'push', () => reminder(day, phone, SELFIES, { enabled: false }, 'Selfies reminders turned off'))
  await day.step('09:05 none', 'push', () => cronExpect(day, '09:05', [], 'reminders off → nothing at 09:05'))
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  await day.step('capture Selfies 3 s', 'capture', () => capture(day, phone, { album: SELFIES, timer: 3 }))
  await day.step('permission denied', 'push', async () => {
    phonePush.update({ permission: 'denied', subscribed: false })
    await openSettings(phone)
    await phone.page.evaluate(() => {
      (window as unknown as { __simPermission: string }).__simPermission = 'denied'
      window.dispatchEvent(new Event('focus'))
    })
    const note = phone.page.locator('#reminders-reason')
    await expect(note).toHaveText('Notifications are blocked. Allow them in iOS Settings or your browser settings.')
    const lines = await note.evaluate((element) => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)))
    const disabled = await phone.page.locator('[data-testid^="reminder-toggle-"]').evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))
    await phone.screenshot('settings-denied')
    day.check('push: permission "denied" shows the blocked note and disables every reminder switch', 'push', disabled, { note: await note.textContent(), lines, disabled })
    await home(phone)
  })
  await day.step('trash and undo', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, day.dayKey), 'today\'s Selfies photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  day.expect({ context: 'desktop', method: 'PUT', path: /^\/api\/photos\/[0-9a-z]{20}$/, status: 409, why: 'stale tab uploads after another account signed in' })
  await desktopVisit(day, '12:00', async (desktop) => {
    await day.step('stale tab gets user_mismatch', 'accounts', async () => {
      await switchAlbum(day, desktop, travel, 'Trips')
      const outsiderBefore = userId(OUTSIDER.username)
      const signup = await day.call(desktop.context.request, 'POST', '/api/auth/signup', 'another account signs up in a second tab (shares the cookie jar)',
        { data: OUTSIDER })
      day.check('accounts: a second account signs in elsewhere in the same browser', 'accounts', signup.status === 201 && outsiderBefore === null, { status: signup.status })
      const before = serverPhotos(owner()).length
      const shot = await capture(day, desktop, { album: travel, timer: 5, upload: false, label: 'stale-tab Trips 5s' })
      await expect(desktop.testId('account-screen')).toBeVisible({ timeout: 20_000 })
      await day.settle()
      const puts = day.requests.filter((record) => record.method === 'PUT' && record.path === `/api/photos/${shot.id}`)
      const outsider = userId(OUTSIDER.username)
      const pending = (await desktop.local()).outbox
      day.check('accounts: stale tab upload → 409 user_mismatch before any write; tab signs out; photo kept on the device', 'accounts',
        puts.length === 1 && puts[0]?.status === 409 && serverPhotos(owner()).length === before && (outsider ? serverPhotos(outsider).length === 0 : false),
        { puts: puts.map((record) => record.status), ownerRows: serverPhotos(owner()).length, outsiderRows: outsider ? serverPhotos(outsider).length : null, outboxOnDevice: pending.length })
      await desktop.screenshot('stale-tab-signed-out')
      await desktop.signIn(OWNER)
      await uploaded(day, desktop, shot.id, 'stale-tab photo after signing back in')
    })
  })
  await phoneSees(day, phone, 'the desktop\'s Trips photo')
  await day.step('switch albums', 'albums', async () => {
    await switchAlbum(day, phone, travel, 'Trips')
    await switchAlbum(day, phone, SELFIES, 'Selfies')
  })
  await evening(day, phone, SELFIES)
}

// --- Day 9 · Wed 2026-11-04 -------------------------------------------------------

async function day9(day: Day): Promise<void> {
  day.edge('Notifications allowed again; Selfies reminder back on')
  day.edge('Logout with a photo waiting to upload: one confirm; Cancel keeps it; OK removes this phone\'s push subscription and all user data')
  day.edge('Signing back in: photos come from the server; the ghost cache holds at most one master per album')
  day.edge('Desktop deletes the day-4 retaken photo permanently (row purged, R2 objects removed)')
  const gym = day.memo.need<string>('gym')
  const phone = await day.phone('08:50', phonePush)
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('permission allowed again', 'push', async () => {
    phonePush.update({ permission: 'granted' })
    await phone.page.evaluate(() => { (window as unknown as { __simPermission: string }).__simPermission = 'granted' })
    await reminder(day, phone, SELFIES, { enabled: true }, 'notifications allowed again; Selfies reminders back on')
    day.check('push: phone subscribed again', 'push', serverSubscriptions(owner()).some((item) => item.endpoint === PHONE_ENDPOINT) && phonePush.read().subscribed)
  })
  await day.step('09:05 reminder', 'push', () => cronExpect(day, '09:05', [{ album: SELFIES, event: 'reminder' }], 'reminder at 09:05 (one)'))
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  await day.step('capture Selfies 5 s', 'capture', () => capture(day, phone, { album: SELFIES, timer: 5 }))
  day.expect({ context: 'phone', path: /^\/api\/photos\//, status: 'failed', why: 'photo uploads blocked to hold a photo in the outbox before logout' })
  signedOutProbe(day, 'phone')
  await day.step('logout with a pending photo', 'accounts', async () => {
    await switchAlbum(day, phone, gym, 'Gym days')
    const cdp = await phone.context.newCDPSession(phone.page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: [`${ORIGIN}/api/photos/*`] })
    const shot = await capture(day, phone, { album: gym, timer: 3, upload: false, label: 'Gym days 3s (held in the outbox)' })
    await expect.poll(async () => (await phone.local()).outbox.find((entry) => entry.id === shot.id)?.attempts ?? 0).toBeGreaterThan(0)
    const dialogs: string[] = []
    phone.page.once('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await openSettings(phone)
    await phone.press(phone.testId('logout'))
    await phone.page.waitForTimeout(500)
    const kept = await phone.local()
    day.check('accounts: logout with a pending photo asks once; Cancel keeps the photo and the session', 'accounts',
      dialogs.length === 1 && kept.user !== null && kept.outbox.some((entry) => entry.id === shot.id), { dialogs, outbox: kept.outbox.length })
    phone.page.once('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.accept() })
    await phone.press(phone.testId('logout'))
    await expect(phone.testId('account-screen')).toBeVisible({ timeout: 20_000 })
    await cdp.send('Network.setBlockedURLs', { urls: [] })
    await cdp.detach()
    await day.settle()
    const state = await phone.storage() as { indexedDB: Record<string, { count: number; keys?: string[] }>; localStorage: Array<{ key: string }> }
    const removed = day.requests.filter((record) => record.context === 'phone' && record.method === 'DELETE' && record.path === '/api/push/subscription')
    day.check('accounts: confirming removes this phone\'s push subscription and all user-scoped local data', 'accounts',
      dialogs.length === 2 && !serverSubscriptions(owner()).some((item) => item.endpoint === PHONE_ENDPOINT) && !phonePush.read().subscribed &&
      (state.indexedDB.kv?.keys ?? []).every((key) => key !== 'user' && !key.startsWith('user:')) && (state.indexedDB.outbox?.count ?? 0) === 0 &&
      (state.indexedDB.ghosts?.count ?? 0) === 0 && !state.localStorage.some((item) => item.key.startsWith('sad.camera.')) && !serverPhotos(owner()).some((photo) => photo.id === shot.id),
      { dialogs: dialogs.length, deleteSubscription: removed.map((record) => record.status), kvKeys: state.indexedDB.kv?.keys ?? [], outbox: state.indexedDB.outbox?.count ?? 0,
        ghosts: state.indexedDB.ghosts?.count ?? 0, localStorage: state.localStorage.map((item) => item.key), cookies: await phone.cookies() })
    await phone.screenshot('signed-out')
    await day.snapshot('after logout', 'phone')
  })
  await day.step('sign back in', 'login', async () => {
    const start = day.nextSeq()
    const taps = await phone.signIn(OWNER)
    const landed = await phone.screen()
    day.check('login: phone signs back in through the form', 'login', landed !== null && landed !== 'account-screen', { taps, landed })
    if (landed !== 'capture-screen') day.notes.push(`After logging out from Settings and signing back in, the phone opened on ${landed}, not the camera`)
    await synced(day, phone, start)
    await matchesServer(day, phone, 'accounts: after signing back in, photos come from the server')
    let ghosts: Array<{ albumId: string; imageId: string }> = []
    const pass = await expect.poll(async () => {
      ghosts = (await phone.local()).ghosts
      const albums = serverAlbums(owner()).filter((album) => newestIn(album.id))
      return albums.every((album) => ghosts.filter((entry) => entry.albumId === album.id).map((entry) => entry.imageId).join() === newestIn(album.id)?.id)
    }, { timeout: 20_000 }).toBe(true).then(() => true, () => false)
    const perAlbum = [...new Set(ghosts.map((entry) => entry.albumId))].map((album) => ({ album, masters: ghosts.filter((entry) => entry.albumId === album).length }))
    day.check('accounts: ghost cache holds at most one master per album (the newest)', 'accounts', pass && perAlbum.every((entry) => entry.masters <= 1), perAlbum)
    await expect.poll(() => serverSubscriptions(owner()).some((item) => item.endpoint === PHONE_ENDPOINT), { timeout: 15_000 }).toBe(true).catch(() => undefined)
    day.check('push: signing back in re-subscribes this phone', 'push', serverSubscriptions(owner()).some((item) => item.endpoint === PHONE_ENDPOINT))
  })
  await day.step('trash and undo', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, day.dayKey), 'today\'s Selfies photo'))
  await day.step('timelapse', 'timelapse', () => timelapse(day, phone, SELFIES))
  await desktopVisit(day, '14:00', async (desktop) => {
    await day.step('desktop deletes the retaken photo permanently', 'trash', async () => {
      const retaken = day.memo.need<string>('retaken')
      const r2Before = r2Photo(owner(), retaken).length
      await desktop.press(desktop.testId('nav-settings'))
      await desktop.press(desktop.testId('open-trash'))
      const item = desktop.testId('trash-item').filter({ hasText: 'Oct 30, 2026' })
      await expect(item).toHaveCount(1)
      await desktop.press(item.getByTestId('trash-delete-permanently'))
      await expect(item.getByTestId('trash-delete-permanently')).toHaveText(/Delete forever\?/)
      await desktop.press(item.getByTestId('trash-delete-permanently'))
      await expect(desktop.testId('toast')).toContainText('Photo deleted permanently.')
      const row = serverPhotos(owner()).find((photo) => photo.id === retaken)
      day.check('trash: desktop deletes the retaken photo permanently (row purged, R2 objects removed)', 'trash',
        row?.purgedAt !== null && row?.purgedAt !== undefined && r2Before === 2 && r2Photo(owner(), retaken).length === 0, { r2Before, r2After: r2Photo(owner(), retaken).length, purged: row?.purgedAt !== null })
      await desktop.screenshot('trash-after-delete')
      await home(desktop)
    })
  })
  await phoneSees(day, phone, 'the permanent delete')
  await evening(day, phone, SELFIES)
}

// --- Day 10 · Thu 2026-11-05 ------------------------------------------------------

async function day10(day: Day): Promise<void> {
  day.edge('Milestone on the 30th distinct Selfies day instead of the reminder (earlier days seeded through the API)')
  day.edge('A third user in a fresh simulated-Safari context sees none of the owner\'s data; the owner\'s photo URLs return 404')
  day.edge('30-frame timelapse and a ZIP of every active photo on the phone')
  const reading = day.memo.need<string>('reading')
  const phone = await day.phone('08:40', phonePush)
  await day.step('seed earlier Selfies days', 'push', async () => {
    const api = await day.api(OWNER)
    const days = new Set(active(serverPhotos(owner())).filter((photo) => photo.albumId === SELFIES && photo.dayKey < day.dayKey).map((photo) => photo.dayKey))
    const jpeg = await phone.page.evaluate(async () => {
      const canvas = new OffscreenCanvas(120, 160)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#5b7fa6'
      context.fillRect(0, 0, 120, 160)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    const bytes = Buffer.from(jpeg)
    let seeded = 0
    for (let back = 1; days.size < 29; back++) {
      const dayKey = new Date(Date.parse(`${DAY_KEYS[0]}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10)
      if (days.has(dayKey)) continue
      const id = digest(`seed ${dayKey}`).toString('hex').slice(0, 20)
      const response = await day.call(api, 'PUT', `/api/photos/${id}`, `seed the Selfies photo for ${dayKey}`, { multipart: {
        meta: JSON.stringify({ albumId: SELFIES, dayKey, capturedAt: at(dayKey, '09:00'), timeZone: 'America/Los_Angeles', tzOffsetMinutes: -420,
          width: 120, height: 160, mime: 'image/jpeg', mirrored: false, source: 'file', timerSeconds: 3 }),
        master: { name: 'master', mimeType: 'image/jpeg', buffer: bytes },
        thumb: { name: 'thumb', mimeType: 'image/jpeg', buffer: bytes },
      } })
      if (response.status !== 201) throw new Error(`Seeding ${dayKey} → ${response.status}`)
      days.add(dayKey)
      seeded++
    }
    day.check('push: 29 earlier distinct Selfies days on the server (seeded through the API)', 'push', days.size === 29, { seeded, distinctDays: days.size, earliest: [...days].sort()[0] })
  })
  await day.step('phone reopens', 'login', () => openApp(day, phone, 'cached'))
  await day.step('09:05 milestone', 'push', async () => {
    const [message] = await cronExpect(day, '09:05', [{ album: SELFIES, event: 'milestone' }], 'milestone instead of the reminder on the 30th day (one)')
    day.check('push: milestone reads "Day 30 today — keep it going."', 'push', message?.payload.body === 'Day 30 today — keep it going.', { body: message?.payload.body })
  })
  await day.step('ghost is yesterday', 'ghost', () => ghost(day, phone, SELFIES, 'Selfies shows yesterday'))
  await day.step('capture Selfies 10 s', 'capture', () => capture(day, phone, { album: SELFIES, timer: 10 }))
  await day.step('trash and undo', 'trash', () => trashAndUndo(day, phone, photoOn(SELFIES, day.dayKey), 'today\'s Selfies photo'))
  await day.step('timelapse 30 frames', 'timelapse', () => timelapse(day, phone, SELFIES))
  await day.step('ZIP on the phone', 'timelapse', () => downloadZip(day, phone))
  await desktopVisit(day, '15:00', async (desktop) => {
    await day.step('desktop renames Reading', 'albums', async () => {
      await desktop.renameAlbum(reading, 'Books')
      day.check('albums: desktop renames "Reading" to "Books"', 'albums', serverAlbums(owner()).some((album) => album.id === reading && album.name === 'Books'))
    })
  })
  await phoneSees(day, phone, 'the rename to "Books"')
  await day.step('switch to Books and back', 'albums', async () => {
    await switchAlbum(day, phone, reading, 'Books')
    await switchAlbum(day, phone, SELFIES, 'Selfies')
  })
  signedOutProbe(day, 'outsider')
  day.expect({ context: 'outsider', method: 'GET', path: /^\/api\/photos\/[0-9a-z]{20}\/(thumb|master)$/, status: 404, why: 'a different account asks for the owner\'s photos' })
  await day.step('third user sees nothing', 'accounts', async () => {
    const outsider = await day.outsider('16:00')
    await openApp(day, outsider, 'form', OUTSIDER)
    await outsider.press(outsider.testId('nav-timeline'))
    await expect(outsider.testId('timeline-empty')).toBeVisible()
    await outsider.screenshot('timeline-empty')
    await home(outsider)
    await outsider.press(outsider.testId('nav-settings'))
    await outsider.press(outsider.testId('open-trash'))
    await expect(outsider.testId('trash-empty')).toBeVisible()
    const ids = [newestIn(SELFIES)!.id, active(serverPhotos(owner()))[0]!.id]
    const statuses = await outsider.page.evaluate(async (photoIds) => Promise.all(photoIds.flatMap((id) => ['thumb', 'master'].map(async (kind) =>
      (await fetch(`/api/photos/${id}/${kind}`)).status))), ids)
    await outsider.page.goto(`/photo/${ids[0]}`)
    await expect(outsider.testId('photo-missing')).toBeVisible()
    await outsider.screenshot('photo-missing')
    const local = await outsider.local()
    const outsiderId = userId(OUTSIDER.username)!
    day.check('accounts: a third user (simulated Safari) sees no photos, no Trash, and 404 for the owner\'s photo URLs', 'accounts',
      statuses.every((status) => status === 404) && local.photos.length === 0 && local.albums.every((album) => album.id === SELFIES) && serverPhotos(outsiderId).length === 0, { statuses, localPhotos: local.photos.length, localAlbums: local.albums.map((album) => album.name) })
    await day.close('outsider')
  })
  await evening(day, phone, SELFIES)
}

export const DAYS: Array<(day: Day) => Promise<void>> = [day1, day2, day3, day4, day5, day6, day7, day8, day9, day10]

/** Where each day's simulated morning starts. */
export const STARTS = ['08:50', '08:50', '08:50', '08:50', '07:20', '07:20', '08:50', '08:50', '08:50', '08:40']
