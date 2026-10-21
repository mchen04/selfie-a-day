import { expect, test } from '@playwright/test'
import { expectNoCameraPhoto, openCamera, pauseCameraClock } from '../e2e-support/camera.ts'
import { waitForCameraLive } from '../e2e-support/helpers.ts'

test('timer advances Off → 3s → 5s → 10s → Off with one tap per choice', async ({ page }) => {
  const camera = await openCamera(page)
  const timer = page.getByTestId('camera-timer')
  await expect(timer).toHaveAttribute('data-seconds', '0')
  for (const seconds of [3, 5, 10, 0]) {
    await timer.click()
    await expect(timer).toHaveAttribute('data-seconds', `${seconds}`)
  }
  await expectNoCameraPhoto(camera.photos)
})

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

for (const target of ['shutter', 'frame-tap']) {
  test(`a second ${target} tap cancels without saving`, async ({ page }) => {
    const camera = await openCamera(page)
    await pauseCameraClock(page)
    await page.getByTestId('camera-timer').click()
    await page.getByTestId(target).click()
    await expect(page.getByTestId('countdown')).toBeVisible()
    await page.clock.runFor(2000)
    await page.getByTestId(target).click()
    await expect(page.getByTestId('countdown')).toHaveCount(0)
    await page.clock.runFor(20_000)
    await expectNoCameraPhoto(camera.photos)
    await expect(page.getByTestId('camera-timer')).toBeEnabled()
  })
}

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

test('navigation cancels a pending countdown', async ({ page }) => {
  const camera = await openCamera(page)
  await pauseCameraClock(page)
  await page.getByTestId('camera-timer').click()
  await page.getByTestId('shutter').click()
  await page.getByTestId('nav-timeline').click()
  await page.clock.runFor(20_000)
  await expectNoCameraPhoto(camera.photos)
  await expect(page.getByTestId('countdown')).toHaveCount(0)
})

for (const event of ['visibilitychange', 'pagehide']) {
  test(`${event} cancels without a background photo`, async ({ page }) => {
    const camera = await openCamera(page)
    await pauseCameraClock(page)
    await page.getByTestId('camera-timer').click()
    await page.getByTestId('shutter').click()
    await page.evaluate((event) => {
      if (event === 'visibilitychange') {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event(event))
      } else window.dispatchEvent(new Event(event))
    }, event)
    await page.clock.runFor(20_000)
    await expectNoCameraPhoto(camera.photos)
    await expect(page.getByTestId('countdown')).toHaveCount(0)
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

test('timer and flash choices survive reload', async ({ page }) => {
  await openCamera(page)
  await page.getByTestId('camera-timer').click()
  await page.getByTestId('camera-flash').click()
  await page.reload()
  await waitForCameraLive(page)
  await expect(page.getByTestId('camera-timer')).toHaveAttribute('data-seconds', '3')
  await expect(page.getByTestId('camera-flash')).toHaveAttribute('data-flash', 'on')
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
