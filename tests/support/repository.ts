import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, matchesGlob } from 'node:path'

const excluded = new Set([
  '.git', '.agents', '.codex', '.aws', '.ssh', '.hermes', 'node_modules', 'dist', 'dev-dist', 'dist-ssr',
  '.wrangler', 'test-results', 'playwright-report', 'blob-report', 'coverage', 'evidence',
])
const textExtension = /\.(?:ts|tsx|js|mjs|cjs|json|jsonc|sql|html|css|md|toml|ya?ml)$/
const patterns = [
  /postgres(?:ql)?:\/\//i, /\bnpg_[A-Za-z0-9]{8,}/, new RegExp('neondb' + '_owner', 'i'),
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{24,}/,
]

export function credentialFiles(root: string): string[] {
  const ignoreFile = join(root, '.gitignore')
  const rules = (existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => ({
      pattern: line.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, ''),
      directory: line.endsWith('/'), negated: line.startsWith('!'), anchored: /^!?\//.test(line) || line.replace(/\/$/, '').includes('/'),
    }))
  const found: string[] = []
  function walk(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || excluded.has(entry.name) || /^(?:\.env|\.dev\.vars)(?:\.|$)/.test(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      let ignored = false
      for (const rule of rules) {
        if (rule.directory && !entry.isDirectory()) continue
        if (matchesGlob(rule.anchored ? rel : basename(rel), rule.pattern)) ignored = !rule.negated
      }
      if (ignored) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path, rel)
      else if (entry.isFile() && textExtension.test(entry.name)) {
        const content = readFileSync(path, 'utf8')
        if (patterns.some((pattern) => pattern.test(content))) found.push(rel)
      }
    }
  }
  walk(root)
  return found.sort()
}
