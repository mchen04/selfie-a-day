import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseAdvice, type AdviceKind } from '../../src/app/advice.ts'
import { DEFAULT_SETTINGS, type PhotoMeta, type Settings } from '../../src/core/types.ts'
import * as support from '../../src/camera/support.ts'

function photos(n: number): PhotoMeta[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id${i}`, dayKey: `2026-08-${i + 1}` }) as PhotoMeta)
}

const none: ReadonlySet<AdviceKind> = new Set()
const base = { settings: DEFAULT_SETTINGS, dismissed: none }

function onIOSBrowser() {
  vi.spyOn(support, 'isIOS').mockReturnValue(true)
  vi.spyOn(support, 'isStandalone').mockReturnValue(false)
}

afterEach(() => vi.restoreAllMocks())

describe('chooseAdvice', () => {
  it('says nothing on a clean day one', () => {
    expect(chooseAdvice({ ...base, metas: [] })).toBeNull()
  })

  it('warns an iOS browser user that installing starts a separate library', () => {
    onIOSBrowser()
    expect(chooseAdvice({ ...base, metas: photos(1) })).toBe('ios-separate-library')
  })

  it('stays quiet once the app is installed', () => {
    vi.spyOn(support, 'isIOS').mockReturnValue(true)
    vi.spyOn(support, 'isStandalone').mockReturnValue(true)
    expect(chooseAdvice({ ...base, metas: photos(1) })).toBeNull()
  })

  it('stays quiet on other platforms, which do not isolate installed storage', () => {
    vi.spyOn(support, 'isIOS').mockReturnValue(false)
    vi.spyOn(support, 'isStandalone').mockReturnValue(false)
    expect(chooseAdvice({ ...base, metas: photos(1) })).toBeNull()
  })

  it('nudges for a backup only once there is something worth losing', () => {
    vi.spyOn(support, 'isIOS').mockReturnValue(false)
    expect(chooseAdvice({ ...base, metas: photos(6) })).toBeNull()
    expect(chooseAdvice({ ...base, metas: photos(7) })).toBe('backup')
  })

  it('stops nudging after a real export', () => {
    vi.spyOn(support, 'isIOS').mockReturnValue(false)
    const settings: Settings = { ...DEFAULT_SETTINGS, lastExportAt: Date.now() }
    expect(chooseAdvice({ ...base, settings, metas: photos(200) })).toBeNull()
  })

  it('respects a dismissal', () => {
    vi.spyOn(support, 'isIOS').mockReturnValue(false)
    const dismissed: ReadonlySet<AdviceKind> = new Set<AdviceKind>(['backup'])
    expect(chooseAdvice({ ...base, dismissed, metas: photos(7) })).toBeNull()
  })

  it('falls through to the backup nudge once the iOS warning is dismissed', () => {
    onIOSBrowser()
    const dismissed: ReadonlySet<AdviceKind> = new Set<AdviceKind>(['ios-separate-library'])
    expect(chooseAdvice({ ...base, dismissed, metas: photos(9) })).toBe('backup')
  })
})
