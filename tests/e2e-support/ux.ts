import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface UxCheck { check: string; pass: boolean; details: unknown }
export interface Insets { top: number; bottom: number; left: number; right: number }
export const uxEvidenceRoot = () => resolve(process.env.UX_EVIDENCE_DIR ?? 'test-results/ux')

/**
 * Portrait insets of the iPhone each phone viewport stands for: SE/8 sizes have a
 * 20 px status bar and no home indicator; notched and Dynamic Island phones
 * reserve 47 or 59 px on top and 34 px for the home indicator.
 */
export function simulatedInsets(width: number): Insets {
  if (width <= 375) return { top: 20, bottom: 0, left: 0, right: 0 }
  if (width <= 390) return { top: 47, bottom: 34, left: 0, right: 0 }
  return { top: 59, bottom: 34, left: 0, right: 0 }
}

/** `primary` names the thumb-reach target; null skips the check (scrolled or mid-task views). */
export async function auditUx(page: Page, primary?: string | null): Promise<UxCheck[]> {
  return page.evaluate((primary) => {
    const failures: Record<string, unknown[]> = { clipping: [], targets: [], labels: [], inputs: [], headers: [] }
    const counts = { elements: 0, targets: 0, labels: 0, inputs: 0, headers: 0 }
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const root = dialog ?? document.body
    const describe = (element: Element) => element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? `${element.tagName.toLowerCase()}.${element.className}`
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      return !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('.visually-hidden, [aria-hidden="true"]')
    }
    const hasFullLabel = (element: HTMLElement, text: string) => {
      for (let current: HTMLElement | null = element; current && current !== document.body; current = current.parentElement) {
        const label = [current.getAttribute('aria-label'), current.title,
          ...(current.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent)].filter(Boolean).join(' ')
        if (label.includes(text)) return true
      }
      return false
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (!(element instanceof HTMLElement) || !visible(element) || ['OPTION', 'SCRIPT', 'STYLE'].includes(element.tagName)) continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const text = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
      const target = element.matches('button, a[href], input, select, textarea, [role="button"], [role="switch"], [tabindex="0"]')
      const content = target || !!text || element.matches('img, video')
      if (!content) continue
      counts.elements++
      const style = getComputedStyle(element)
      const label = describe(element)
      let reachableY = false
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent)
        const parentBox = parent.getBoundingClientRect()
        if (['auto', 'scroll'].includes(parentStyle.overflowY)) {
          reachableY = true
          // A column-reverse scroller starts at its end: scrollTop runs from
          // clientHeight - scrollHeight up to 0.
          const reversed = parentStyle.display.endsWith('flex') && parentStyle.flexDirection === 'column-reverse'
          const top = box.top - parentBox.top + parent.scrollTop + (reversed ? parent.scrollHeight - parent.clientHeight : 0)
          if (top < -1 || top + box.height > parent.scrollHeight + 1) failures.clipping!.push({ element: label, container: describe(parent), axis: 'unreachable-y' })
        }
        if (['hidden', 'clip'].includes(parentStyle.overflowY) && !reachableY && (box.top < parentBox.top - 1 || box.bottom > parentBox.bottom + 1)) {
          failures.clipping!.push({ element: label, container: describe(parent), axis: 'y' })
        }
        if (['hidden', 'clip', 'auto', 'scroll'].includes(parentStyle.overflowX) && (box.left < parentBox.left - 1 || box.right > parentBox.right + 1)) {
          failures.clipping!.push({ element: label, container: describe(parent), axis: 'x' })
        }
      }
      if (box.left < -1 || box.right > innerWidth + 1 || (!reachableY && (box.top < -1 || box.bottom > innerHeight + 1))) {
        failures.clipping!.push({ element: label, box: { x: box.x, y: box.y, width: box.width, height: box.height } })
      }
      if (target) {
        counts.targets++
        if (box.width < 43.9 || box.height < 43.9) failures.targets!.push({ element: label, width: box.width, height: box.height })
      }
      if (text) {
        counts.labels++
        const truncated = element.scrollWidth > element.clientWidth + 1 && ['hidden', 'clip'].includes(style.overflowX)
        const clamped = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '' && element.scrollHeight > element.clientHeight + 1
        let clippedText = false
        for (const node of Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) {
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of Array.from(range.getClientRects())) {
            for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
              const parentStyle = getComputedStyle(parent)
              const parentBox = parent.getBoundingClientRect()
              if (['hidden', 'clip'].includes(parentStyle.overflowX) && (rect.left < parentBox.left - 1 || rect.right > parentBox.right + 1)) clippedText = true
            }
          }
        }
        if ((truncated || clamped || clippedText) && !hasFullLabel(element, text)) failures.labels!.push({ element: label, text })
      }
      if (element.matches('input:not([type="range"]):not([type="file"]), select, textarea')) {
        counts.inputs++
        if (parseFloat(style.fontSize) < 16) failures.inputs!.push({ element: label, fontSize: style.fontSize })
      }
      if (element.matches('.topbar__title')) {
        counts.headers++
        const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        const line = element.querySelector('.topbar__album-line')
        const range = document.createRange()
        let rows = 1
        if (line) rows = line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)
        else if (direct[0]) { range.selectNodeContents(direct[0]); rows = range.getClientRects().length }
        if (rows > 1.1) failures.headers!.push({ element: label, rows })
      }
    }
    // Floating status layers (toast, upload status, undo bar, update banner) may
    // sit over the preview, including its whole-frame shutter, but never over
    // another control or over each other.
    const layers = Array.from(document.querySelectorAll<HTMLElement>('.toast, .cloud-status, .undo-trash, .banner--update')).filter(visible)
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"], [role="switch"]')).filter(visible)
      .filter((control) => !control.matches('.frame__tap'))
    const overlaps: unknown[] = []
    const intersect = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
    for (const [index, layer] of layers.entries()) {
      const box = layer.getBoundingClientRect()
      for (const other of [...layers.slice(index + 1), ...controls.filter((control) => !layer.contains(control) && !layers.some((item) => item.contains(control)))]) {
        if (intersect(box, other.getBoundingClientRect())) overlaps.push({ layer: describe(layer), covers: describe(other) })
      }
    }
    const checks: UxCheck[] = [
      { check: 'overlap', pass: overlaps.length === 0, details: { checked: layers.length, failures: overlaps } },
      { check: 'horizontal-scroll', pass: document.documentElement.scrollWidth <= innerWidth, details: { scrollWidth: document.documentElement.scrollWidth, innerWidth } },
      ...Object.entries(failures).map(([check, details]) => ({ check, pass: details.length === 0, details: { checked: counts[check === 'clipping' ? 'elements' : check as keyof typeof counts], failures: details } })),
    ]
    const action = primary === null ? undefined : primary ?? ['[data-testid="shutter"]', '[data-testid="account-submit"]', '[data-testid="reminder-toggle-selfies"]'].find((selector) => document.querySelector(selector))
    if (action && innerWidth <= 430 && !dialog) {
      const element = document.querySelector(action)
      const box = element?.getBoundingClientRect()
      checks.push({ check: 'thumb-reach', pass: !!box && box.top >= innerHeight * .55 && box.bottom <= innerHeight,
        details: { selector: action, top: box?.top, bottom: box?.bottom, lower45Starts: innerHeight * .55, viewportHeight: innerHeight } })
    }
    return checks
  }, primary)
}

