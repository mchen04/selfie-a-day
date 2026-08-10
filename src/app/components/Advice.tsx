import { IconClose, IconExport, IconShield } from './Icons.tsx'
import type { AdviceKind } from '../advice.ts'

export function Advice({
  kind,
  photoCount,
  onBackup,
  onDismiss,
}: {
  kind: AdviceKind | null
  photoCount: number
  onBackup: () => void
  onDismiss: (kind: AdviceKind) => void
}) {
  if (kind === null) return null

  if (kind === 'ios-separate-library') {
    return (
      <div className="banner banner--nudge" data-testid="ios-library-warning">
        <IconShield size={18} />
        <span>Export before adding to your Home Screen</span>
        <button type="button" className="banner__link" onClick={onBackup}>
          Export
        </button>
        <button
          type="button"
          className="banner__link banner__link--icon"
          onClick={() => onDismiss('ios-separate-library')}
          aria-label="Dismiss this warning"
        >
          <IconClose size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="banner banner--nudge" data-testid="backup-nudge">
      <IconExport size={18} />
      <span>{photoCount} photos and no backup yet</span>
      <button type="button" className="banner__link" onClick={onBackup}>
        Back up
      </button>
      <button
        type="button"
        className="banner__link banner__link--icon"
        onClick={() => onDismiss('backup')}
        aria-label="Dismiss backup reminder"
      >
        <IconClose size={16} />
      </button>
    </div>
  )
}
