import { createECDH, createHash } from 'node:crypto'
import { resolve } from 'node:path'

/**
 * Fixed inputs for the ten-day simulation. Everything a rerun needs to reach the
 * same checks is derived here from constant labels: users, passwords, the VAPID
 * pair and the push receiver's keys. All of it is synthetic and test-only.
 *
 * Runs under plain `node` (tests/sim/api.ts imports it), so keep to erasable
 * TypeScript and Node built-ins.
 */

export const ORIGIN = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:4319').origin
export const API_ORIGIN = 'http://127.0.0.1:8787'
export const PUSH_PORT = Number(process.env.SIM_PUSH_PORT ?? 8790)
export const ZONE = 'America/Los_Angeles'
export const STATE_DIR = resolve(process.env.SIM_STATE_DIR ?? 'test-results/sim-state')
export const EVIDENCE_DIR = resolve(process.env.SIM_EVIDENCE_DIR ?? 'test-results/sim')
export const API_STATE_DIR = resolve(STATE_DIR, 'api')

export const digest = (label: string) => createHash('sha256').update(`selfie-a-day sim ${label}`).digest()

/** A P-256 pair whose private scalar is a hash of `label`. */
export function fixedKeyPair(label: string) {
  const pair = createECDH('prime256v1')
  pair.setPrivateKey(digest(label))
  return pair
}

export function vapidKeys() {
  const pair = fixedKeyPair('vapid')
  const scalar = Buffer.alloc(32)
  const privateBytes = pair.getPrivateKey()
  privateBytes.copy(scalar, scalar.length - privateBytes.length)
  return { publicKey: pair.getPublicKey().toString('base64url'), privateKey: scalar.toString('base64url') }
}

export interface SimAccount { username: string; password: string }
const account = (username: string): SimAccount => ({ username, password: digest(`password ${username}`).toString('base64url').slice(0, 24) })

/** The phone and desktop owner (Justin's role) and the unrelated account used for isolation. */
export const OWNER = account('sim-justin')
export const OUTSIDER = account('sim-outsider')

export const pushDeviceKeys = (device: string) => ({ pair: fixedKeyPair(`push ${device}`), auth: digest(`push auth ${device}`).subarray(0, 16) })
export const pushEndpoint = (device: string) => `http://127.0.0.1:${PUSH_PORT}/push/${device}`
