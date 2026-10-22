import { expect, test } from '@playwright/test'
import { expectNoCameraPhoto, openCamera, pauseCameraClock } from '../e2e-support/camera.ts'
import { createAccount, seedPhoto, signIn, snapshot, syncPage } from '../e2e-support/api.ts'

test('top-corner controls meet 44×44 targets and do not move the frame or shutter', async ({ page }) => {
  await openCamera(page)
  const frame = (await page.getByTestId('capture-frame').boundingBox())!
  const shutter = (await page.getByTestId('shutter').boundingBox())!
  for (const id of ['camera-timer', 'camera-flash']) {
    const button = page.getByTestId(id)
    const box = (await button.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.x).toBeGreaterThanOrEqual(frame.x)
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width)
    expect(box.y).toBeGreaterThanOrEqual(frame.y)
    expect(box.y + box.height).toBeLessThan(frame.y + frame.height / 2)
    await button.click()
  }
  expect(await page.getByTestId('capture-frame').boundingBox()).toEqual(frame)
  expect(await page.getByTestId('shutter').boundingBox()).toEqual(shutter)
})

test('one shutter tap counts down visibly and saves one timed photo at zero', async ({ page }) => {
  const camera = await openCamera(page)
  await pauseCameraClock(page)
  await page.getByTestId('camera-timer').click()
  await page.getByTestId('shutter').click()
  await expect(page.getByTestId('countdown')).toHaveText('3')
  await expect(page.getByTestId('camera-timer')).toBeDisabled()
  await expect(page.getByTestId('shutter')).toHaveAccessibleName('Cancel timer')
  await page.clock.runFor(1000)
  await expect(page.getByTestId('countdown')).toHaveText('2')
  await page.clock.runFor(1000)
  await expect(page.getByTestId('countdown')).toHaveText('1')
  await expectNoCameraPhoto(camera.photos)
  await page.clock.runFor(1000)
  await expect(page.getByTestId('countdown')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Saved')
  await expect.poll(camera.photos).toHaveLength(1)
  expect((await camera.photos())[0]?.timerSeconds).toBe(3)
  await page.clock.runFor(10_000)
  expect(await camera.photos()).toHaveLength(1)
})

for (const key of ['Space', 'Enter']) {
  test(`${key} starts and cancels the same countdown`, async ({ page }) => {
    const camera = await openCamera(page)
    await pauseCameraClock(page)
    await page.getByTestId('camera-timer').click()
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await page.keyboard.press(key)
    await expect(page.getByTestId('countdown')).toHaveText('3')
    await page.keyboard.press(key)
    await page.clock.runFor(20_000)
    await expect(page.getByTestId('countdown')).toHaveCount(0)
    await expectNoCameraPhoto(camera.photos)
  })
}

test('flash toggles in one tap and exposes a full-viewport white layer before capture', async ({ page }) => {
  const camera = await openCamera(page)
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="capture-video"]')!
    const track = (video.srcObject as MediaStream).getVideoTracks()[0]!
    Object.defineProperty(track, 'getCapabilities', { value: () => ({ torch: false }) })
  })
  await pauseCameraClock(page)
  await page.getByTestId('camera-flash').click()
  await expect(page.getByTestId('camera-flash')).toHaveAttribute('data-flash', 'on')
  await page.getByTestId('shutter').click()
  const white = page.getByTestId('screen-flash')
  await expect(white).toBeVisible()
  const box = (await white.boundingBox())!
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box).toEqual({ x: 0, y: 0, ...viewport })
  await page.clock.runFor(149)
  await expectNoCameraPhoto(camera.photos)
  await page.clock.runFor(1)
  await expect(page.getByTestId('toast')).toContainText('Saved')
  await expect(white).toHaveCount(0)
  await expect.poll(camera.photos).toHaveLength(1)
  await page.getByTestId('camera-flash').click()
  await expect(page.getByTestId('camera-flash')).toHaveAttribute('data-flash', 'off')
})

test('a newer photo from another device supplies its timer, including Off', async ({ page, browser, baseURL }) => {
  const account = await createAccount(page.request)
  await openCamera(page)
  await page.getByTestId('camera-timer').click()
  const secondContext = await browser.newContext({ baseURL })
  try {
    const second = await secondContext.newPage()
    await signIn(second, account)
    const capturedAt = Date.now() + 1000
    const timed = await seedPhoto(second, '2026-10-21', 'selfies', { timerSeconds: 10, capturedAt })
    await page.reload()
    await expect(page.getByTestId('camera-timer')).toHaveAttribute('data-seconds', '10')
    const untimed = await seedPhoto(second, '2026-10-21', 'selfies', { timerSeconds: 0, capturedAt: capturedAt + 1000 })
    await syncPage(page)
    await expect(page.getByTestId('camera-timer')).toHaveAttribute('data-seconds', '0')
    const synced = await snapshot(page.request)
    expect(synced.photos.find((photo) => photo.id === timed.id)).toMatchObject({ timerSeconds: 10, deletedAt: expect.any(Number) })
    expect(synced.photos.find((photo) => photo.id === untimed.id)).toMatchObject({ timerSeconds: 0, deletedAt: null })
  } finally { await secondContext.close() }
})

test('camera roll mode disables timer and flash with an accessible reason', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
  await openCamera(page, false)
  for (const id of ['camera-timer', 'camera-flash']) {
    await expect(page.getByTestId(id)).toBeDisabled()
    await expect(page.getByTestId(id)).toHaveAccessibleDescription(/live preview.*camera app controls/)
  }
  await expect(page.getByTestId('shutter')).toHaveAttribute('data-mode', 'file')
  await expect(page.getByTestId('shutter')).toBeEnabled()
})
