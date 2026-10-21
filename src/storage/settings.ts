import { DEFAULT_SETTINGS, SCHEMA_VERSION, type Settings } from '../core/types.ts'
import { readValue, writeValue, userKey } from './local.ts'

const SETTINGS_KEY = 'settings'

/** Derived from the type it validates, so adding a style cannot be forgotten here. */
const GRID_STYLES: readonly Settings['gridStyle'][] = ['thirds', 'crosshair', 'off']

/**
 * Read settings, repairing anything malformed rather than throwing.
 *
 * Settings are cosmetic; photos are not. A corrupt settings blob must never be
 * able to stop the app from opening the camera, so every field falls back
 * independently to its default.
 */
export async function loadSettings(userId = 'device'): Promise<Settings> {
  let stored: unknown = null
  try {
    stored = await readValue<unknown>(userKey(userId, SETTINGS_KEY))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  return coerceSettings(stored)
}

export function coerceSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS }
  const raw = stored as Record<string, unknown>

  const num = (key: keyof Settings, min: number, max: number, fallback: number): number => {
    const v = raw[key]
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  }
  const bool = (key: keyof Settings, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : fallback
  const oneOf = <T extends string>(key: keyof Settings, allowed: readonly T[], fallback: T): T => {
    const v = raw[key]
    return allowed.includes(v as T) ? (v as T) : fallback
  }
  const string = (key: keyof Settings, fallback: string): string => {
    const v = raw[key]
    return typeof v === 'string' && v.length > 0 ? v : fallback
  }

  return {
    ghostOpacity: num('ghostOpacity', 0.05, 0.95, DEFAULT_SETTINGS.ghostOpacity),
    gridStyle: oneOf('gridStyle', GRID_STYLES, DEFAULT_SETTINGS.gridStyle),
    mirrorPreview: bool('mirrorPreview', DEFAULT_SETTINGS.mirrorPreview),
    captureLongEdge: num('captureLongEdge', 480, 4096, DEFAULT_SETTINGS.captureLongEdge),
    ghostEnabled: bool('ghostEnabled', DEFAULT_SETTINGS.ghostEnabled),
    activeAlbumId: string('activeAlbumId', DEFAULT_SETTINGS.activeAlbumId),
    schema: SCHEMA_VERSION,
  }
}

export async function saveSettings(settings: Settings, userId = 'device'): Promise<void> {
  await writeValue(userKey(userId, SETTINGS_KEY), { ...settings, schema: SCHEMA_VERSION })
}
