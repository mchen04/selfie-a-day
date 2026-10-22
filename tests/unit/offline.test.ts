import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineReadiness } from '../e2e-support/offline.ts'

const scope = new URL('/', location.href).href
const precache = `workbox-precache-v2-${scope}`
let state: string
let controller: object | null
let stored: Record<string, string[]>

beforeEach(() => {
  state = 'activated'
  controller = {}
  stored = { [precache]: ['index.html?__WB_REVISION__=synthetic', 'assets/app.js', 'assets/app.css', 'assets/chunk.js', 'icon.png', 'favicon.svg'] }
  document.head.innerHTML = '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">'
  vi.stubGlobal('navigator', { serviceWorker: {
    getRegistration: () => Promise.resolve({ active: { state }, scope }),
    get controller() { return controller },
  } })
  vi.stubGlobal('performance', { getEntriesByType: () => [{ name: new URL('assets/chunk.js', scope).href }] })
  vi.stubGlobal('caches', {
    keys: () => Promise.resolve(Object.keys(stored)),
    open: (name: string) => Promise.resolve({ keys: () => Promise.resolve((stored[name] ?? []).map((path) => new Request(new URL(path, scope)))) }),
  })
})

afterEach(() => { vi.unstubAllGlobals(); document.head.innerHTML = '' })

describe('offline reopen readiness', () => {
  it('accepts an activated precache while the current page is not yet controlled', async () => {
    controller = null
    expect(await offlineReadiness()).toBe('ready')
  })
  it('waits for activation', async () => {
    state = 'activating'
    expect(await offlineReadiness()).toBe('not-activated')
  })
  it.each(['index.html?__WB_REVISION__=synthetic', 'assets/app.js', 'assets/app.css', 'assets/chunk.js'])('rejects a populated precache missing %s', async (missing) => {
    stored[precache] = stored[precache]!.filter((path) => path !== missing).concat('extra-icon.png')
    expect(await offlineReadiness()).toBe(`precache-missing:/${missing.split('?')[0]}`)
  })
  it('rejects unrelated caches even when they contain enough entries', async () => {
    stored = { unrelated: stored[precache]! }
    expect(await offlineReadiness()).toBe('no-precache')
  })
})
