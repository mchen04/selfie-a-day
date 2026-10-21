import { randomBytes, pbkdf2Sync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/core/password'

describe('password hashing', () => {
  it('uses salted PBKDF2 with the contract format and rejects wrong passwords', async () => {
    const password = randomBytes(20).toString('base64url')
    const stored = await hashPassword(password)
    expect(stored).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(stored).not.toContain(password)
    expect(await verifyPassword(password, stored)).toBe(true)
    expect(await verifyPassword(randomBytes(20).toString('base64url'), stored)).toBe(false)
    expect(await hashPassword(password)).not.toBe(stored)
  })

  it('reads the stored iteration count', async () => {
    const password = randomBytes(20).toString('base64url')
    const salt = randomBytes(16)
    const hash = pbkdf2Sync(password, salt, 12000, 32, 'sha256')
    expect(await verifyPassword(password, `pbkdf2-sha256$12000$${salt.toString('base64url')}$${hash.toString('base64url')}`)).toBe(true)
  })

  it.each([null, '', 'broken', 'pbkdf2-sha256$999999999$bad$bad'])('runs one PBKDF2 for missing or malformed hashes: %s', async (stored) => {
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    try {
      expect(await verifyPassword(randomBytes(20).toString('base64url'), stored)).toBe(false)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![0]).toMatchObject({ name: 'PBKDF2', iterations: 100000, hash: 'SHA-256' })
    } finally {
      spy.mockRestore()
    }
  })
})
