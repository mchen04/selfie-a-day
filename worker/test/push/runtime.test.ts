import { execFile } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const requireWorker = createRequire(import.meta.url)
const requireWrangler = createRequire(requireWorker.resolve('wrangler'))
const { build } = requireWrangler('esbuild') as typeof import('esbuild')

it.each([
  ['the original browser environment', 'http://localhost:4319', false],
  ['an HTTPS subject and a padded short scalar', 'https://selfie-a-day.example', true],
] as const)('encrypts and sends %s inside workerd without following redirects', async (_case, subject, shortScalar) => {
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const vapid = createECDH('prime256v1')
  vapid.generateKeys()
  if (shortScalar) vapid.setPrivateKey(randomBytes(31))
  const privateKey = Buffer.alloc(32)
  const privateBytes = vapid.getPrivateKey()
  privateBytes.copy(privateKey, privateKey.length - privateBytes.length)
  await mkdir('worker/.wrangler', { recursive: true })
  const directory = await mkdtemp(resolve('worker/.wrangler/push-runtime-'))
  try {
    const bundle = await build({ entryPoints: ['worker/test/support/push-runtime.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
    await writeFile(join(directory, 'main.js'), bundle.outputFiles[0]!.text)
    await writeFile(join(directory, 'input.json'), JSON.stringify({
      env: {
        VAPID_SUBJECT: subject, VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
        VAPID_PRIVATE_KEY: privateKey.toString('base64url'), PUSH_ALLOW_INSECURE_ENDPOINTS: 'true',
      },
      subscription: { endpoint: 'http://127.0.0.1:8788/push', p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    }), { mode: 0o600 })
    await writeFile(join(directory, 'receiver.js'), `export default { async fetch(request) {
      if (request.method !== 'POST' || request.headers.get('Content-Encoding') !== 'aes128gcm'
        || !request.headers.get('Authorization')?.startsWith('vapid t=') || (await request.arrayBuffer()).byteLength < 100) {
        return new Response(null, { status: 400 })
      }
      if (new URL(request.url).pathname === '/redirect') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.test/should-not-follow' } })
      }
      return new Response(null, { status: 201 })
    } }`)
    await writeFile(join(directory, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (services = [
        (name = "test", worker = (compatibilityDate = "2026-10-01",
          modules = [(name = "main.js", esModule = embed "main.js")],
          bindings = [(name = "INPUT", json = embed "input.json")], globalOutbound = (name = "receiver"))),
        (name = "receiver", worker = (compatibilityDate = "2026-10-01",
          modules = [(name = "receiver.js", esModule = embed "receiver.js")]))
      ]);`)
    const { stderr } = await promisify(execFile)(requireWorker.resolve('workerd/bin/workerd'), ['test', join(directory, 'config.capnp')])
    expect(stderr).toContain('[ PASS ] test')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
