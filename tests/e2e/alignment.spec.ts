import { expect, test } from '@playwright/test'
import { computeCoverCrop, FRAME_ASPECT } from '../../src/core/geometry.ts'
import {
  captureOnce,
  completeOnboarding,
  dominantChannel,
  evidencePath,
  gotoApp,
  listStoredPhotos,
  samplePhotoPixels,
  waitForCameraLive,
} from '../e2e-support/helpers.ts'
import { decodePNG, samplePatch } from '../e2e-support/png.ts'

/**
 * The alignment invariant, measured against a known target rather than judged
 * by eye.
 *
 * The fake camera plays a 1280x720 frame carrying three coloured markers at
 * known fractions of the source. From the source geometry alone we can compute
 * exactly where each marker must appear in a correctly cropped, correctly
 * mirrored capture — and then read the pixels and check.
 *
 * A wrong crop offset, a missing mirror, or a mirror applied twice all move the
 * markers somewhere this test does not expect.
 */

const SOURCE_WIDTH = 1280
const SOURCE_HEIGHT = 720

const MARKERS = [
  { name: 'left', channel: 'red' as const, sx: 0.34, sy: 0.25 },
  { name: 'right', channel: 'blue' as const, sx: 0.66, sy: 0.25 },
  { name: 'bottom', channel: 'green' as const, sx: 0.5, sy: 0.78 },
]

/** Where a source marker must land in frame space, given the crop and mirroring. */
function expectedFramePosition(
  sourceU: number,
  sourceV: number,
  mirrored: boolean,
): { u: number; v: number } {
  const crop = computeCoverCrop(SOURCE_WIDTH, SOURCE_HEIGHT, FRAME_ASPECT)
  const x = sourceU * SOURCE_WIDTH
  const y = sourceV * SOURCE_HEIGHT
  const u = (x - crop.sx) / crop.sw
  const v = (y - crop.sy) / crop.sh
  return { u: mirrored ? 1 - u : u, v }
}

