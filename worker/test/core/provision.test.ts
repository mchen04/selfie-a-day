import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHarness, type Harness } from '../support/harness'

const script = fileURLToPath(new URL('../../scripts/provision-user.mjs', import.meta.url))

describe('operator provisioning', () => {
  let h: Harness
  beforeAll(async () => { h = await createHarness() })
  afterAll(async () => { await h?.dispose() })

  it('prints one hash-only upsert and logs in with a three-character password', async () => {
    const password = randomBytes(2).toString('hex').slice(0, 3)
    const result = spawnSync(process.execPath, [script, '  JUSTIN  '], { input: `${password}\n`, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(result.stdout).toMatch(/^INSERT INTO users .*'justin', 'pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}'.*ON CONFLICT\(username\) DO UPDATE SET password_hash=excluded.password_hash;\n$/)
    expect(result.stdout).not.toContain(`'${password}'`)
    await h.sql(result.stdout)
    const login = await h.request('/api/auth/login', { method: 'POST', json: { username: 'justin', password } })
    expect(login.status).toBe(200)
    expect((await login.json<{ user: { username: string } }>()).user.username).toBe('justin')
    const signup = await h.request('/api/auth/signup', { method: 'POST', json: { username: 'short-signup', password } })
    expect(signup.status).toBe(400)
    expect(await signup.json()).toEqual({ error: 'invalid_password' })
    const replacement = randomBytes(12).toString('base64url')
    const updated = spawnSync(process.execPath, [script, 'justin'], { input: replacement, encoding: 'utf8' })
    expect(updated.status).toBe(0)
    await h.sql(updated.stdout)
    expect((await h.request('/api/auth/login', { method: 'POST', json: { username: 'justin', password: replacement } })).status).toBe(200)
    expect((await h.request('/api/auth/login', { method: 'POST', json: { username: 'justin', password } })).status).toBe(401)
  })

})

describe('operator input', () => {
  it('rejects invalid usernames and password argv without output', () => {
    for (const args of [[], ['ab'], ["bad'name"], ['valid', randomBytes(8).toString('hex')]]) {
      const result = spawnSync(process.execPath, [script, ...args], { input: randomBytes(12).toString('base64url'), encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Usage: provision-user.mjs <username>\n')
    }
  })

  it('disables terminal echo while reading the password', () => {
    const code = `
import json, os, pty, secrets, subprocess, sys, termios, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'tty-user'], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
for _ in range(500):
    if not termios.tcgetattr(slave)[3] & termios.ECHO:
        break
    time.sleep(0.01)
else:
    child.kill()
    raise RuntimeError('Terminal echo remains enabled')
password = secrets.token_hex(12).encode()
os.write(master, password + b'\\r')
out, err = child.communicate(timeout=5)
os.set_blocking(master, False)
try:
    echo = os.read(master, 8192)
except BlockingIOError:
    echo = b''
os.close(master)
os.close(slave)
print(json.dumps({'status': child.returncode, 'echoed': bool(echo), 'leaked': password in out or password in err, 'sql': out.startswith(b'INSERT INTO users '), 'stderr': bool(err)}))
`
    const result = spawnSync('python3', ['-c', code, process.execPath, script], { encoding: 'utf8', timeout: 10000 })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout) as unknown).toEqual({ status: 0, echoed: false, leaked: false, sql: true, stderr: false })
  })
})
