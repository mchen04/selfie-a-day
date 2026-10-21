import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { openUx, saveUxPhoto } from '../../e2e-support/ux-fixtures.ts'
import { press, recordTaps, startTapCount } from '../../e2e-support/ux.ts'
import { waitForCameraLive } from '../../e2e-support/helpers.ts'

test('taps: new account to first saved photo', async ({ page }, info) => {
  const fixture = await openUx(page, { signedIn: false, fallback: false })
  await startTapCount(page)
  await press(page.getByLabel('Username', { exact: true }), info)
  await page.getByLabel('Username', { exact: true }).fill(`ux-${randomUUID().slice(0, 12)}`)
  await press(page.getByLabel('Password', { exact: true }), info)
  await page.getByLabel('Password', { exact: true }).fill(randomUUID())
  await press(page.getByTestId('account-submit'), info)
  await waitForCameraLive(page)
  await saveUxPhoto(page, fixture, info)
  await recordTaps(page, info, 'New user open → first saved photo', undefined, [], ['Typing the username and password'])
})

test('account: keyboard Next and Go reach the camera', async ({ page }) => {
  await openUx(page, { signedIn: false, fallback: false })
  await page.getByLabel('Username', { exact: true }).fill('keyboard-user')
  await page.getByLabel('Username', { exact: true }).press('Enter')
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused()
  await expect(page.getByTestId('account-screen')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(randomUUID())
  await page.getByLabel('Password', { exact: true }).press('Enter')
  await expect(page.getByTestId('capture-screen')).toBeVisible()
})

test('taps: returning user saves with one tap', async ({ page }, info) => {
  const fixture = await openUx(page, { photos: 1, fallback: false })
  await startTapCount(page)
  await saveUxPhoto(page, fixture, info)
  await recordTaps(page, info, 'Returning user open → saved photo', 1)
})

test('taps: reminder from capture', async ({ page }, info) => {
  await openUx(page, { fallback: false })
  await startTapCount(page)
  await press(page.getByTestId('nav-settings'), info)
  const toggle = page.getByTestId('reminder-toggle-selfies')
  await expect(toggle).toBeEnabled()
  await press(toggle, info)
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
  await recordTaps(page, info, 'Capture → enable a reminder', 2, [], ['First time only: the iOS notification permission prompt needs one Allow tap (synthetic permission here)'])
})

test('taps: timer changes once', async ({ page }, info) => {
  await openUx(page, { fallback: false })
  await startTapCount(page)
  await press(page.getByTestId('camera-timer'), info)
  await expect(page.getByTestId('camera-timer')).toHaveAttribute('data-seconds', '3')
  await recordTaps(page, info, 'Capture → change timer', 1)
})

test('taps: switch album and capture', async ({ page }, info) => {
  const fixture = await openUx(page, { fallback: false })
  await startTapCount(page)
  await press(page.getByTestId('active-album-picker'), info)
  await press(page.locator('[data-testid="album-option"][data-album-id="album-00000000000000000001"]'), info)
  await expect(page.getByTestId('album-picker')).toHaveCount(0)
  await saveUxPhoto(page, fixture, info)
  expect(fixture.photos.at(-1)?.albumId).toBe('album-00000000000000000001')
  await recordTaps(page, info, 'Capture → switch album → saved photo', 3)
})

test('taps: trash and undo', async ({ page }, info) => {
  const fixture = await openUx(page, { photos: 2 }, '/photo/00000000000000000000')
  await expect(page.getByTestId('photo-image')).toBeVisible()
  await startTapCount(page)
  await press(page.getByTestId('photo-delete'), info)
  await expect(page.getByTestId('undo-trash-action')).toBeVisible()
  await press(page.getByTestId('undo-trash-action'), info)
  await expect.poll(() => fixture.photos[0]?.deletedAt).toBeNull()
  await recordTaps(page, info, 'Photo → Trash → Undo', 2, [], [], true)
})

test('taps: download my photos', async ({ page }, info) => {
  await openUx(page, { photos: 2, fallback: false })
  await startTapCount(page)
  await press(page.getByTestId('nav-settings'), info)
  const download = page.waitForEvent('download')
  await press(page.getByTestId('download-photos'), info)
  expect((await download).suggestedFilename()).toMatch(/selfie-a-day-.*\.zip$/)
  await recordTaps(page, info, 'Capture → Download my photos', undefined, [], ['Where the browser offers a share sheet, saving the ZIP there is native UI'])
})

test('taps: log out', async ({ page }, info) => {
  await openUx(page, { fallback: false })
  await startTapCount(page)
  await press(page.getByTestId('nav-settings'), info)
  await press(page.getByTestId('logout'), info)
  await expect(page.getByTestId('account-screen')).toBeVisible()
  await recordTaps(page, info, 'Capture → Log out')
})

test('taps: log out with queued photos', async ({ page }, info) => {
  const fixture = await openUx(page, { fallback: false })
  fixture.holdUploads = true
  try {
    await saveUxPhoto(page, fixture, info)
    await startTapCount(page)
    await press(page.getByTestId('nav-settings'), info)
    const nativeActions: string[] = []
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm')
      nativeActions.push('Accept native Log out confirmation')
      fixture.releaseUploads()
      await dialog.accept()
    })
    await press(page.getByTestId('logout'), info)
    await expect(page.getByTestId('account-screen')).toBeVisible()
    await recordTaps(page, info, 'Capture → Log out → Confirm queued photo loss', undefined, nativeActions)
  } finally { fixture.releaseUploads() }
})