test.describe('coordinate space', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page)
    await completeOnboarding(page)
    await waitForCameraLive(page)
  })

  test('the saved photo is exactly the cover-crop of the frame the user saw', async ({ page }) => {
    await captureOnce(page)

    const photos = await listStoredPhotos(page)
    expect(photos).toHaveLength(1)
    const photo = photos[0]!

    // Stored in frame space, and mirrored because the preview was mirrored.
    expect(photo.width / photo.height).toBeCloseTo(FRAME_ASPECT, 3)
    expect(photo.mirrored).toBe(true)

    const points = MARKERS.map((m) => {
      const { u, v } = expectedFramePosition(m.sx, m.sy, photo.mirrored)
      return { name: m.name, u, v }
    })

    // Sanity-check the maths itself before trusting it as an oracle: the left
    // marker must end up on the right of a mirrored image, and vice versa.
    const left = points.find((p) => p.name === 'left')!
    const right = points.find((p) => p.name === 'right')!
    expect(left.u).toBeGreaterThan(0.5)
    expect(right.u).toBeLessThan(0.5)

    const result = await samplePhotoPixels(page, photo.id, points)
    expect(result.width).toBe(photo.width)

    for (const marker of MARKERS) {
      const sample = result.samples[marker.name]!
      expect(
        dominantChannel(sample),
        `marker "${marker.name}" should be ${marker.channel} at the predicted position, got rgb(${sample.join(',')})`,
      ).toBe(marker.channel)
    }
  })

  test('an off-centre crop would be caught: markers are absent where they must not be', async ({
    page,
  }) => {
    await captureOnce(page)
    const photo = (await listStoredPhotos(page))[0]!

    // If the crop ignored its x offset, the red marker would land here instead.
    const wrong = MARKERS.map((m) => ({
      name: m.name,
      u: m.sx, // naive: source fraction used directly, no crop, no mirror
      v: m.sy,
    }))

    const result = await samplePhotoPixels(page, photo.id, wrong)
    const misplaced = MARKERS.filter((m) => dominantChannel(result.samples[m.name]!) === m.channel)

    // The green marker sits on the horizontal centre line, where the naive and
    // correct positions coincide horizontally, so it is allowed to match.
    expect(misplaced.map((m) => m.name).filter((n) => n !== 'bottom')).toEqual([])
  })

  test('the ghost lines up with the live preview on screen', async ({ page }) => {
    // Grid off so no guide line can land on a sample point.
    while (await page.getByTestId('grid-toggle').getAttribute('data-grid') !== 'off') await page.getByTestId('grid-toggle').click()
    await waitForCameraLive(page)

    await captureOnce(page)
    await expect(page.getByTestId('ghost-image')).toBeVisible()

    const frame = page.getByTestId('capture-frame')
    const photo = (await listStoredPhotos(page))[0]!
    const points = MARKERS.map((m) => ({
      ...m,
      ...expectedFramePosition(m.sx, m.sy, photo.mirrored),
    }))

    // The ghost is rendered without any transform (its pixels are already in
    // preview space), so preview and ghost markers must land on the same spot.
    // If the ghost were flipped, red would blend with blue here and neither
    // channel would dominate.
    await page.getByTestId('ghost-opacity').fill('95')

    // The ghost has `transition: opacity 120ms`. Screenshotting straight after
    // the fill captured it mid-fade — measured at 0.45 rising to 0.85 — and a
    // faint ghost cannot tint the composite enough for a wrong orientation to
    // show. Wait for the value the assertions assume.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="ghost-image"]')
          return el ? Number(getComputedStyle(el).opacity) : 0
        }),
      )
      .toBeGreaterThan(0.94)

    const withGhost = decodePNG(await frame.screenshot())
    for (const marker of points) {
      const sample = samplePatch(withGhost, marker.u, marker.v)
      expect(
        dominantChannel(sample),
        `with the ghost at 95%, "${marker.name}" should still read ${marker.channel} — got rgb(${sample.join(',')}), which is what a flipped or offset ghost looks like`,
      ).toBe(marker.channel)
    }

    // Only now check the app's own flip decision. Asserting it before reading
    // pixels meant a correct decision rendered incorrectly still passed — the
    // suite verified "the app decided to flip correctly", not "the ghost is
    // drawn the right way round".
    await expect(page.getByTestId('ghost-image')).toHaveAttribute('data-flipped', 'false')

    // And the same points with the ghost hidden: this half proves the browser's
    // CSS object-fit: cover produces the same crop as the capture canvas does.
    await page.getByTestId('ghost-toggle').click()
    await expect(page.getByTestId('ghost-image')).toHaveCount(0)

    const previewOnly = decodePNG(await frame.screenshot())
    for (const marker of points) {
      const sample = samplePatch(previewOnly, marker.u, marker.v)
      expect(
        dominantChannel(sample),
        `live preview should show ${marker.channel} at "${marker.name}" — got rgb(${sample.join(',')})`,
      ).toBe(marker.channel)
    }

    // Re-show the ghost before capturing the artefact: it is named for the
    // state it is meant to show, and it used to be written after the toggle
    // that removes the ghost entirely.
    await page.getByTestId('ghost-toggle').click()
    await expect(page.getByTestId('ghost-image')).toBeVisible()
    await frame.screenshot({ path: evidencePath('alignment-ghost-over-preview.png') })
  })

  test('turning the mirror off flips the ghost so it still matches the preview', async ({ page }) => {
    await captureOnce(page)
    const stored = (await listStoredPhotos(page))[0]!
    expect(stored.mirrored).toBe(true)

    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-mirror').click()
    await page.getByTestId('settings-back').click()
    await waitForCameraLive(page)

    // The stored photo is in mirrored space but the preview no longer is, so
    // the ghost must compensate. This is the one case where it transforms.
    await expect(page.getByTestId('ghost-image')).toHaveAttribute('data-flipped', 'true')
    await expect(page.getByTestId('capture-video')).toHaveAttribute('data-mirrored', 'false')

    // A capture taken now stays in the LIBRARY's space. Following the view
    // setting instead would leave a library in two spaces and a timelapse that
    // flips left-to-right at the boundary.
    await captureOnce(page)
    const after = (await listStoredPhotos(page)).find((p) => p.id !== stored.id)
    expect(after?.mirrored).toBe(stored.mirrored)
  })

  /**
   * Raised independently in all four code-quality cycles. Toggling Mirror is a
   * viewing preference; it must not split the archive into two mirroring
   * spaces, because the timelapse would then flip halfway through — the exact
   * complaint quoted from a real review in docs/research.md.
   */
  test('toggling Mirror never splits the library into two spaces', async ({ page }) => {
    await captureOnce(page)

    for (let round = 0; round < 3; round++) {
      await page.clock.setFixedTime(new Date(Date.parse('2027-01-10T12:00:00Z') + round * 86_400_000))

      // Flip the setting, then capture again.
      await page.getByTestId('nav-settings').click()
      await page.getByTestId('settings-mirror').click()
      await page.getByTestId('settings-back').click()
      await waitForCameraLive(page)
      await captureOnce(page)
    }

    const all = await listStoredPhotos(page)
    expect(all.length).toBeGreaterThan(3)
    expect(
      new Set(all.map((p) => p.mirrored)).size,
      `library split across ${new Set(all.map((p) => p.mirrored)).size} mirroring spaces`,
    ).toBe(1)
  })

  /**
   * Regression guard for a bug this suite found: `width: 100%; max-height: 100%`
   * silently produced a 0.83 frame on short viewports, giving the preview and
   * the ghost different cover-crops. The ratio must hold at every size.
   */
  test('the frame stays exactly 3:4 at any viewport size', async ({ page }) => {
    const sizes = [
      { width: 320, height: 480 },
      { width: 360, height: 640 },
      { width: 390, height: 664 },
      { width: 414, height: 896 },
      { width: 768, height: 500 },
      { width: 1280, height: 900 },
      { width: 1440, height: 620 },
    ]

    for (const size of sizes) {
      await page.setViewportSize(size)
      const box = await page.getByTestId('capture-frame').boundingBox()
      expect(box, `no frame at ${size.width}x${size.height}`).not.toBeNull()
      expect(
        box!.width / box!.height,
        `frame is ${box!.width.toFixed(1)}x${box!.height.toFixed(1)} at viewport ${size.width}x${size.height}`,
      ).toBeCloseTo(FRAME_ASPECT, 2)
    }
  })

  /**
   * The CSS custom property and the capture maths must be the same number. They
   * used to be declared independently, which is a silent route to the preview
   * and the saved photo having different crops.
   */
  test('the CSS frame aspect is derived from the capture constant', async ({ page }) => {
    const cssValue = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--frame-aspect').trim(),
    )
    expect(Number(cssValue)).toBeCloseTo(FRAME_ASPECT, 6)

    const frame = (await page.getByTestId('capture-frame').boundingBox())!
    expect(frame.width / frame.height).toBeCloseTo(FRAME_ASPECT, 2)
  })
})
