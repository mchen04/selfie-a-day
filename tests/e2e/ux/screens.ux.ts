import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { openUx, saveUxPhoto, type ReminderMode } from '../../e2e-support/ux-fixtures.ts'
import { captureUx } from '../../e2e-support/ux.ts'

for (const state of ['create', 'sign-in', 'error'] as const) {
  test(`account: ${state}`, async ({ page }, info) => {
    await openUx(page, { signedIn: false, authError: state === 'error' })
    if (state !== 'create') await page.getByRole('button', { name: 'Have an account? Sign in' }).click()
    if (state === 'error') {
      await page.getByLabel('Username', { exact: true }).fill('synthetic-user')
      await page.getByLabel('Password', { exact: true }).fill(randomUUID())
      await page.getByTestId('account-submit').click()
      await expect(page.getByRole('alert')).toContainText('incorrect')
    }
    await expect(page.getByLabel('Username', { exact: true })).toHaveAttribute('autocomplete', 'username')
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('enterkeyhint', 'go')
    await captureUx(page, info, `account-${state}`, '[data-testid="account-submit"]')
  })
}

for (const state of ['first-run', 'ghost', 'offline', 'uploading'] as const) {
  test(`capture: ${state}`, async ({ page, browserName }, info) => {
    const fixture = await openUx(page, { photos: state === 'ghost' ? 1 : 0, fallback: browserName === 'webkit' })
    try {
      if (state === 'ghost') await expect(page.getByTestId('ghost-image')).toBeVisible()
      if (state === 'offline' || state === 'uploading') {
        fixture.holdUploads = true
        // WebKit's offline emulation also fails reads of the picked file, so WebKit
        // goes offline through failed API requests only.
        if (state === 'offline') { fixture.offline = true; if (browserName !== 'webkit') await page.context().setOffline(true) }
        await saveUxPhoto(page, fixture, info)
        await expect(page.getByTestId('cloud-status')).toContainText(state === 'offline' ? /Offline|Waiting for a connection/ : 'uploading')
      }
      await captureUx(page, info, `capture-${state}`, '[data-testid="shutter"]', { cameraPath: browserName === 'webkit' ? 'camera-roll fallback' : 'Chromium fake camera' })
    } finally {
      fixture.offline = false
      await page.context().setOffline(false)
      fixture.releaseUploads()
    }
  })
}

for (const count of [0, 60]) {
  test(`timeline: ${count} photos`, async ({ page }, info) => {
    await openUx(page, { photos: count }, '/timeline')
    if (count === 0) await expect(page.getByTestId('timeline-empty')).toBeVisible()
    await captureUx(page, info, `timeline-${count}`)
    if (count) {
      await page.getByTestId('timeline-cell').last().scrollIntoViewIfNeeded()
      await captureUx(page, info, 'timeline-60-end', null)
    }
  })
}

test('photo: saved image', async ({ page }, info) => {
  await openUx(page, { photos: 2 }, '/photo/00000000000000000000')
  await expect(page.getByTestId('photo-image')).toBeVisible()
  await captureUx(page, info, 'photo')
})

for (const state of ['empty', 'items', 'empty-armed', 'delete-armed'] as const) {
  test(`trash: ${state}`, async ({ page }, info) => {
    await openUx(page, { trash: state === 'empty' ? 0 : 3 }, '/trash')
    if (state === 'empty') await expect(page.getByTestId('trash-empty')).toBeVisible()
    else await expect(page.getByTestId('trash-item')).toHaveCount(3)
    if (state === 'empty-armed') {
      await page.getByTestId('empty-trash').click()
      await expect(page.getByTestId('empty-trash')).toHaveText('Confirm')
    }
    if (state === 'delete-armed') {
      await page.getByTestId('trash-delete-permanently').first().click()
      await expect(page.getByTestId('trash-delete-permanently').first()).toContainText('Delete forever?')
    }
    await captureUx(page, info, `trash-${state}`)
    if (state !== 'empty') await expect(page.getByTestId('trash-item')).toHaveCount(3)
    if (state === 'empty-armed') {
      await page.getByTestId('empty-trash').click()
      await expect(page.getByTestId('trash-item')).toHaveCount(0)
    }
    if (state === 'delete-armed') {
      await page.getByTestId('trash-delete-permanently').first().click()
      await expect(page.getByTestId('trash-item')).toHaveCount(2)
    }
  })
}

