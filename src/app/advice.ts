import { isIOS, isStandalone } from '../camera/support.ts'
import type { PhotoMeta, Settings } from '../core/types.ts'

/**
 * `null` is deliberately not part of this union. It is the *absence* of advice,
 * not a kind of advice — keeping it out means a dismissal set cannot hold a
 * meaningless value and callers have to handle "nothing to say" explicitly.
 *
 * There is no 'storage-error' member: a storage failure that would warrant one
 * stops the app before the capture screen renders (see App.tsx), so an advisory
 * for it could never appear.
 */
export type AdviceKind = 'ios-separate-library' | 'backup'

/** After this many photos, an un-backed-up user gets one dismissible nudge. */
const BACKUP_NUDGE_AFTER = 7

/**
 * Decide the single most important thing to tell the user right now.
 *
 * At most one advisory is ever shown. A camera screen stacked with banners is a
 * camera screen nobody reads, and the whole point is that the frame stays the
 * loudest thing on it.
 */
export function chooseAdvice(input: {
  metas: readonly PhotoMeta[]
  settings: Settings
  dismissed: ReadonlySet<AdviceKind>
}): AdviceKind | null {
  const { metas, settings, dismissed } = input

  // The costliest surprise in this app: iOS gives a home-screen web app its own
  // storage container, so photos taken in a Safari tab do not travel to the
  // installed app. Someone who builds a streak in the browser and then installs
  // finds an empty timeline. Warn while it is still cheap to fix.
  if (metas.length > 0 && isIOS() && !isStandalone() && !dismissed.has('ios-separate-library')) {
    return 'ios-separate-library'
  }

  if (
    metas.length >= BACKUP_NUDGE_AFTER &&
    settings.lastExportAt === null &&
    !dismissed.has('backup')
  ) {
    return 'backup'
  }

  return null
}
