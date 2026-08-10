import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '../../src')

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const FILES = sourceFiles().map((path) => ({
  path,
  rel: relative(SRC, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}))

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1]!)
}

function layerOf(rel: string): string {
  return rel.split('/')[0] ?? ''
}

describe('layering', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(15)
  })

  /**
   * core is the domain: pure functions with no DOM, no storage, no React.
   * Keeping it that way is what makes the geometry testable without a browser,
   * which is the only reason the alignment invariant can be checked at all.
   */
  it('core depends on nothing but itself', () => {
    const offenders: string[] = []
    for (const file of FILES.filter((f) => layerOf(f.rel) === 'core')) {
      for (const spec of importsOf(file.text)) {
        const isRelativeWithinCore = spec.startsWith('./')
        const isBare = !spec.startsWith('.')
        if (!isRelativeWithinCore || (isBare && spec !== 'react')) {
          if (!isRelativeWithinCore) offenders.push(`${file.rel} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('storage does not reach into camera or app', () => {
    const offenders: string[] = []
    for (const file of FILES.filter((f) => layerOf(f.rel) === 'storage')) {
      for (const spec of importsOf(file.text)) {
        if (spec.includes('../camera/') || spec.includes('../app/') || spec.includes('../pwa/')) {
          offenders.push(`${file.rel} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('camera does not reach into app', () => {
    const offenders: string[] = []
    for (const file of FILES.filter((f) => layerOf(f.rel) === 'camera')) {
      for (const spec of importsOf(file.text)) {
        if (spec.includes('../app/')) offenders.push(`${file.rel} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('storage stays free of React', () => {
    const offenders = FILES.filter(
      (f) => layerOf(f.rel) === 'storage' && importsOf(f.text).includes('react'),
    ).map((f) => f.rel)
    expect(offenders).toEqual([])
  })
})

/**
 * The product promise, enforced mechanically.
 *
 * "Photos never leave the device" is not something a reviewer should have to
 * re-audit by reading every file each release. Application code contains no
 * network primitive at all; the service worker is the single exception and it
 * only ever touches the precached app shell.
 */
describe('local-first guarantee', () => {
  const APP_CODE = FILES.filter((f) => f.rel !== 'sw.ts')

  it('contains no network calls anywhere in application code', () => {
    const patterns: [RegExp, string][] = [
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bnew\s+WebSocket\b/, 'WebSocket'],
      [/\bnew\s+EventSource\b/, 'EventSource'],
      [/navigator\s*\.\s*sendBeacon/, 'sendBeacon'],
      [/\bimport\s*\(\s*['"]https?:/, 'remote dynamic import'],
    ]

    const offenders: string[] = []
    for (const file of APP_CODE) {
      for (const [re, label] of patterns) {
        if (re.test(file.text)) offenders.push(`${file.rel}: ${label}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('references no remote origin', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      // Documentation links inside comments are fine; anything in code is not.
      const withoutComments = file.text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '')
      const matches = withoutComments.match(/https?:\/\/[^\s'"`)]+/g) ?? []
      // The SVG namespace is a spec identifier, not a network fetch.
      const real = matches.filter((url) => !url.startsWith('http://www.w3.org/'))
      if (real.length) offenders.push(`${file.rel}: ${real.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('carries no credential-shaped strings', () => {
    // The briefing ships a live Postgres URL; it must never reach the bundle.
    const patterns = [/postgres(?:ql)?:\/\//i, /\bnpg_[A-Za-z0-9]{8,}/, /neondb_owner/i]
    const offenders: string[] = []
    for (const file of FILES) {
      for (const re of patterns) {
        if (re.test(file.text)) offenders.push(`${file.rel}: ${re.source}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
