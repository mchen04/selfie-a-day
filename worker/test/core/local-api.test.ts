import { createECDH } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { ensureLocalVapid } = createRequire(import.meta.url)('../../scripts/local-api.mjs') as {
  ensureLocalVapid: (file: string) => void
}
const directories: string[] = []

function file() {
  const directory = mkdtempSync(join(tmpdir(), 'selfie-local-keys-'))
  directories.push(directory)
  return join(directory, '.dev.vars')
}

function keys(path: string) {
  const contents = readFileSync(path, 'utf8')
  const publicKey = /^VAPID_PUBLIC_KEY=(.+)$/m.exec(contents)?.[1] ?? ''
  const privateKey = /^VAPID_PRIVATE_KEY=(.+)$/m.exec(contents)?.[1] ?? ''
  const pair = createECDH('prime256v1')
  pair.setPrivateKey(Buffer.from(privateKey, 'base64url'))
  expect(pair.getPublicKey().toString('base64url') === publicKey).toBe(true)
  expect(Buffer.from(publicKey, 'base64url').length).toBe(65)
  expect(Buffer.from(privateKey, 'base64url').length).toBe(32)
  return { publicKey, contents }
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('local VAPID state', () => {
  it('creates a matching private pair once per state with restricted file access', () => {
    const first = file(), second = file()
    ensureLocalVapid(first)
    const before = keys(first)
    expect(statSync(first).mode & 0o777).toBe(0o600)
    ensureLocalVapid(first)
    expect(keys(first).contents === before.contents).toBe(true)
    ensureLocalVapid(second)
    expect(keys(second).publicKey !== before.publicKey).toBe(true)
  })

  it('replaces placeholders and repairs a mismatched public key without changing the private key', () => {
    const path = file()
    writeFileSync(path, 'OTHER=synthetic\nVAPID_PRIVATE_KEY=placeholder\nVAPID_PUBLIC_KEY=placeholder\n')
    ensureLocalVapid(path)
    const before = keys(path)
    writeFileSync(path, before.contents.replace(/^VAPID_PUBLIC_KEY=.+$/m, 'VAPID_PUBLIC_KEY=placeholder'))
    ensureLocalVapid(path)
    expect(keys(path).contents === before.contents).toBe(true)
    expect(readFileSync(path, 'utf8').startsWith('OTHER=synthetic\n')).toBe(true)
  })
})