export async function safeMetrics(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const root = dialog ?? document.body
    const selectors = dialog ? ['.sheet'] : ['.topbar', '.capture__controls', '.photo__nav', '.playback__controls', '.account']
    return selectors.flatMap((selector) => [...Array.from(root.querySelectorAll<HTMLElement>(selector)), ...(root.matches(selector) ? [root] : [])].map((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const children = Array.from(element.children).map((child) => child.getBoundingClientRect()).filter((rect) => rect.height > 0)
      return { selector, top: box.top, bottom: box.bottom, paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
        paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight),
        contentTop: Math.min(...children.map((rect) => rect.top)), contentBottom: Math.max(...children.map((rect) => rect.bottom)),
        contentLeft: Math.min(...children.map((rect) => rect.left)), contentRight: Math.max(...children.map((rect) => rect.right)), height: innerHeight, width: innerWidth }
    }))
  })
}

export function safeAreaCheck(insets: Insets, after: Awaited<ReturnType<typeof safeMetrics>>): UxCheck {
  const details = after.map((bar) => {
    const top = bar.selector === '.topbar' || bar.selector === '.account'
    const bottom = bar.selector !== '.topbar' && bar.selector !== '.account'
    return { ...bar,
      pass: (!top || bar.contentTop >= insets.top - 1) && (!bottom || bar.contentBottom <= bar.height - insets.bottom + 1)
        && bar.contentLeft >= insets.left - 1 && bar.contentRight <= bar.width - insets.right + 1,
    }
  })
  return { check: 'safe-area-simulation', pass: details.length > 0 && details.every((bar) => bar.pass),
    details: { method: 'Override --safe-top/bottom/left/right in CSS and require bar content inside the insets; this is not a physical device check.', insets, bars: details } }
}

