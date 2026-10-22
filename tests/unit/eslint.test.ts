import { ESLint } from 'eslint'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const eslint = new ESLint({ cwd: root })
const outputs = ['.wrangler', 'dist', 'dev-dist', 'coverage', 'test-results', 'playwright-report', 'evidence']

describe('generated output lint boundaries', () => {
  it.each(outputs)('ignores %s output at every depth', async (directory) => {
    for (const prefix of ['', 'worker/', 'worker/test/']) {
      expect(await eslint.isPathIgnored(resolve(root, prefix, directory, 'tmp/middleware-loader.entry.ts'))).toBe(true)
    }
  })
  it.each(['src/sw.ts', 'worker/src/index.ts', 'worker/test/support/push-runtime.ts', 'tests/unit/offline.test.ts'])('keeps %s covered', async (path) => {
    expect(await eslint.isPathIgnored(resolve(root, path))).toBe(false)
  })
})
