/**
 * Environment detection for the capture path.
 *
 * The app never assumes `getUserMedia` exists. iOS shipped standalone
 * home-screen web apps without it for years (WebKit bug 185448), and a user on
 * an older device is not a user we are willing to leave with a dead button — so
 * the file-input fallback is chosen automatically from these checks, not from a
 * user-agent guess.
 */

export function supportsGetUserMedia(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices === 'object' &&
    navigator.mediaDevices !== null &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

/** getUserMedia requires a secure context: https, or localhost during development. */
export function isSecureContextOk(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true
}

/** `capture` on a file input asks the OS for the camera instead of the library. */
export function supportsCaptureAttribute(): boolean {
  return typeof document !== 'undefined' && 'capture' in document.createElement('input')
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  // iOS predates the standard and only reports through the legacy property.
  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone
  if (legacy === true) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS 13+ reports as Macintosh; touch points is the reliable discriminator.
  const iPadOS = ua.includes('Macintosh') && navigator.maxTouchPoints > 1
  return /iPad|iPhone|iPod/.test(ua) || iPadOS
}

export type CapturePath = 'stream' | 'file'

export interface CaptureCapabilities {
  path: CapturePath
  supportsGetUserMedia: boolean
  secureContext: boolean
  supportsCaptureAttribute: boolean
  /** Plain-language reason the fallback was chosen, for the UI to show. */
  fallbackReason: string | null
}

export function detectCaptureCapabilities(): CaptureCapabilities {
  const gum = supportsGetUserMedia()
  const secure = isSecureContextOk()
  const captureAttr = supportsCaptureAttribute()

  let fallbackReason: string | null = null
  if (!secure) fallbackReason = 'Live camera needs a secure (https) connection.'
  else if (!gum) fallbackReason = 'This browser does not offer a live camera to web apps.'

  return {
    path: gum && secure ? 'stream' : 'file',
    supportsGetUserMedia: gum,
    secureContext: secure,
    supportsCaptureAttribute: captureAttr,
    fallbackReason,
  }
}