export async function captureUx(page: Page, testInfo: TestInfo, state: string, primary?: string | null, extra: Record<string, unknown> = {}) {
  const directory = resolve(uxEvidenceRoot(), testInfo.project.name)
  await mkdir(directory, { recursive: true })
  const width = page.viewportSize()?.width ?? 1280
  const inset = simulatedInsets(width)
  for (const simulated of width <= 430 ? [false, true] : [false]) {
    const insets = simulated ? await page.addStyleTag({ content: `:root { --safe-top: ${inset.top}px !important; --safe-bottom: ${inset.bottom}px !important; --safe-left: ${inset.left}px !important; --safe-right: ${inset.right}px !important; }` }) : null
    // The screenshot comes first: WebKit applies injected custom properties at the
    // next rendering update, and the capture forces one (rAF may be paused by page.clock).
    const path = resolve(directory, `${state}${simulated ? '-insets' : ''}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    const checks = await auditUx(page, primary)
    if (simulated) checks.push(safeAreaCheck(inset, await safeMetrics(page)))
    await testInfo.attach(`${state}${simulated ? '-insets' : ''}`, { path, contentType: 'image/png' })
    await testInfo.attach('ux-checks', { body: JSON.stringify({ state, project: testInfo.project.name, viewport: page.viewportSize(), simulated, screenshot: path, checks, ...extra }), contentType: 'application/json' })
    for (const check of checks) expect.soft(check.pass, `${state}${simulated ? ' (simulated insets)' : ''}: ${check.check}: ${JSON.stringify(check.details)}`).toBe(true)
    await insets?.evaluate((element) => element.parentNode?.removeChild(element))
  }
}

/** A touch tap on touch projects (the page counts the click it produces), a mouse click on desktop. */
export async function press(locator: Locator, info: TestInfo) {
  if (info.project.use.hasTouch) await locator.tap()
  else await locator.click()
}

export async function startTapCount(page: Page) {
  await page.evaluate(() => {
    const taps: string[] = []
    Object.assign(window, { uxTaps: taps })
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return
      const target = event.target.closest('button, input, select, a, [role="switch"]')
      if (target) taps.push(target.getAttribute('aria-label') ?? target.getAttribute('data-testid') ?? target.getAttribute('name') ?? target.textContent?.trim() ?? target.tagName)
    }, { capture: true })
  })
}

export async function recordTaps(page: Page, testInfo: TestInfo, task: string, target?: number, nativeActions: string[] = [], notCounted: string[] = []) {
  const path = await page.evaluate(() => (window as unknown as { uxTaps: string[] }).uxTaps)
  const count = path.length + nativeActions.length
  const result = { task, project: testInfo.project.name, viewport: page.viewportSize(), input: testInfo.project.use.hasTouch ? 'touch tap' : 'mouse click',
    count, domTaps: path.length, path, nativeActions, notCounted, target: target ?? null, pass: target === undefined || count <= target }
  await testInfo.attach('ux-taps', { body: JSON.stringify(result), contentType: 'application/json' })
  expect.soft(count, `${task}: the page records at least one user action`).toBeGreaterThan(0)
  if (target !== undefined) expect.soft(count, `${task}: ${path.join(' → ')}`).toBeLessThanOrEqual(target)
}
