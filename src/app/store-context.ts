import { createContext, useContext } from 'react'
import type { Album, PhotoMeta, Settings } from '../core/types.ts'
import type { CaptureResult } from '../camera/capture.ts'

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  /** Set when the photo store itself is unusable — never hidden from the user. */
  storageError: string | null
  /** Newest first. `metas[0]` is what the ghost is derived from. */
  metas: PhotoMeta[]
  /** Every active photo, used for backup and device storage totals. */
  allMetas: PhotoMeta[]
  trashedMetas: PhotoMeta[]
  /** Most recently trashed photo, kept briefly for the global Undo action. */
  undoTrash: PhotoMeta | null
  albums: Album[]
  activeAlbum: Album
  settings: Settings
}

export interface AppActions {
  savePhoto: (result: CaptureResult) => Promise<void>
  trashPhoto: (id: string) => Promise<void>
  restorePhoto: (id: string) => Promise<void>
  deletePhotoPermanently: (id: string) => Promise<void>
  emptyTrash: () => Promise<number>
  dismissUndo: () => void
  selectAlbum: (id: string) => Promise<void>
  createAlbum: (name: string) => Promise<Album>
  updateAlbum: (id: string, patch: { name?: string; timeZone?: string | null }) => Promise<Album>
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
