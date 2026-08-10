import { useState } from 'react'
import { isIOS, isStandalone } from '../../camera/support.ts'
import { requestPersistence } from '../../storage/persistence.ts'
import { IconCamera, IconGhost, IconShield } from '../components/Icons.tsx'
import { useApp } from '../store-context.ts'

/**
 * First run. Three sentences and one button.
 *
 * The permission prompt is deliberately not fired on load: an unexplained
 * camera request is the single most common reason people deny it, and a denied
 * camera on day one is a user who never comes back. The button is the
 * explanation and the gesture at the same time.
 */
export function OnboardingScreen() {
  const { actions } = useApp()
  const [starting, setStarting] = useState(false)
  const showInstallHint = isIOS() && !isStandalone()

  const begin = async () => {
    setStarting(true)
    // Ask for durable storage while a user gesture is still in scope; some
    // engines only honour the request inside one.
    void requestPersistence()
    await actions.updateSettings({ onboardingCompleteAt: Date.now() })
  }

  return (
    <div className="screen onboarding" data-testid="onboarding-screen">
      <div className="screen__scroll onboarding__body">
        <div className="onboarding__mark" aria-hidden="true">
          <span className="onboarding__ring onboarding__ring--ghost" />
          <span className="onboarding__ring" />
          <span className="onboarding__dot" />
        </div>

        <h1 className="onboarding__title">One selfie a day</h1>
        <p className="onboarding__lede">
          Line your face up with a faint ghost of your last photo, tap once, and watch yourself
          change over months instead of jumping around.
        </p>

        <ul className="onboarding__points">
          <li>
            <IconGhost size={20} />
            <div>
              <strong>Yesterday, showing through</strong>
              <span className="muted">
                Your previous photo sits over the live camera so today lines up with it.
              </span>
            </div>
          </li>
          <li>
            <IconShield size={20} />
            <div>
              <strong>Nothing leaves this device</strong>
              <span className="muted">
                No account, no upload, no cloud. Export a .zip whenever you want a copy.
              </span>
            </div>
          </li>
          <li>
            <IconCamera size={20} />
            <div>
              <strong>Under five seconds</strong>
              <span className="muted">Open, align, tap. That is the whole app.</span>
            </div>
          </li>
        </ul>

        {showInstallHint ? (
          <p className="onboarding__install tiny muted" data-testid="ios-install-hint">
            On iPhone, tap <strong>Share</strong> then <strong>Add to Home Screen</strong> to keep
            this app — and its photos — for good.
          </p>
        ) : null}
      </div>

      <div className="onboarding__foot">
        <button
          type="button"
          className="btn btn--primary btn--wide"
          onClick={() => void begin()}
          disabled={starting}
          data-testid="onboarding-start"
        >
          {starting ? 'Starting…' : 'Turn on the camera'}
        </button>
        <p className="tiny muted onboarding__foot-note">
          Your browser will ask for camera permission next.
        </p>
      </div>
    </div>
  )
}
