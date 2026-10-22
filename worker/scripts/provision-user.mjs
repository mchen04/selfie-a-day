#!/usr/bin/env node
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto'
import { stdin, stdout, stderr } from 'node:process'

async function passwordFromStdin() {
  const chunks = []
  let length = 0
  if (stdin.isTTY) stdin.setRawMode(true)
  try {
    for await (const chunk of stdin) {
      for (const byte of chunk) {
        if (stdin.isTTY && byte === 3) throw new Error('Cancelled')
        if (stdin.isTTY && (byte === 13 || byte === 10 || byte === 4)) return Buffer.from(chunks).toString('utf8')
        if (stdin.isTTY && (byte === 8 || byte === 127)) {
          if (chunks.length) chunks.pop()
          continue
        }
        chunks.push(byte)
        length++
        if (length > 4096) throw new Error('Password input is too long')
      }
    }
    return Buffer.from(chunks).toString('utf8').replace(/\r?\n$/, '')
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

try {
  const username = (process.argv[2] ?? '').trim().toLowerCase()
  if (process.argv.length !== 3 || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Usage: provision-user.mjs <username>')
  const password = await passwordFromStdin()
  if (password.length === 0 || password.length > 256) throw new Error('Password must contain 1–256 characters')
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  const stored = `pbkdf2-sha256$100000$${salt.toString('base64url')}$${hash.toString('base64url')}`
  stdout.write(`INSERT INTO users (id, username, password_hash) VALUES ('${randomUUID()}', '${username}', '${stored}') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash;\n`)
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : 'Provisioning failed'}\n`)
  process.exitCode = 1
}
