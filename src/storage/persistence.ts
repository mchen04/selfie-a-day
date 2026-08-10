/**
 * Storage durability, reported honestly.
 *
 * WebKit evicts script-writable storage from sites the user has not visited for
 * a while, which for a daily-photo app is an existential risk rather than an
 * inconvenience. We do three things about it, in order of usefulness:
 *
 *  1. Ask for persistent storage (browsers that honour it stop evicting).
 *  2. Tell the user the truth about what the browser actually granted.
 *  3. Make export trivial, so eviction is recoverable instead of fatal.
 *
 * Only (3) is guaranteed to work everywhere, which is why the UI treats backup
 * as a first-class action rather than a settings-screen afterthought.
 */

export interface StorageStatus {
  /** `navigator.storage.persist()` / `persisted()` result, or null if unsupported. */
  persisted: boolean | null
  supported: boolean
  usageBytes: number | null
  quotaBytes: number | null
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const supported =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage === 'object' &&
    navigator.storage !== null

  if (!supported) {
    return { persisted: null, supported: false, usageBytes: null, quotaBytes: null }
  }

  let persisted: boolean | null = null
  try {
    persisted = typeof navigator.storage.persisted === 'function' ? await navigator.storage.persisted() : null
  } catch {
    persisted = null
  }

  let usageBytes: number | null = null
  let quotaBytes: number | null = null
  try {
    if (typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate()
      usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null
      quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null
    }
  } catch {
    // Some engines throw here in private modes. Absence is reported, not guessed.
  }

  return { persisted, supported, usageBytes, quotaBytes }
}

/**
 * Request persistent storage. Returns what the browser actually decided —
 * never an optimistic `true`. Safari historically returns false here, which the
 * UI is expected to surface rather than hide.
 */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (typeof navigator?.storage?.persist !== 'function') return null
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
