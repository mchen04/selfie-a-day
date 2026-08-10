import type { GridStyle, Settings } from '../../core/types.ts'
import { IconGhost, IconGrid } from './Icons.tsx'

const GRID_CYCLE: readonly GridStyle[] = ['thirds', 'crosshair', 'off']
const GRID_LABEL: Record<GridStyle, string> = {
  thirds: 'Thirds',
  crosshair: 'Eye line',
  off: 'No grid',
}

/**
 * Ghost and grid controls, on the capture screen and never behind a menu.
 *
 * The specific failure this app exists to avoid is an alignment aid that is
 * decorative — too faint to use and too buried to fix. Opacity is therefore a
 * one-thumb slider next to the shutter, not a settings-screen preference.
 */
export function GhostControls({
  settings,
  hasGhost,
  onChange,
}: {
  settings: Settings
  hasGhost: boolean
  onChange: (patch: Partial<Settings>) => void
}) {
  const gridIndex = GRID_CYCLE.indexOf(settings.gridStyle)
  const nextGrid = GRID_CYCLE[(gridIndex + 1) % GRID_CYCLE.length] ?? 'thirds'
  const ghostActive = settings.ghostEnabled && hasGhost

  return (
    <div className="ghostbar" data-testid="ghost-controls">
      <button
        type="button"
        className="chip"
        data-active={ghostActive}
        onClick={() => onChange({ ghostEnabled: !settings.ghostEnabled })}
        disabled={!hasGhost}
        aria-pressed={ghostActive}
        title={hasGhost ? 'Show or hide yesterday’s photo' : 'Your first photo becomes the ghost'}
        data-testid="ghost-toggle"
      >
        <IconGhost size={18} />
        <span>Ghost</span>
      </button>

      <label className="ghostbar__slider">
        <span className="visually-hidden">Ghost strength</span>
        <input
          type="range"
          min={5}
          max={95}
          step={5}
          value={Math.round(settings.ghostOpacity * 100)}
          disabled={!ghostActive}
          onChange={(event) => onChange({ ghostOpacity: Number(event.target.value) / 100 })}
          data-testid="ghost-opacity"
          aria-label="Ghost strength"
        />
      </label>

      <button
        type="button"
        className="chip"
        data-active={settings.gridStyle !== 'off'}
        onClick={() => onChange({ gridStyle: nextGrid })}
        title={`Grid: ${GRID_LABEL[settings.gridStyle]}. Tap for ${GRID_LABEL[nextGrid].toLowerCase()}.`}
        data-testid="grid-toggle"
        data-grid={settings.gridStyle}
      >
        <IconGrid size={18} />
        <span>{GRID_LABEL[settings.gridStyle]}</span>
      </button>
    </div>
  )
}
