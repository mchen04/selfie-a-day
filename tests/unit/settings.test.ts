import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '../../src/core/types.ts'
import { coerceSettings, loadSettings, saveSettings } from '../../src/storage/settings.ts'

describe('coerceSettings', () => {
  it('returns defaults for anything that is not an object', () => {
    for (const junk of [null, undefined, 42, 'settings', [], true]) {
      expect(coerceSettings(junk)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('keeps valid values', () => {
    const stored = {
      ghostOpacity: 0.7,
      gridStyle: 'crosshair',
      mirrorPreview: false,
      captureLongEdge: 960,
      ghostEnabled: false,
      activeAlbumId: 'album-0000000001abcdefghij',
      schema: 1,
    }
    expect(coerceSettings(stored)).toEqual({ ...stored, schema: SCHEMA_VERSION })
  })

  it('clamps out-of-range numbers rather than trusting them', () => {
    // A ghost at opacity 0 is invisible and at 1 hides the live preview; both
    // are states the alignment aid must never be able to reach.
    expect(coerceSettings({ ghostOpacity: 0 }).ghostOpacity).toBe(0.05)
    expect(coerceSettings({ ghostOpacity: 5 }).ghostOpacity).toBe(0.95)
    expect(coerceSettings({ ghostOpacity: -3 }).ghostOpacity).toBe(0.05)
    expect(coerceSettings({ captureLongEdge: 99_999 }).captureLongEdge).toBe(4096)
    expect(coerceSettings({ captureLongEdge: 1 }).captureLongEdge).toBe(480)
  })

  it('rejects NaN and Infinity', () => {
    expect(coerceSettings({ ghostOpacity: Number.NaN }).ghostOpacity).toBe(DEFAULT_SETTINGS.ghostOpacity)
    expect(coerceSettings({ captureLongEdge: Infinity }).captureLongEdge).toBe(DEFAULT_SETTINGS.captureLongEdge)
  })

  it('falls back per field, so one bad value cannot poison the rest', () => {
    const result = coerceSettings({ gridStyle: 'spiral', ghostOpacity: 0.6, mirrorPreview: 'yes' })
    expect(result.gridStyle).toBe(DEFAULT_SETTINGS.gridStyle)
    expect(result.mirrorPreview).toBe(DEFAULT_SETTINGS.mirrorPreview)
    expect(result.ghostOpacity).toBe(0.6)
  })


})

describe('settings persistence', () => {
  it('round-trips through IndexedDB', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, ghostOpacity: 0.8, gridStyle: 'off', mirrorPreview: false })
    const loaded = await loadSettings()
    expect(loaded.ghostOpacity).toBe(0.8)
    expect(loaded.gridStyle).toBe('off')
    expect(loaded.mirrorPreview).toBe(false)
  })

  it('returns defaults when nothing has been saved yet', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
