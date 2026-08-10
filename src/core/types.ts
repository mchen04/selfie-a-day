import type { DayKey } from './day.ts'

/** Bumped only when the *shape* of a stored record changes. See storage/db.ts. */
export const SCHEMA_VERSION = 1

export type CaptureSource = 'camera' | 'file'

/**
 * Everything about a photo except its pixels.
 *
 * Deliberately small: the timeline reads every record in this store on load, so
 * one cursor pass over a decade of photos still costs well under a megabyte.
 */
export interface PhotoMeta {
  /** Sortable, collision-resistant. Lexicographic order === capture order. */
  id: string
  dayKey: DayKey
  capturedAt: number
  /** Minutes returned by `Date.prototype.getTimezoneOffset` at capture time. */
  tzOffsetMinutes: number
  width: number
  height: number
  mime: string
  /**
   * The space the stored pixels are in. `true` means mirrored — the reflection
   * the user saw while aligning. The ghost renderer compares this against the
   * current preview to decide whether a flip is needed, which is what lets the
   * mirror setting change without corrupting older photos' alignment.
   */
  mirrored: boolean
  source: CaptureSource
  /** Byte sizes, so Settings can report storage usage without loading pixels. */
  masterBytes: number
  thumbBytes: number
  schema: number
}

export interface StoredImage {
  id: string
  mime: string
  width: number
  height: number
  /** ArrayBuffer, not Blob: structured-clone of Blobs into IndexedDB has a long
   * history of WebKit bugs, and iOS Safari is this app's hard target. */
  bytes: ArrayBuffer
}

export interface Photo {
  meta: PhotoMeta
  master: StoredImage
}

export type GridStyle = 'thirds' | 'crosshair' | 'off'

export interface Settings {
  /** 0–1. The ghost is useless if invisible and useless if it hides your face. */
  ghostOpacity: number
  gridStyle: GridStyle
  /** Mirror the live preview (and therefore what gets saved). */
  mirrorPreview: boolean
  /** Long edge of the stored master image, in pixels. */
  captureLongEdge: number
  /** Show the ghost at all. */
  ghostEnabled: boolean
  onboardingCompleteAt: number | null
  /**
   * When the user last exported a backup. Null means never — the state that
   * earns a single, dismissible reminder, because "I lost years of photos" is
   * the loudest complaint in this whole app category.
   */
  lastExportAt: number | null
  schema: number
}

export const DEFAULT_SETTINGS: Settings = {
  ghostOpacity: 0.45,
  gridStyle: 'thirds',
  mirrorPreview: true,
  captureLongEdge: 1440,
  ghostEnabled: true,
  onboardingCompleteAt: null,
  lastExportAt: null,
  schema: SCHEMA_VERSION,
}

/**
 * Sizes are measured, not guessed: a photographic-entropy test image encoded at
 * the shipped quality settings. A year figure is the one that actually informs
 * the choice — nobody budgets storage in kilobytes per day.
 */
export const CAPTURE_QUALITY_PRESETS = [
  { label: 'Compact', longEdge: 960, note: 'about 130 KB a photo, 45 MB a year' },
  { label: 'Standard', longEdge: 1440, note: 'about 190 KB a photo, 70 MB a year' },
  { label: 'High', longEdge: 2048, note: 'about 380 KB a photo, 135 MB a year' },
] as const
