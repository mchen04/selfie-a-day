import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Reminders } from '../../../src/push/Reminders.tsx'
import { deviceTimeZone } from '../../../src/push/client.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { pushEnvironment } from './environment.ts'

let root: Root
let container: HTMLDivElement
let env: ReturnType<typeof pushEnvironment>
const onError = vi.fn()
const albums = [defaultAlbum(), { ...defaultAlbum(), id: 'album-fixed', name: 'Fixed album', timeZone: 'Pacific/Auckland' }, { ...defaultAlbum(), id: 'deleted', deletedAt: 1 }]

async function render() {
  await act(async () => { root.render(createElement(Reminders, { albums, onError })); await Promise.resolve() })
}
function toggle() { return container.querySelector<HTMLButtonElement>('[data-testid="reminder-toggle-selfies"]')! }
async function click() { await act(async () => { toggle().click(); await Promise.resolve() }) }
function writes() { return env.request.mock.calls.filter(([path]) => path.startsWith('/api/push/prefs/')) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  env = pushEnvironment()
  onError.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('compact reminders', () => {
  it('renders exactly one native time and switch per active album, defaulting off at 09:00', async () => {
    await render()
    expect(container.querySelectorAll('.reminder-row')).toHaveLength(2)
    expect(container.querySelectorAll('input[type="time"]')).toHaveLength(2)
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('09:00')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().disabled).toBe(false)
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
  })

  it('first toggle asks, subscribes, then saves the enabled preference with the device zone', async () => {
    await render()
    await click()
    expect(env.notification.requestPermission).toHaveBeenCalledOnce()
    expect(env.manager.subscribe).toHaveBeenCalledOnce()
    expect(env.request.mock.calls.map(([path]) => path)).toEqual(['/api/push/prefs', '/api/push/config', '/api/push/subscription', '/api/push/prefs/selfies'])
    expect(JSON.parse(writes()[0]![1]?.body as string)).toEqual({ enabled: true, time: '09:00', timeZone: deviceTimeZone() })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('saves a native time change without enabling notifications', async () => {
    await render()
    const input = container.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '07:45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(JSON.parse(writes()[0]![1]?.body as string)).toEqual({ enabled: false, time: '07:45', timeZone: deviceTimeZone() })
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
  })

  it('saves the album zone and turns off without resubscribing', async () => {
    env.notification.permission = 'granted'
    env.setPrefs([{ albumId: 'selfies', enabled: true, time: '10:15', timeZone: 'UTC' }])
    await render()
    await click()
    expect(JSON.parse(writes()[0]![1]?.body as string)).toEqual({ enabled: false, time: '10:15', timeZone: deviceTimeZone() })
    expect(env.manager.subscribe).not.toHaveBeenCalled()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="reminder-toggle-album-fixed"]')!.click(); await Promise.resolve() })
    expect(JSON.parse(writes()[1]![1]?.body as string)).toEqual({ enabled: true, time: '09:00', timeZone: 'Pacific/Auckland' })
  })

  it.each(['unsupported', 'not-installed', 'denied'] as const)('disables every row with one explanation when %s', async (state) => {
    if (state === 'unsupported') vi.stubGlobal('PushManager', undefined)
    if (state === 'not-installed') Object.assign(navigator, { userAgent: 'iPhone' })
    if (state === 'denied') env.notification.permission = 'denied'
    await render()
    expect(toggle().disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLInputElement>('input')].every((input) => input.disabled)).toBe(true)
    expect(container.querySelectorAll('#reminders-reason')).toHaveLength(1)
    const text = container.querySelector('#reminders-reason')!.textContent
    expect(text).toContain(state === 'unsupported' ? 'does not support' : state === 'not-installed' ? 'Add to Home Screen to get reminders' : 'iOS Settings')
    expect(env.manager.subscribe).not.toHaveBeenCalled()
  })

  it('reverts the switch and reports a permission denial without saving', async () => {
    env.notification.requestPermission.mockImplementation(() => { env.notification.permission = 'denied'; return Promise.resolve('denied') })
    await render()
    await click()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().disabled).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
    expect(writes()).toHaveLength(0)
    expect(env.manager.subscribe).not.toHaveBeenCalled()
  })

  it('reverts a failed preference save and reports the error', async () => {
    await render()
    const original = env.request.getMockImplementation()!
    env.request.mockImplementation((path, init) => path.startsWith('/api/push/prefs/')
      ? Promise.resolve(Response.json({ error: 'internal_error' }, { status: 500 })) : original(path, init))
    await click()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().disabled).toBe(false)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('keeps controls disabled if preferences fail to load', async () => {
    env.request.mockRejectedValueOnce(new TypeError('Offline'))
    await render()
    expect(toggle().disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
  })
})
