import { createContext, useContext } from 'react'
import type { PhotoMeta, Settings } from '../core/types.ts'
import type { CaptureResult } from '../camera/capture.ts'

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  /** Set when the photo store itself is unusable — never hidden from the user. */
  storageError: string | null
  /** Newest first. `metas[0]` is what the ghost is derived from. */
  metas: PhotoMeta[]
  settings: Settings
}

export interface AppActions {
  savePhoto: (result: CaptureResult) => Promise<void>
  removePhoto: (id: string) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  reload: () => Promise<void>
}

export type AppContextValue = AppState & { actions: AppActions }

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside <StoreProvider>')
  return value
}
