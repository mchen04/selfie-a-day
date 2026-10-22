import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_STATE_DIR, vapidKeys } from './config.ts'

/**
 * The simulation's local Worker: the same `wrangler dev --env local` as
 * scripts/start-e2e-api.mjs, but persisted to a known directory so the
 * simulation can read D1 row counts and R2 objects straight from Miniflare's
 * SQLite files, and with a VAPID pair derived from a fixed label.
 *
 * Started fresh for every run: `npm run sim` is one deterministic ten-day story.
 */
rmSync(API_STATE_DIR, { recursive: true, force: true })
mkdirSync(API_STATE_DIR, { recursive: true })
const vars = join(API_STATE_DIR, '.dev.vars')
const { publicKey, privateKey } = vapidKeys()
writeFileSync(vars, `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 })

const config = ['-c', 'worker/wrangler.jsonc', '--env', 'local']
const persist = ['--persist-to', API_STATE_DIR]
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', ...config, '--local', ...persist], { stdio: 'inherit' })
const child = spawn('npx', ['wrangler', 'dev', ...config, '--env-file', vars, '--port', '8787', ...persist], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
child.on('error', () => process.exit(1))
child.on('exit', (code) => process.exit(code ?? 0))
