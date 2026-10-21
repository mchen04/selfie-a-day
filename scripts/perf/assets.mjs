import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { filesUnder } from './common.mjs'

export function compressed(bytes, encoding, quality = 11) {
  if (encoding === 'identity') return bytes
  if (encoding === 'gzip9') return gzipSync(bytes, { level: 9 })
  return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
}

export function references(source, type) {
  if (type === 'html') return [...source.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1])
  if (type === 'css') return [...source.matchAll(/(?:url\(\s*|@import\s*)["']?([^"'\s)]+)["']?\s*\)?/g)].map((m) => m[1])
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*)(["'])([^"']+)\1/g)].map((m) => m[2])
}

export async function inventory(dist) {
  const entries = new Map()
  for (const path of await filesUnder(dist)) entries.set(`/${relative(dist, path).split('\\').join('/')}`, await readFile(path))
  if (!entries.has('/index.html')) throw new Error('dist/index.html is required')
  const initial = new Set()
  const external = new Set()
  const missing = new Set()
  function visit(path) {
    if (initial.has(path)) return
    const bytes = entries.get(path)
    if (!bytes) { missing.add(path); return }
    initial.add(path)
    const type = path.endsWith('.html') ? 'html' : path.endsWith('.css') ? 'css' : path.endsWith('.js') ? 'js' : null
    for (const ref of type ? references(bytes.toString(), type) : []) {
      const url = new URL(ref, `http://perf.local${path}`)
      if (url.origin === 'http://perf.local') visit(decodeURIComponent(url.pathname))
      else if (!['data:', 'blob:'].includes(url.protocol)) external.add(url.href)
    }
  }
  visit('/index.html')
  const precache = new Set()
  for (const [path, bytes] of entries) {
    if (!/(?:^|\/)sw\.js$|service-worker.*\.js$/.test(path)) continue
    for (const object of bytes.toString().matchAll(/\{[^{}]*\}/g)) {
      if (!/(?:["']?revision["']?)\s*:/.test(object[0])) continue
      const match = /(?:["']?url["']?)\s*:\s*["']([^"']+)["']/.exec(object[0])
      if (!match) continue
      const url = new URL(match[1], `http://perf.local${path}`)
      if (url.origin === 'http://perf.local') precache.add(decodeURIComponent(url.pathname))
    }
  }
  const lazy = new Set([...entries.keys()].filter((path) => /\.(?:js|css)$/.test(path) && !initial.has(path)
    && !/(?:^|\/)sw\.js$|workbox-|service-worker/.test(path)))
  return { entries, initial, lazy, precache, external: [...external], missing: [...missing],
    missingPrecache: [...precache].filter((path) => !entries.has(path)) }
}

export async function calibrate(asset) {
  if (!asset) throw new Error('br-dynamic requires --calibration-asset or PERF_ORIGINAL_ASSET (original index-C7aPkNJ7.js)')
  const bytes = await readFile(resolve(asset))
  if (bytes.length !== 286778) throw new Error('Calibration asset must be the original 286,778-byte main JS')
  const levels = Array.from({ length: 12 }, (_, quality) => ({ quality, bytes: compressed(bytes, 'br-dynamic', quality).length }))
  const best = [...levels].sort((a, b) => Math.abs(a.bytes - 92421) - Math.abs(b.bytes - 92421))[0]
  const relativeError = Math.abs(best.bytes - 92421) / 92421
  if (relativeError > 0.02) throw new Error(`No Brotli quality is within 2% of 92,421 bytes (best ${best.bytes})`)
  return { asset: resolve(asset), sha256: createHash('sha256').update(bytes).digest('hex'), rawBytes: bytes.length, liveBytes: 92421, quality: best.quality,
    measuredBytes: best.bytes, relativeError, levels }
}
