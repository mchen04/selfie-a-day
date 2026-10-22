import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { photoUrl } from '../../../src/api/client.ts'
import { useStoredImage, type StoredImageState } from '../../../src/app/useStoredImage.ts'
import { queuePhoto, removePending } from '../../../src/storage/local.ts'
import { pending, photo } from './fixtures.ts'

vi.mock('../../../src/app/store-context.ts', () => ({ useApp: () => ({ user: { id: 'synthetic-a', username: 'synthetic-a' }, pendingIds: [] }) }))

let state: StoredImageState
let root: Root
let created: Blob[]
function Probe({ id, report }: { id: string; report: (image: StoredImageState) => void }) {
  const image = useStoredImage(id, 'thumb')
  useEffect(() => report(image))
  return null
}
async function show(id: string) { await act(async () => { root.render(createElement(Probe, { id, report: (image) => { state = image } })); await Promise.resolve() }) }

beforeEach(() => {
  created = []
  Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:synthetic-ghost' }, revokeObjectURL: () => undefined })
  root = createRoot(document.createElement('div'))
})
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve() }) })

describe('uploaded photo thumbnails', () => {
  it('load from the server, and from the album’s ghost when the server copy cannot load (offline before it was fetched)', async () => {
    const taken = pending('synthetic-a', photo(1_800_000_000_003))
    await queuePhoto(taken)
    await removePending('synthetic-a', taken.meta.id)
    await show(taken.meta.id)
    // The server copy comes first, so viewing it online leaves it in the HTTP cache
    // for after a newer photo replaces this one as the ghost.
    await vi.waitFor(() => expect(state.url).toBe(photoUrl(taken.meta.id, 'thumb')))
    await act(async () => { state.onError?.(); await Promise.resolve() })
    await vi.waitFor(() => expect(state.url).toBe('blob:synthetic-ghost'))
    expect(created.map((blob) => blob.size)).toEqual([taken.master.bytes.byteLength])
    expect(state.onError).toBeUndefined()
  })
  it('keep the server copy when this device has no ghost of the photo', async () => {
    const elsewhere = photo(1_800_000_000_004)
    await show(elsewhere.id)
    await vi.waitFor(() => expect(state.url).toBe(photoUrl(elsewhere.id, 'thumb')))
    await act(async () => { state.onError?.(); await Promise.resolve() })
    await vi.waitFor(() => expect(state).toMatchObject({ url: photoUrl(elsewhere.id, 'thumb'), loading: false, onError: undefined }))
    expect(created).toEqual([])
  })
})
