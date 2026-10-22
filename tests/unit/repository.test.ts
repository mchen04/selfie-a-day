import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialFiles } from '../support/repository.ts'

let root: string
const marker = ['sk', 'x'.repeat(30)].join('-')

function put(path: string, content = marker) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'selfie-source-scan-'))
  put('.gitignore', readFileSync(resolve(import.meta.dirname, '../../.gitignore'), 'utf8'))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('repository scan without Git metadata', () => {
  it('detects synthetic credential shapes in source and Worker files in a plain export', () => {
    put('src/untracked.ts')
    put('worker/src/sample.ts')
    expect(credentialFiles(root)).toEqual(['src/untracked.ts', 'worker/src/sample.ts'])
    rmSync(join(root, 'src/untracked.ts'))
    rmSync(join(root, 'worker/src/sample.ts'))
    expect(credentialFiles(root)).toEqual([])
  })

  it('skips generated output and local secret files while honoring ignore exceptions', () => {
    for (const directory of ['node_modules', 'dist', 'dev-dist', 'dist-ssr', '.wrangler', 'test-results', 'playwright-report', 'coverage', 'blob-report', '.vite', '.vercel', '.playwright', 'tests/fixtures', '.aws', 'worker/test/support/.vite', 'nested/.playwright']) put(`${directory}/output.json`)
    for (const path of ['.env', '.env.local', 'worker/.dev.vars', 'worker/.dev.vars.local', '.vscode/ignored.json']) put(path)
    put('.vscode/extensions.json')
    expect(credentialFiles(root)).toEqual(['.vscode/extensions.json'])
  })

  it('does not follow symlinks outside the source tree', () => {
    put('generated.local')
    mkdirSync(join(root, 'src'))
    symlinkSync(join(root, 'generated.local'), join(root, 'src/link.ts'))
    expect(credentialFiles(root)).toEqual([])
  })
})
