import { expect, test, type Page } from '@playwright/test'
import { captureOnce, completeOnboarding, gotoApp, waitForCameraLive } from '../e2e-support/helpers.ts'

/** Apple's Human Interface Guidelines minimum hit region, in CSS pixels. */
const MIN_TAP = 44

interface Target {
  label: string
  width: number
  height: number
}

async function undersizedTargets(page: Page): Promise<Target[]> {
  return page.evaluate((min) => {
    const selector = 'button, a[href], input, select, [role="switch"], [tabindex]:not([tabindex="-1"])'
    return Array.from(document.querySelectorAll(selector))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      // Off-screen shims fired by a visible button are not tap targets.
      .filter((el) => !el.classList.contains('visually-hidden'))
      .filter((el) => el.getAttribute('aria-hidden') !== 'true')
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          label:
            el.getAttribute('data-testid') ??
            el.getAttribute('aria-label') ??
            (el.className ? String(el.className).slice(0, 30) : el.tagName),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
      .filter((t) => t.width > 0 && t.height > 0 && (t.width < min || t.height < min))
  }, MIN_TAP)
}

test.describe('ergonomics', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
  })

  test('every interactive control meets the 44px minimum hit region', async ({ page }) => {
    // Capture, with a photo present so the advisory and ghost controls are live.
    await captureOnce(page)
    expect(await undersizedTargets(page), 'capture screen').toEqual([])

    await page.getByTestId('nav-timeline').click()
    await expect(page.getByTestId('timeline-screen')).toBeVisible()
    expect(await undersizedTargets(page), 'timeline screen').toEqual([])

    await page.getByTestId('timeline-cell').first().click()
    await expect(page.getByTestId('photo-screen')).toBeVisible()
    expect(await undersizedTargets(page), 'photo screen').toEqual([])

    // Navigate in-app rather than by URL, which is how a user reaches Settings
    // in a standalone window with no address bar.
    await page.getByTestId('photo-back').click()
    await page.getByTestId('timeline-back').click()
    await expect(page.getByTestId('capture-screen')).toBeVisible()
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-screen')).toBeVisible()
    expect(await undersizedTargets(page), 'settings screen').toEqual([])
  })

  /**
   * The live preview is the reason the app exists. Chrome must not crowd it out
   * — an earlier layout gave the frame only 27% of a phone screen.
   */
  test('the camera frame dominates the screen on a phone', async ({ page }) => {
    await captureOnce(page)

    for (const size of [
      { width: 375, height: 667 },
      { width: 390, height: 664 },
      { width: 412, height: 732 },
    ]) {
      await page.setViewportSize(size)
      const box = await page.getByTestId('capture-frame').boundingBox()
      const share = (box!.width * box!.height) / (size.width * size.height)
      expect(
        share,
        `frame is only ${Math.round(share * 100)}% of a ${size.width}x${size.height} screen`,
      ).toBeGreaterThan(0.4)
    }
  })

  test('the page never scrolls on the capture screen', async ({ page }) => {
    // A camera screen that scrolls feels broken and hides the shutter.
    for (const size of [
      { width: 375, height: 667 },
      { width: 390, height: 664 },
    ]) {
      await page.setViewportSize(size)
      const overflow = await page.evaluate(() => ({
        vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }))
      expect(overflow.vertical, `vertical overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
      expect(overflow.horizontal, `horizontal overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
    }
  })

  test('the shutter sits in the thumb zone, horizontally centred', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 })
    const shutter = (await page.getByTestId('shutter').boundingBox())!
    const centre = shutter.x + shutter.width / 2

    expect(Math.abs(centre - 195), 'shutter should be horizontally centred').toBeLessThan(8)
    // Bottom third of the screen: reachable one-handed by either thumb.
    expect(shutter.y).toBeGreaterThan(664 * 0.66)
    expect(shutter.width).toBeGreaterThanOrEqual(64)
  })

  test('every control carries an accessible name', async ({ page }) => {
    await captureOnce(page)

    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, input, [role="switch"]'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => el.getAttribute('aria-hidden') !== 'true')
        .filter((el) => !el.classList.contains('visually-hidden'))
        .filter((el) => {
          const label =
            el.getAttribute('aria-label') ??
            el.getAttribute('title') ??
            (el.textContent ?? '').trim()
          return !label
        })
        .map((el) => el.getAttribute('data-testid') ?? el.tagName + '.' + String(el.className).slice(0, 24)),
    )
    expect(unnamed).toEqual([])
  })

  test('keyboard alone can reach and fire the shutter', async ({ page }) => {
    // Space is the desktop stand-in for the volume-button shutter phones have.
    const before = await page.evaluate(() => document.querySelectorAll('[data-testid]').length)
    expect(before).toBeGreaterThan(0)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Space')
    await expect(page.getByTestId('toast')).toContainText('Saved')

    // And the shutter itself is focusable and activatable.
    await page.getByTestId('shutter').focus()
    await expect(page.getByTestId('shutter')).toBeFocused()
  })

  /**
   * A message the user cannot finish reading is worse than no message: it
   * signals a problem without saying what to do. This caught a warning that
   * rendered as "Installing starts a separate…".
   */
  test('no visible text is clipped', async ({ page }) => {
    await captureOnce(page)

    for (const size of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 664 },
    ]) {
      await page.setViewportSize(size)
      const clipped = await page.evaluate(() =>
        Array.from(document.querySelectorAll('span, p, strong, h1, h2, button'))
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .filter((el) => (el.textContent ?? '').trim().length > 0)
          .filter((el) => !el.querySelector('span, p, strong'))
          // Screen-reader-only text is clipped on purpose.
          .filter((el) => !el.closest('.visually-hidden'))
          .filter((el) => {
            const style = getComputedStyle(el)
            // Deliberate single-line truncation is opt-in via ellipsis.
            if (style.textOverflow === 'ellipsis') return false
            return (
              el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
            )
          })
          .map((el) => `${(el.textContent ?? '').trim().slice(0, 40)}`),
      )
      expect(clipped, `clipped text at ${size.width}x${size.height}`).toEqual([])
    }
  })

  /** Transient UI must never sit on top of the controls it interrupts. */
  test('the toast never covers the shutter or the ghost controls', async ({ page }) => {
    await captureOnce(page)
    await expect(page.getByTestId('toast')).toBeVisible()

    const collisions = await page.evaluate(() => {
      const toast = document.querySelector('.toast')?.getBoundingClientRect()
      if (!toast) return ['no toast rendered']
      const out: string[] = []
      for (const sel of ['[data-testid="shutter"]', '[data-testid="ghost-controls"]']) {
        const box = document.querySelector(sel)?.getBoundingClientRect()
        if (!box) continue
        const overlaps =
          toast.left < box.right &&
          toast.right > box.left &&
          toast.top < box.bottom &&
          toast.bottom > box.top
        if (overlaps) out.push(sel)
      }
      return out
    })

    expect(collisions).toEqual([])
  })

  /**
   * The onboarding mark is three concentric circles. As a column flex item it
   * shrank along the main axis on short screens and rendered as ellipses.
   */
  test('the onboarding mark stays circular on short screens', async ({ page, context }) => {
    await context.clearCookies()
    await page.evaluate(() => indexedDB.deleteDatabase('selfie-a-day'))

    for (const size of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 664 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/')
      await expect(page.getByTestId('onboarding-screen')).toBeVisible()

      const mark = await page.locator('.onboarding__mark').boundingBox()
      expect(mark, `no mark at ${size.width}x${size.height}`).not.toBeNull()
      expect(
        mark!.width / mark!.height,
        `mark is ${mark!.width}x${mark!.height} at ${size.width}x${size.height}`,
      ).toBeCloseTo(1, 1)
    }
  })
})
