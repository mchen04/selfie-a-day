import { expect, test } from '@playwright/test'
import { openUx } from '../../e2e-support/ux-fixtures.ts'
import { captureUx } from '../../e2e-support/ux.ts'
import { pauseCameraClock } from '../../e2e-support/camera.ts'

test('capture: live countdown', async ({ page }, info) => {
  await openUx(page, { fallback: false })
  await pauseCameraClock(page)
  await page.getByTestId('camera-timer').click()
  await page.getByTestId('shutter').click()
  await expect(page.getByTestId('countdown')).toHaveText('3')
  await captureUx(page, info, 'capture-countdown', '[data-testid="shutter"]')
  await page.getByTestId('shutter').click()
  await expect(page.getByTestId('countdown')).toHaveCount(0)
})

test('capture: full-screen flash', async ({ page }, info) => {
  await openUx(page, { fallback: false })
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="capture-video"]')!
    const track = (video.srcObject as MediaStream).getVideoTracks()[0]!
    Object.defineProperty(track, 'getCapabilities', { value: () => ({ torch: false }) })
  })
  await pauseCameraClock(page)
  await page.getByTestId('camera-flash').click()
  await page.getByTestId('shutter').click()
  const flash = page.getByTestId('screen-flash')
  await expect(flash).toBeVisible()
  expect(await flash.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! })
  await captureUx(page, info, 'capture-flash', '[data-testid="shutter"]')
  await page.clock.runFor(200)
  await expect(flash).toHaveCount(0)
})
