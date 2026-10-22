import { createECDH } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function ensureLocalVapid(file) {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const privateValue = /^VAPID_PRIVATE_KEY\s*=\s*["']?([A-Za-z0-9_-]{43})["']?\s*$/m.exec(previous)?.[1]
  const pair = createECDH('prime256v1')
  if (privateValue) pair.setPrivateKey(Buffer.from(privateValue, 'base64url'))
  else pair.generateKeys()
  const scalar = Buffer.alloc(32)
  const privateBytes = pair.getPrivateKey()
  privateBytes.copy(scalar, scalar.length - privateBytes.length)
  const values = `VAPID_PUBLIC_KEY=${pair.getPublicKey().toString('base64url')}\nVAPID_PRIVATE_KEY=${scalar.toString('base64url')}\n`
  const other = previous.replace(/^VAPID_(?:PUBLIC|PRIVATE)_KEY\s*=.*(?:\r?\n|$)/gm, '').trimEnd()
  const next = `${other ? `${other}\n` : ''}${values}`
  if (next !== previous) writeFileSync(file, next, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function startLocalApi({ temporary = false } = {}) {
  const state = temporary ? mkdtempSync(join(tmpdir(), 'selfie-e2e-')) : undefined
  const vars = state ? join(state, '.dev.vars') : resolve('worker/.dev.vars')
  const config = ['-c', 'worker/wrangler.jsonc', '--env', 'local']
  const local = state ? ['--persist-to', state] : []
  const cleanup = () => { if (state) rmSync(state, { recursive: true, force: true }) }
  try {
    ensureLocalVapid(vars)
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', ...config, '--local', ...local], { stdio: 'inherit' })
    const child = spawn('npx', ['wrangler', 'dev', ...config, '--env-file', vars, '--port', '8787', ...local], { stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.on('error', () => { cleanup(); process.exit(1) })
    child.on('exit', (code) => { cleanup(); process.exit(code ?? 0) })
  } catch (error) {
    cleanup()
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startLocalApi()