for (const reminders of ['off', 'on', 'unsupported', 'not-installed', 'denied'] satisfies ReminderMode[]) {
  test(`settings: reminders ${reminders}`, async ({ page }, info) => {
    await openUx(page, { reminders }, '/settings')
    const toggle = page.getByTestId('reminder-toggle-selfies')
    const available = reminders === 'off' || reminders === 'on'
    if (available) await expect(toggle).toBeEnabled()
    else await expect(toggle).toBeDisabled()
    await expect(toggle).toHaveAttribute('aria-checked', String(reminders === 'on'))
    await expect(page.locator('.reminder-row input')).toHaveCount(2)
    await expect(page.locator('.reminder-row input').first()).toHaveAttribute('type', 'time')
    await captureUx(page, info, `settings-reminders-${reminders}`, '[data-testid="reminder-toggle-selfies"]')
    await page.getByTestId('logout').scrollIntoViewIfNeeded()
    await captureUx(page, info, `settings-reminders-${reminders}-logout`, null)
  })
}

for (const state of ['picker', 'create', 'rename'] as const) {
  test(`album: ${state}`, async ({ page }, info) => {
    await openUx(page, {}, state === 'rename' ? '/settings' : '/')
    if (state === 'rename') {
      await page.getByTestId('album-name').fill('A long album name for my daily portraits')
      await expect(page.getByTestId('save-album')).toBeVisible()
    } else {
      await page.getByTestId('active-album-picker').click()
      await expect(page.getByTestId('album-option')).toHaveCount(2)
      if (state === 'create') {
        await page.getByTestId('new-album').click()
        await page.getByTestId('new-album-name').fill('My next album')
      }
    }
    await captureUx(page, info, `album-${state}`, state === 'rename' ? null : undefined)
  })
}

for (const state of ['playing', 'options', 'custom-dates', 'export-progress'] as const) {
  test(`playback: ${state}`, async ({ page }, info) => {
    await openUx(page, { photos: 60 }, '/timeline')
    await page.getByTestId('play-timelapse').click()
    await expect(page.getByTestId('playback-frame')).toBeVisible()
    if (state === 'options' || state === 'custom-dates') {
      await page.getByTestId('playback-options').click()
      if (state === 'custom-dates') await page.getByTestId('playback-range').selectOption('custom')
    }
    const supported = await page.getByTestId('playback-export').isEnabled()
    if (state === 'export-progress' && supported) {
      await page.getByTestId('playback-export').click()
      await expect(page.getByTestId('playback-export')).toContainText(/Rendering|Preparing/)
    }
    await captureUx(page, info, `playback-${state}`, undefined, { exportSupported: supported, ...(state === 'export-progress' && !supported ? { limitation: 'This browser disables video export; no progress state exists.' } : {}) })
    if (state === 'export-progress' && supported) await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
}

test('download: ZIP progress', async ({ page }, info) => {
  const fixture = await openUx(page, { photos: 60 }, '/settings')
  fixture.holdMasters = true
  try {
    await page.getByTestId('download-photos').click()
    await expect(page.locator('.download-progress')).toBeVisible()
    await captureUx(page, info, 'download-progress', null)
    await page.locator('.download-progress').getByRole('button', { name: 'Cancel' }).click()
  } finally { fixture.releaseMasters() }
})

test('logout: pending photos confirm remains reversible', async ({ page }, info) => {
  const fixture = await openUx(page)
  fixture.holdUploads = true
  try {
    await saveUxPhoto(page, fixture, info)
    await page.getByTestId('nav-settings').click()
    let nativeDialog: { type: string; message: string } | undefined
    page.once('dialog', async (dialog) => {
      nativeDialog = { type: dialog.type(), message: dialog.message() }
      await dialog.dismiss()
    })
    await page.getByTestId('logout').click()
    expect(nativeDialog?.type).toBe('confirm')
    expect(nativeDialog?.message).toContain('waiting to upload')
    await expect(page.getByTestId('settings-screen')).toBeVisible()
    await captureUx(page, info, 'logout-confirm-dismissed', null, { nativeDialog, limitation: 'Headless page screenshots exclude browser-native confirm chrome. PNG shows the page after dismissing the real dialog.' })
  } finally { fixture.releaseUploads() }
})
