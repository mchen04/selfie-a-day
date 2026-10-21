import { useServiceWorker } from '../pwa/useServiceWorker.ts'
import { CaptureScreen } from './screens/CaptureScreen.tsx'
import { UndoTrash } from './components/UndoTrash.tsx'
import { AccountScreen } from './account/AccountScreen.tsx'
import { CloudStatus } from './components/cloud/CloudStatus.tsx'
import { PhotoScreen } from './screens/PhotoScreen.tsx'
import { SettingsScreen } from './screens/SettingsScreen.tsx'
import { TimelineScreen } from './screens/TimelineScreen.tsx'
import { TrashScreen } from './screens/TrashScreen.tsx'
import { useRoute } from './router.ts'
import { useApp } from './store-context.ts'

export function App() {
  const { status, user, storageError } = useApp()
  const route = useRoute()
  const sw = useServiceWorker()

  // Hold the first paint until settings are known. Rendering onboarding for a
  // frame and then swapping to the camera makes a returning user think their
  // history is gone, which is the worst possible first impression for this app.
  if (status === 'loading') {
    return (
      <div className="screen boot" data-testid="boot">
        <span className="spinner" aria-hidden="true" />
        <span className="visually-hidden">Loading</span>
      </div>
    )
  }

  if (status === 'error' && storageError) {
    return (
      <div className="screen boot" data-testid="boot-error">
        <div className="card stack" style={{ margin: 'auto', maxWidth: 340 }}>
          <h1 className="section__title">Device storage is unavailable</h1>
          <p className="tiny muted">{storageError}</p>
          <p className="tiny muted">
            Allow browser storage so new photos can wait safely for upload.
          </p>
        </div>
      </div>
    )
  }

  if (!user || status === 'signed-out') return <AccountScreen />

  return (
    <>
      {route.name === 'timeline' ? (
        <TimelineScreen />
      ) : route.name === 'trash' ? (
        <TrashScreen />
      ) : route.name === 'settings' ? (
        <SettingsScreen />
      ) : route.name === 'photo' ? (
        <PhotoScreen id={route.id} />
      ) : (
        <CaptureScreen />
      )}

      <CloudStatus />
      <UndoTrash />

      {sw.updateReady ? (
        <div className="banner banner--update" role="status" data-testid="update-banner">
          <span>A new version is ready.</span>
          <button type="button" className="btn" onClick={sw.applyUpdate} data-testid="update-apply">
            Update
          </button>
        </div>
      ) : null}
    </>
  )
}
