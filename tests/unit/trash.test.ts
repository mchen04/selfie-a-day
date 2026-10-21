import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrashScreen } from '../../src/app/screens/TrashScreen.tsx'
import { defaultAlbum } from '../../src/core/albums.ts'
import { photo } from './cloud/fixtures.ts'

const actions = vi.hoisted(() => ({ restorePhoto: vi.fn(), deletePhotoPermanently: vi.fn(), emptyTrash: vi.fn() }))
const trashed = { ...photo(), deletedAt: 100 }
vi.mock('../../src/app/store-context.ts', () => ({ useApp: () => ({
  trashedMetas: [trashed], albums: [defaultAlbum()], actions, status: 'ready', pendingIds: [], syncError: null,
}) }))
vi.mock('../../src/app/useStoredImage.ts', () => ({ useStoredImage: () => ({ url: null }) }))
vi.mock('../../src/app/router.ts', () => ({ goBack: vi.fn() }))
let root: Root
let container: HTMLDivElement

function button(id: string) { return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)! }
async function click(id: string) { await act(async () => { button(id).click(); await Promise.resolve() }) }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  actions.emptyTrash.mockResolvedValue(1)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(TrashScreen)); await Promise.resolve() })
})
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve() }); container.remove(); vi.unstubAllGlobals() })

describe('inline irreversible action confirmation', () => {
  it.each([['empty-trash', 'emptyTrash', 'Confirm'], ['trash-delete-permanently', 'deletePhotoPermanently', 'Delete forever?']] as const)(
    'requires two taps for %s and resets confirmation on blur', async (id, action, label) => {
      const modal = vi.spyOn(window, 'confirm')
      await click(id)
      expect(actions[action]).not.toHaveBeenCalled()
      expect(button(id).textContent).toContain(label)
      await act(async () => { button(id).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await Promise.resolve() })
      await click(id)
      expect(actions[action]).not.toHaveBeenCalled()
      await click(id)
      expect(actions[action]).toHaveBeenCalledOnce()
      expect(modal).not.toHaveBeenCalled()
    },
  )
})
