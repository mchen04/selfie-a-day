import { useId } from 'react'
import type { FlashPreference, TimerSeconds } from '../../../camera/preferences.ts'

export function CameraControls({ seconds, flash, counting, busy, available, onTimer, onFlash }: {
  seconds: TimerSeconds
  flash: FlashPreference
  counting: boolean
  busy: boolean
  available: boolean
  onTimer: () => void
  onFlash: () => void
}) {
  const reasonId = useId()
  return (
    <div className="camera-controls">
      <button
        type="button"
        className="iconbtn camera-controls__button"
        data-testid="camera-timer"
        data-seconds={seconds}
        aria-label={`Timer: ${seconds ? `${seconds} seconds` : 'Off'}`}
        aria-describedby={!available ? reasonId : undefined}
        disabled={!available || counting || busy}
        onClick={onTimer}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 2h4M12 2v3M18 5l2 2M12 9v4l2 1" />
          <circle cx="12" cy="14" r="8" />
        </svg>
        <span>{seconds ? `${seconds}s` : 'Off'}</span>
      </button>
      <button
        type="button"
        className="iconbtn camera-controls__button"
        data-testid="camera-flash"
        data-flash={flash}
        aria-label={`Flash: ${flash === 'on' ? 'On' : 'Off'}`}
        aria-pressed={flash === 'on'}
        aria-describedby={!available ? reasonId : undefined}
        disabled={!available || counting || busy}
        onClick={onFlash}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />
          {flash === 'off' ? <path d="m3 3 18 18" /> : null}
        </svg>
      </button>
      {!available ? (
        <span id={reasonId} className="visually-hidden">
          Timer and flash need a live preview. In camera roll mode, use the camera app controls.
        </span>
      ) : null}
    </div>
  )
}
