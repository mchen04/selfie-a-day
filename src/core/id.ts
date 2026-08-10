const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** 10 base-36 digits cover timestamps to the year 5138. */
const TIME_DIGITS = 10
const RANDOM_DIGITS = 10

function randomDigits(count: number): string {
  const bytes = new Uint8Array(count)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // Non-secure fallback: ids only need to not collide, never to be unguessable.
    for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (let i = 0; i < count; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

/**
 * Time-ordered id: lexicographic sort equals capture order, so IndexedDB's
 * natural key order is already the timeline order and no sorting pass is needed
 * to find the newest photo.
 */
export function newPhotoId(capturedAt: number = Date.now()): string {
  const time = Math.max(0, Math.floor(capturedAt)).toString(36).padStart(TIME_DIGITS, '0')
  return `${time}${randomDigits(RANDOM_DIGITS)}`
}

const ID_RE = new RegExp(`^[0-9a-z]{${TIME_DIGITS + RANDOM_DIGITS}}$`)

export function isPhotoId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}
