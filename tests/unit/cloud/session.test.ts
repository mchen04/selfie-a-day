import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider } from '../../../src/app/StoreProvider.tsx'
import { useApp, type AppContextValue } from '../../../src/app/store-context.ts'
import { api } from '../../../src/api/client.ts'
import { cacheUser, cachedUser, listPending, listGhosts, queuePhoto, readSnapshot } from '../../../src/storage/local.ts'
import { defaultAlbum } from '../../../src/core/albums.ts'
import { pending, photo, reply, server } from './fixtures.ts'

let root: Root
let container: HTMLDivElement
let app: AppContextValue
let user: { id: string; username: string } | null
const owner = { id: 'synthetic-a', username: 'synthetic-a' }
let remote: ReturnType<typeof server>
const entry = pending(owner.id, photo(1_800_000_000_001))
entry.nextAttemptAt = Number.MAX_SAFE_INTEGER

function Probe() {
  const value = useApp()
  useEffect(() => { app = value }, [value])
  return createElement('div', null, value.status)
}
async function ready(status: AppContextValue['status']) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(app.status).toBe(status)
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  user = owner
  remote = server([photo()])
  const original = remote.mocked.getMockImplementation()!
  remote.mocked.mockImplementation((url, init) => {
    if (url === '/api/auth/me') return Promise.resolve(user ? reply({ user }) : reply({ error: 'unauthenticated' }, 401))
    if (url === '/api/auth/login') {
      const { username } = JSON.parse(init?.body as string) as { username: string }
      user = { id: username, username }
      return Promise.resolve(reply({ user }))
    }
    if (url === '/api/auth/logout') { user = null; return Promise.resolve(new Response(null, { status: 204 })) }
    if (init?.method === 'PUT' && user?.id !== owner.id) return Promise.resolve(reply({ error: 'user_mismatch' }, 409))
    if (url.startsWith('/api/sync') && user?.id !== owner.id) return Promise.resolve(reply({ albums: [defaultAlbum()], photos: [], removed: [], cursor: 'other', serverTime: 1 }))
    return original(url, init)
  })
  await cacheUser(owner)
  await queuePhoto(entry)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(StoreProvider, null, createElement(Probe))); await Promise.resolve() })
  await ready('ready')
})
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve() }); container.remove(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })

async function expire() {
  user = null
  await act(async () => { await api.me().catch(() => undefined) })
  await ready('signed-out')
}

describe('signing in', () => {
  it('opens the camera after logging out from Settings and signing back in', async () => {
    window.history.pushState(null, '', '/settings')
    await act(async () => { await app.actions.logout() })
    await ready('signed-out')
    await act(async () => { await app.actions.signIn(owner.username, crypto.randomUUID(), false) })
    await ready('ready')
    expect(window.location.pathname).toBe('/')
  })
  it('keeps an album link while signing in', async () => {
    await expire()
    window.history.replaceState(null, '', '/?album=selfies')
    await act(async () => { await app.actions.signIn(owner.username, crypto.randomUUID(), false) })
    await ready('ready')
    expect(window.location.pathname + window.location.search).toBe('/?album=selfies')
  })
})

describe('expired account sessions', () => {
  it('signs out after an upload finds another account and resumes only for the original owner', async () => {
    user = { id: 'synthetic-b', username: 'synthetic-b' }
    await act(async () => { await app.actions.retrySync() })
    await ready('signed-out')
    expect(await cachedUser()).toBeNull()
    expect(await listPending(owner.id)).toHaveLength(1)
    expect(await listPending(user.id)).toEqual([])
    expect(remote.uploadIds).toEqual([])
    await act(async () => { await app.actions.signIn(owner.username, crypto.randomUUID(), false) })
    await ready('ready')
    await act(async () => { await app.actions.retrySync() })
    expect(remote.uploadIds).toEqual([entry.meta.id])
    expect(await listPending(owner.id)).toEqual([])
  })

  it('keeps queued photos and caches on 401 and resumes uploads for the same user', async () => {
    await expire()
    expect(await cachedUser()).toBeNull()
    expect(await listPending(owner.id)).toHaveLength(1)
    expect(await listGhosts(owner.id)).toHaveLength(1)
    expect((await readSnapshot(owner.id))?.photos).toHaveLength(1)
    await act(async () => { await app.actions.signIn(owner.username, crypto.randomUUID(), false) })
    await ready('ready')
    await act(async () => { await app.actions.retrySync() })
    expect(remote.uploadIds).toEqual([entry.meta.id])
    expect(await listPending(owner.id)).toEqual([])
  })

  it('isolates retained photos when another user signs in and clears only an explicit logout', async () => {
    await expire()
    await act(async () => { await app.actions.signIn('synthetic-b', crypto.randomUUID(), false) })
    await ready('ready')
    await act(async () => { await app.actions.reload() })
    expect(app.allMetas).toEqual([])
    expect(app.pendingIds).toEqual([])
    expect(remote.uploadIds).toEqual([])
    expect(await listPending(owner.id)).toHaveLength(1)
    await act(async () => { await app.actions.logout() })
    await ready('signed-out')
    await act(async () => { await app.actions.signIn(owner.username, crypto.randomUUID(), false) })
    await ready('ready')
    await act(async () => { await app.actions.logout() })
    await ready('signed-out')
    expect(await listPending(owner.id)).toEqual([])
    expect(await listGhosts(owner.id)).toEqual([])
    expect(await readSnapshot(owner.id)).toBeNull()
  })
})
