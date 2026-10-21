import { act, createElement, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider } from '../../../src/app/StoreProvider.tsx'
import { AccountScreen } from '../../../src/app/account/AccountScreen.tsx'
import { useApp, type AppContextValue } from '../../../src/app/store-context.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { cacheUser, cachedUser, listPending, queuePhoto, readSnapshot, writeSnapshot } from '../../../src/storage/local.ts'
import { SyncEngine } from '../../../src/sync/engine.ts'
import { pending, photo, reply, server } from './fixtures.ts'

const owner = { id: 'synthetic-a', username: 'synthetic-a' }
const other = { id: 'synthetic-b', username: 'synthetic-b' }
let root: Root
let container: HTMLDivElement
let app: AppContextValue
let remote: ReturnType<typeof server>
let session: Promise<Response>
let respond: (response: Response) => void
let fail: (error: Error) => void
let rendered: Array<{ userId: string | undefined; ids: string[] }>

function Probe() {
  const value = useApp()
  useEffect(() => {
    app = value
    rendered.push({ userId: value.user?.id, ids: value.allMetas.map((item) => item.id) })
  }, [value])
  return value.status === 'signed-out' ? createElement(AccountScreen) : createElement('div', null, value.status)
}

async function mount(strict = false) {
  const provider = createElement(StoreProvider, null, createElement(Probe))
  await settle(() => { root.render(strict ? createElement(StrictMode, null, provider) : provider) })
}

async function settle(update: () => void) {
  await act(async () => { update(); await Promise.resolve() })
}

async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    check()
  }, { timeout: 500 })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  rendered = []
  remote = server()
  const original = remote.mocked.getMockImplementation()!
  session = new Promise((resolve, reject) => { respond = resolve; fail = reject })
  remote.mocked.mockImplementation((url, init) => {
    if (url === '/api/auth/me') return session
    if (url === '/api/auth/login') return Promise.resolve(reply({ user: other }))
    return original(url, init)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    respond(reply({ user: owner }))
    await Promise.resolve()
  })
  container.remove()
  vi.unstubAllGlobals()
})

