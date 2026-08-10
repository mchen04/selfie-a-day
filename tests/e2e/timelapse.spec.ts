import { statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding, gotoApp, shot } from '../e2e-support/helpers.ts'

async function seedTimelapse(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('selfie-a-day')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
    const days = ['2026-08-10', '2026-07-12', '2026-07-11', '2025-08-11']
    const capturedTimes = [
      Date.parse('2026-08-10T12:00:00Z'),
      Date.parse('2026-07-12T00:30:00Z'),
      Date.parse('2026-07-12T01:30:00Z'),
      Date.parse('2025-08-11T12:00:00Z'),
    ]
    const colors = ['#5ee0b8', '#4e8fd8', '#d8954e', '#bd67d8']

    const images = await Promise.all(
      days.map(async (dayKey, index) => {
        const canvas = document.createElement('canvas')
        canvas.width = 60
        canvas.height = 80
        const context = canvas.getContext('2d')!
        context.fillStyle = colors[index]!
        context.fillRect(0, 0, 60, 80)
        context.fillStyle = '#fff'
        context.font = '16px sans-serif'
        context.fillText(String(index + 1), 24, 46)
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((value) => resolve(value!), 'image/jpeg', 0.8),
        )
        return { dayKey, bytes: await blob.arrayBuffer() }
      }),
    )

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['photos', 'thumbs', 'masters'], 'readwrite')
      for (const [index, image] of images.entries()) {
        const capturedAt = capturedTimes[index]!
        const id = `timelapse-${index}`
        transaction.objectStore('photos').put({
          id,
          albumId: 'selfies',
          dayKey: image.dayKey,
          capturedAt,
          timeZone: 'America/Los_Angeles',
          tzOffsetMinutes: 420,
          width: 60,
          height: 80,
          mime: 'image/jpeg',
          mirrored: true,
          source: 'camera',
          masterBytes: image.bytes.byteLength,
          thumbBytes: image.bytes.byteLength,
          deletedAt: null,
          schema: 2,
        })
        transaction.objectStore('thumbs').put({
          id,
          mime: 'image/jpeg',
          width: 60,
          height: 80,
          bytes: image.bytes,
        })
        transaction.objectStore('masters').put({
          id,
          mime: 'image/jpeg',
          width: 60,
          height: 80,
          bytes: image.bytes,
        })
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    })
    db.close()
  })
}

async function compactPlaybackProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const overflow = document.documentElement.scrollHeight - document.documentElement.clientHeight
    if (overflow > 1) problems.push(`page overflows vertically by ${overflow}px`)

    for (const element of Array.from(
      document.querySelectorAll('button, input, select, [role="switch"]'),
    )) {
      if ((element as HTMLElement).offsetParent === null) continue
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44)) {
        const label =
          element.getAttribute('data-testid') ??
          element.getAttribute('aria-label') ??
          element.textContent?.trim() ??
          element.tagName
        problems.push(`${label} is ${Math.round(box.width)}×${Math.round(box.height)}`)
      }
    }
    return problems
  })
}

test.describe('album timelapse', () => {
  test('filters, loops, stamps dates, reports duration, and exports a real video', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoApp(page)
    await completeOnboarding(page)
    await seedTimelapse(page)
    await page.reload()
    await completeOnboarding(page)
    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-count')).toHaveText('4 photos')

    await page.getByTestId('play-timelapse').click()
    await expect(page.getByTestId('playback-frame')).toBeVisible()
    await expect(page.getByTestId('playback-position')).toContainText('of 4')
    await expect(page.getByTestId('playback-summary')).toContainText('4 frames · 0.7 sec')
    await page.getByTestId('playback-scrub').fill('1')
    await expect(page.getByTestId('playback-position')).toContainText(/Jul 12.*2 of 4/)
    await page.getByTestId('playback-scrub').fill('2')
    await expect(page.getByTestId('playback-position')).toContainText(/Jul 11.*3 of 4/)
    await shot(page, `timelapse-playback-${test.info().project.name}.png`)

    await page.setViewportSize({ width: 320, height: 568 })
    expect(await compactPlaybackProblems(page)).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })

    await page.getByTestId('playback-options').click()
    await page.getByTestId('playback-range').selectOption('30-days')
    await expect(page.getByText('2 photos selected')).toBeVisible()
    await page.getByTestId('playback-loop').click()
    await page.getByTestId('playback-show-dates').click()
    await shot(page, `timelapse-options-${test.info().project.name}.png`)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByTestId('playback-summary')).toContainText('2 frames · 0.3 sec')
    await expect(page.getByTestId('playback-summary')).toContainText('Looping')
    await expect(page.getByTestId('playback-date')).toBeVisible()

    await page.getByTestId('playback-options').click()
    await page.getByTestId('playback-range').selectOption('custom')
    await page.getByTestId('playback-range-from').fill('2026-07-11')
    await page.getByTestId('playback-range-to').fill('2026-07-12')
    await expect(page.getByText('2 photos selected')).toBeVisible()
    await page.getByTestId('playback-range').selectOption('all')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Slow', exact: true }).click()
    await expect(page.getByTestId('playback-summary')).toContainText('4 frames · 1.3 sec')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false })
      const scope = window as typeof window & { __timelapseMasterReads: string[] }
      scope.__timelapseMasterReads = []
      const originalGet = Object.getOwnPropertyDescriptor(
        IDBObjectStore.prototype,
        'get',
      )?.value as (query: IDBValidKey | IDBKeyRange) => IDBRequest<unknown>
      IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
        if (this.name === 'masters' && typeof query === 'string') {
          scope.__timelapseMasterReads.push(query)
        }
        return originalGet.call(this, query)
      }
    })
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByTestId('playback-export').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(
      /^selfies-timelapse-2025-08-11-to-2026-08-10\.(mp4|webm)$/,
    )
    const path = await download.path()
    expect(path).not.toBeNull()
    expect(statSync(path).size).toBeGreaterThan(100)
    const duration = Number(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          path,
        ],
        { encoding: 'utf8' },
      ).trim(),
    )
    expect(duration).toBeGreaterThanOrEqual(1.2)
    expect(duration).toBeLessThanOrEqual(1.6)
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __timelapseMasterReads: string[] })
            .__timelapseMasterReads,
      ),
    ).toEqual(['timelapse-3', 'timelapse-1', 'timelapse-2', 'timelapse-0'])
    await expect(page.getByTestId('playback-export')).toContainText('Save again')
  })

  test('the options sheet traps focus and restores it to its trigger', async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await seedTimelapse(page)
    await page.reload()
    await completeOnboarding(page)
    await page.getByTestId('nav-timeline').click()
    await page.getByTestId('play-timelapse').click()

    const trigger = page.getByTestId('playback-options')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Timelapse options' })
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    expect(
      await page.getByTestId('playback-options-sheet').evaluate((layer) =>
        Array.from(layer.parentElement!.children)
          .filter((child) => child !== layer)
          .every((child) => (child as HTMLElement).inert),
      ),
    ).toBe(true)

    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })
})
