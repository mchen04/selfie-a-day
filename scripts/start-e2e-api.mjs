import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const state = mkdtempSync(join(tmpdir(), 'selfie-e2e-'))
const config = ['-c', 'worker/wrangler.jsonc', '--env', 'local']
const local = ['--persist-to', state]
try {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', ...config, '--local', ...local], { stdio: 'inherit' })
  const child = spawn('npx', ['wrangler', 'dev', ...config, '--port', '8787', ...local], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code) => { rmSync(state, { recursive: true, force: true }); process.exit(code ?? 0) })
} catch (error) {
  rmSync(state, { recursive: true, force: true })
  throw error
}