describe('startup without a network wait', () => {
  it('shows the account form before a cold session check returns', async () => {
    await mount()
    await waitFor(() => expect(container.querySelector('[data-testid="account-screen"]')).not.toBeNull())
    expect(remote.mocked.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me'])
  })

  it('opens a valid cookie session after showing the account form', async () => {
    await mount()
    await waitFor(() => expect(app.status).toBe('signed-out'))
    await settle(() => { respond(reply({ user: owner })) })
    await waitFor(() => { expect(app.status).toBe('ready'); expect(app.syncing).toBe(false) })
    expect(app.user).toEqual(owner)
    expect(remote.mocked.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1)
  })

  it('keeps the visible account form when a cold session check returns 401', async () => {
    await mount()
    await waitFor(() => expect(app.status).toBe('signed-out'))
    const form = container.querySelector('[data-testid="account-screen"]')
    await settle(() => { respond(reply({ error: 'unauthenticated' }, 401)) })
    await waitFor(() => expect(app.status).toBe('signed-out'))
    expect(container.querySelector('[data-testid="account-screen"]')).toBe(form)
  })

  it('shows the offline sign-in error after the account form is already visible', async () => {
    await mount()
    await waitFor(() => expect(app.status).toBe('signed-out'))
    await settle(() => { fail(new TypeError('offline')) })
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Connect to sign in.'))
  })

  it('opens the cached account and fetches sync before validation without applying unverified data', async () => {
    const cached = photo(), updated = photo(cached.capturedAt + 1)
    await cacheUser(owner)
    await writeSnapshot(owner.id, { albums: [defaultAlbum()], photos: [cached], cursor: 'cached' })
    remote.setPhotos([updated])
    await mount(true)
    await waitFor(() => expect(app.status).toBe('ready'))
    expect(app.user).toEqual(owner)
    expect(app.allMetas.map((item) => item.id)).toEqual([cached.id])
    await waitFor(() => expect(remote.mocked.mock.calls.map(([url]) => url)).toContain('/api/sync?since=cached'))
    expect((await readSnapshot(owner.id))?.photos.map((item) => item.id)).toEqual([cached.id])
    await settle(() => { respond(reply({ user: owner })) })
    await waitFor(() => { expect(app.syncing).toBe(false); expect(app.allMetas.some((item) => item.id === updated.id)).toBe(true) })
    expect(remote.mocked.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1)
  })

  it('keeps the outbox and snapshot when startup validation returns 401', async () => {
    const entry = pending(owner.id)
    await cacheUser(owner)
    await writeSnapshot(owner.id, { albums: [defaultAlbum()], photos: [entry.meta], cursor: 'cached' })
    await queuePhoto(entry)
    await mount()
    await waitFor(() => expect(app.status).toBe('ready'))
    await settle(() => { respond(reply({ error: 'unauthenticated' }, 401)) })
    await waitFor(() => expect(app.status).toBe('signed-out'))
    expect(await cachedUser()).toBeNull()
    expect(await listPending(owner.id)).toHaveLength(1)
    expect((await readSnapshot(owner.id))?.photos.map((item) => item.id)).toEqual([entry.meta.id])
    expect(remote.uploadIds).toEqual([])
  })

  it('discards unverified sync when the cookie belongs to another account', async () => {
    const first = photo(), second = photo(first.capturedAt + 1)
    await cacheUser(owner)
    await writeSnapshot(owner.id, { albums: [defaultAlbum()], photos: [first], cursor: 'cached' })
    await queuePhoto(pending(owner.id, first))
    remote.setPhotos([second])
    await mount()
    await waitFor(() => expect(app.status).toBe('ready'))
    await settle(() => { respond(reply({ user: other })) })
    await waitFor(() => { expect(app.user).toEqual(other); expect(app.syncing).toBe(false) })
    expect(app.allMetas.map((item) => item.id)).toEqual([second.id])
    expect(rendered.filter((item) => item.userId === other.id).some((item) => item.ids.includes(first.id))).toBe(false)
    expect((await readSnapshot(owner.id))?.photos.map((item) => item.id)).toEqual([first.id])
    expect(await listPending(owner.id)).toHaveLength(1)
    expect(remote.uploadIds).toEqual([])
  })

  it('keeps the cached account open when session validation is offline', async () => {
    await cacheUser(owner)
    const cached = photo()
    await writeSnapshot(owner.id, { albums: [defaultAlbum()], photos: [cached], cursor: 'cached' })
    await mount()
    await waitFor(() => expect(app.status).toBe('ready'))
    await settle(() => { fail(new TypeError('offline')) })
    await waitFor(() => expect(app.syncing).toBe(false))
    expect(app.user).toEqual(owner)
    expect(app.allMetas.map((item) => item.id)).toEqual([cached.id])
  })

  it('shows a storage failure even while session validation is pending', async () => {
    await cacheUser(owner)
    vi.spyOn(SyncEngine.prototype, 'hydrate').mockRejectedValue(new Error('Could not read saved photos.'))
    await mount()
    await waitFor(() => expect(app.status).toBe('error'))
    expect(app.storageError).toBe('Could not read saved photos.')
  })

  it('ignores an old startup 401 after the account form signs in', async () => {
    await mount()
    await waitFor(() => expect(app.status).toBe('signed-out'))
    await act(async () => { await app.actions.signIn(other.username, crypto.randomUUID(), false) })
    await waitFor(() => expect(app.user).toEqual(other))
    await settle(() => { respond(reply({ error: 'unauthenticated' }, 401)) })
    await waitFor(() => expect(app.syncing).toBe(false))
    expect(app.user).toEqual(other)
    expect(app.status).toBe('ready')
  })

  it('ignores an old successful startup response after another account signs in', async () => {
    await mount()
    await waitFor(() => expect(app.status).toBe('signed-out'))
    await act(async () => { await app.actions.signIn(other.username, crypto.randomUUID(), false) })
    await waitFor(() => expect(app.user).toEqual(other))
    await settle(() => { respond(reply({ user: owner })) })
    await waitFor(() => expect(app.syncing).toBe(false))
    expect(app.user).toEqual(other)
    expect(await cachedUser()).toEqual(other)
  })
})
