export const PASSWORD_ITERATIONS = 100000

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_encoding')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, PASSWORD_ITERATIONS)
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  let salt = new Uint8Array(16)
  let expected = new Uint8Array(32)
  let iterations = PASSWORD_ITERATIONS
  let valid = false
  if (stored) {
    try {
      const parts = stored.split('$')
      const count = Number(parts[1])
      const decodedSalt = unbase64url(parts[2] ?? '')
      const decodedHash = unbase64url(parts[3] ?? '')
      if (parts.length === 4 && parts[0] === 'pbkdf2-sha256' && Number.isInteger(count)
        && count > 0 && count <= PASSWORD_ITERATIONS && decodedSalt.length === 16 && decodedHash.length === 32) {
        salt = decodedSalt
        expected = decodedHash
        iterations = count
        valid = true
      }
    } catch {
      valid = false
    }
  }
  const actual = await derive(password, salt, iterations)
  let difference = 0
  for (let index = 0; index < 32; index++) difference |= actual[index]! ^ expected[index]!
  return valid && difference === 0
}

export async function tokenHash(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
