import { expect, test } from '@playwright/test'
import config from '../../../playwright.ux.config.ts'
import { auditUx, press, recordTaps, safeAreaCheck, safeMetrics, startTapCount } from '../../e2e-support/ux.ts'

test('audit detects injected defects and accepts their repairs', async ({ page }, info) => {
  expect(config.projects).toHaveLength(9)
  await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { --safe-top: 0px; --safe-bottom: 0px; --safe-left: 0px; --safe-right: 0px; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input { min-width: 44px; height: 44px; font-size: 16px; }
      .topbar { padding: calc(10px + var(--safe-top)) calc(10px + var(--safe-right)) 10px calc(10px + var(--safe-left)); }
      .topbar__title { width: 260px; }
      .capture__controls { position: absolute; bottom: 0; width: 100%; padding: 10px calc(10px + var(--safe-right)) calc(10px + var(--safe-bottom)) calc(10px + var(--safe-left)); }
      #clip { width: 120px; overflow: hidden; }
      #label { width: 70px; overflow: hidden; white-space: nowrap; }
    </style>
    <div class="topbar"><div class="topbar__title">A clear title</div></div>
    <div id="overflow">Text</div>
    <div id="clip"><button id="target">Tap</button></div>
    <div id="label" title="The complete accessible label">The complete accessible label</div>
    <input aria-label="Username" />
    <div class="capture__controls"><button id="primary">Save</button></div>
    <div class="toast" style="position: fixed; top: 200px; left: 0; width: 60px; height: 30px; pointer-events: none;">Saved</div>
  `)
  expect((await auditUx(page, '#primary')).filter((check) => !check.pass)).toEqual([])
  const insets = { top: 47, bottom: 34, left: 8, right: 8 }
  await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; --safe-left: 8px; --safe-right: 8px; }' })
  expect(safeAreaCheck(insets, await safeMetrics(page)).pass).toBe(true)
  await page.addStyleTag({ content: '.topbar { padding: 10px; }' })
  expect(safeAreaCheck(insets, await safeMetrics(page)).pass).toBe(false)
  await page.addStyleTag({ content: '.topbar { padding: calc(10px + var(--safe-top)) calc(10px + var(--safe-right)) 10px calc(10px + var(--safe-left)); } .capture__controls { padding: 10px; }' })
  expect(safeAreaCheck(insets, await safeMetrics(page)).pass).toBe(false)
  await page.addStyleTag({ content: '#overflow { width: calc(100vw + 20px); } #clip { width: 20px; } #target { min-width: 20px; width: 20px; height: 20px; } input { font-size: 12px; } .topbar__title { width: 30px; } #primary { position: fixed; top: 0; left: 100px; } .toast { top: 0 !important; left: 100px !important; }' })
  await page.locator('#label').evaluate((element) => element.removeAttribute('title'))
  const failed = (await auditUx(page, '#primary')).filter((check) => !check.pass).map((check) => check.check)
  expect(failed).toEqual(expect.arrayContaining(['overlap', 'horizontal-scroll', 'clipping', 'targets', 'labels', 'inputs', 'headers']))
  if ((page.viewportSize()?.width ?? 1280) <= 430) expect(failed).toContain('thumb-reach')
  await startTapCount(page)
  await press(page.locator('#primary'), info)
  await press(page.locator('#primary'), info)
  await page.locator('#primary').evaluate((element: HTMLButtonElement) => element.click())
  await recordTaps(page, info, 'Counter calibration: two user taps; scripted clicks excluded', 2)
  expect(await page.evaluate(() => (window as unknown as { uxTaps: string[] }).uxTaps.length)).toBe(2)
})
