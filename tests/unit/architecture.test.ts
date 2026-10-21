import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { credentialFiles } from '../support/repository.ts'

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

describe('cloud boundaries', () => {
  it('keeps network calls inside src/api', () => {
    const patterns = [/\bfetch\s*\(|\[\s*['"]fetch['"]\s*\]\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/, /\bnew\s+EventSource\b/, /navigator\s*\.\s*sendBeacon/]
    expect(FILES.filter((file) => !file.rel.startsWith('api/') && patterns.some((pattern) => pattern.test(file.text))).map((file) => file.rel)).toEqual([])
  })
  it('never imports Worker code into the frontend', () => {
    expect(FILES.filter((file) => importsOf(file.text).some((spec) => /(?:^|\/)worker\//.test(spec))).map((file) => file.rel)).toEqual([])
  })
  it('excludes API routes from the app shell', () => {
    const sw = FILES.find((file) => file.rel === 'sw.ts')!.text
    expect(sw).toContain('denylist: [/^\\/api(?:\\/|$)/]')
    expect(sw).not.toContain('registerRoute(/')
  })
  it('contains no credential-shaped strings in repository text, including Worker code', () => {
    const root = resolve(SRC, '..')
    expect(credentialFiles(root)).toEqual([])
  })
})
