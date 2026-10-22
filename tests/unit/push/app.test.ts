import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppContext, useApp, type AppContextValue } from '../../../src/app/store-context.ts'
import { App } from '../../../src/app/App.tsx'
import { SettingsScreen } from '../../../src/app/screens/SettingsScreen.tsx'
import { navigate } from '../../../src/app/router.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { DEFAULT_SETTINGS } from '../../../src/core/types.ts'
import { pushEnvironment } from './environment.ts'

vi.mock('../../../src/pwa/useServiceWorker.ts', () => ({ useServiceWorker: () => ({ updateReady: false }) }))
vi.mock('../../../src/app/screens/CaptureScreen.tsx', () => ({ CaptureScreen: () => createElement('div', { 'data-testid': 'capture' }, useApp().settings.activeAlbumId) }))
vi.mock('../../../src/app/components/cloud/CloudStatus.tsx', () => ({ CloudStatus: () => null }))
vi.mock('../../../src/app/components/UndoTrash.tsx', () => ({ UndoTrash: () => null }))

let root: Root
let container: HTMLDivElement
let env: ReturnType<typeof pushEnvironment>
let app: AppContextValue

async function render(component = App) {
  await act(async () => { root.render(createElement(AppContext.Provider, { value: app }, createElement(component))); await Promise.resolve() })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  env = pushEnvironment('granted')
  env.setSubscription(env.subscription)
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  app = {
    status: 'ready', user: { id: 'synthetic', username: 'synthetic' }, storageError: null,
    settings: DEFAULT_SETTINGS, albums: [defaultAlbum()], activeAlbum: defaultAlbum(),
    metas: [], allMetas: [], trashedMetas: [], pendingIds: [], syncing: false, syncError: null, undoTrash: null,
    actions: {
      signIn: vi.fn(), logout: vi.fn().mockResolvedValue(undefined), retrySync: vi.fn(), savePhoto: vi.fn(),
      trashPhoto: vi.fn(), restorePhoto: vi.fn(), deletePhotoPermanently: vi.fn(), emptyTrash: vi.fn(), dismissUndo: vi.fn(),
      selectAlbum: vi.fn().mockResolvedValue(undefined), createAlbum: vi.fn(), updateAlbum: vi.fn(), updateSettings: vi.fn(), reload: vi.fn(),
    },
  }
})
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve() })
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('app reminder integration', () => {
  it('re-syncs on authenticated startup, not again for an unchanged reconnect, without permission prompts', async () => {
    await render()
    await vi.waitFor(() => expect(env.request).toHaveBeenCalledOnce())
    await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(env.request).toHaveBeenCalledOnce()
    expect(env.notification.requestPermission).not.toHaveBeenCalled()
  })

  it('does not register subscriptions before signing in', async () => {
    app = { ...app, status: 'loading', user: null }
    await render()
    expect(env.request).not.toHaveBeenCalled()
  })

  it('selects the linked album and cleans the query after selection', async () => {
    const album = { ...defaultAlbum(), id: 'album-linked', name: 'Linked' }
    app = { ...app, albums: [...app.albums, album] }
    window.history.replaceState(null, '', '/?album=album-linked')
    await render()
    expect(app.actions.selectAlbum).toHaveBeenCalledWith('album-linked')
    expect(window.location.search).toBe('')
    expect(container.querySelector('[data-testid="capture"]')).not.toBeNull()
  })

  it('waits for a linked album to arrive through sync', async () => {
    window.history.replaceState(null, '', '/?album=album-linked')
    await render()
    expect(app.actions.selectAlbum).not.toHaveBeenCalled()
    app = { ...app, albums: [...app.albums, { ...defaultAlbum(), id: 'album-linked' }] }
    await render()
    expect(app.actions.selectAlbum).toHaveBeenCalledWith('album-linked')
    expect(window.location.search).toBe('')
  })

  it('handles a notification link while the capture window is already open', async () => {
    await render()
    window.history.pushState(null, '', '/?album=selfies')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); await Promise.resolve() })
    expect(app.actions.selectAlbum).toHaveBeenCalledWith('selfies')
    expect(window.location.search).toBe('')
    await act(async () => { navigate({ name: 'settings' }); await Promise.resolve() })
    expect(container.querySelector('[data-testid="settings-screen"]')).not.toBeNull()
  })

  it('logout removes push before the existing sign-out action', async () => {
    await render(SettingsScreen)
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="logout"]')!.click(); await Promise.resolve() })
    expect(env.unsubscribe).toHaveBeenCalledOnce()
    expect(app.actions.logout).toHaveBeenCalledOnce()
    expect(env.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(app.actions.logout).mock.invocationCallOrder[0]!)
  })

  it('does not sign out if subscription removal fails', async () => {
    await render(SettingsScreen)
    env.request.mockRejectedValueOnce(new TypeError('Offline'))
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="logout"]')!.click(); await Promise.resolve() })
    expect(app.actions.logout).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Offline')
  })
})

describe('settings album form', () => {
  function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('shows an album that syncs in after Settings opened and saves only real edits', async () => {
    await render(SettingsScreen)
    expect(container.querySelector('[data-testid="save-album"]')).toBeNull()
    const synced = { ...defaultAlbum(), timeZone: 'UTC' }
    app = { ...app, albums: [synced], activeAlbum: synced }
    await render(SettingsScreen)
    expect(container.querySelector<HTMLSelectElement>('[data-testid="album-timezone"]')!.value).toBe('UTC')
    expect(container.querySelector('[data-testid="save-album"]')).toBeNull()
    act(() => { type(container.querySelector<HTMLInputElement>('[data-testid="album-name"]')!, 'Progress') })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="save-album"]')!.click(); await Promise.resolve() })
    expect(app.actions.updateAlbum).toHaveBeenCalledWith(synced.id, { name: 'Progress', timeZone: 'UTC' })
  })
})
