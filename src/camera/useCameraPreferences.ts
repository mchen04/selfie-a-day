import { useSyncExternalStore } from 'react'
import {
  parseTimer,
  readFlash,
  readPreference,
  resolveTimer,
  subscribePreferences,
  timerKey,
  type LatestTimerPhoto,
} from './preferences.ts'

export function useCameraPreferences(albumId: string, latest: LatestTimerPhoto | null) {
  const local = useSyncExternalStore(subscribePreferences, () => readPreference(timerKey(albumId)))
  const flash = useSyncExternalStore(subscribePreferences, readFlash)
  return { seconds: resolveTimer(parseTimer(local), latest), flash }
}
