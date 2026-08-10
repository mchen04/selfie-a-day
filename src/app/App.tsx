import { useServiceWorker } from '../pwa/useServiceWorker.ts'
import { CaptureScreen } from './screens/CaptureScreen.tsx'
import { UndoTrash } from './components/UndoTrash.tsx'
import { OnboardingScreen } from './screens/OnboardingScreen.tsx'
import { PhotoScreen } from './screens/PhotoScreen.tsx'
import { SettingsScreen } from './screens/SettingsScreen.tsx'
import { TimelineScreen } from './screens/TimelineScreen.tsx'
import { TrashScreen } from './screens/TrashScreen.tsx'
import { useRoute } from './router.ts'
import { useApp } from './store-context.ts'

export function App() {
  const { status, settings, storageError } = useApp()
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
          <h1 className="section__title">Photo storage is unavailable</h1>
          <p className="tiny muted">{storageError}</p>
          <p className="tiny muted">
            Private browsing usually causes this. Open the app in a normal window and your photos
            will have somewhere to live.
          </p>
        </div>
      </div>
    )
  }

  if (settings.onboardingCompleteAt === null) return <OnboardingScreen />

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
