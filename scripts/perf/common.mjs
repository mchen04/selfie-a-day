import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { hostname, platform, release, arch, cpus, totalmem } from 'node:os'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const VERSION = 'v1'
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SCENARIOS = ['cold', 'cold-signed-in', 'warm', 'offline-warm', 'capture', 'timeline-60', 'sync-60', 'sync-365']
export const SETTINGS = Object.freeze({
  viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
  network: { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 },
  cpuSlowdown: 4, timeoutMs: 45_000, seedStart: '2025-01-01T12:00:00Z',
})
export const USEFUL_GAIN = Object.freeze({ ms: 50, bytes: 1024, count: 1, score: 1, ratio: 0.01 })

export function cli(options, args = process.argv.slice(2)) {
  return parseArgs({ args, options, allowPositionals: true, strict: true })
}

export function positiveInt(value, name, max = 1000) {
  if (!/^\d+$/.test(String(value)) || +value < 1 || +value > max) throw new Error(`${name} must be 1–${max}`)
  return +value
}

export function localURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('Only loopback HTTP(S) URLs are allowed')
  return url
}

export function targetSpec(value) {
  const match = /^([a-zA-Z0-9_-]+)=(.+?)(?:,(https?:\/\/.+))?$/.exec(value)
  if (!match) throw new Error('Target syntax: name=<dist>[,http://127.0.0.1:8787]')
  const api = match[3] ? localURL(match[3]) : null
  if (api && (api.pathname !== '/' || api.search || api.hash)) throw new Error('API must be an origin')
  return { name: match[1], dist: resolve(match[2]), api: api?.origin ?? null }
}

export function envelope(kind, data) {
  return { harnessVersion: VERSION, kind, createdAt: new Date().toISOString(), machine: machine(), ...data }
}

export async function jsonFile(path, data) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

export async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${path}`)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

export async function buildIdentity(dist) {
  const hash = createHash('sha256')
  const files = []
  for (const path of await filesUnder(dist)) {
    const bytes = await readFile(path)
    const name = relative(dist, path).split('\\').join('/')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    hash.update(`${name}\0${sha256}\n`)
    files.push({ path: name, bytes: bytes.length, sha256 })
  }
  await readFile(resolve(dist, 'index.html'))
  return { sha256: hash.digest('hex'), files }
}

export function machine() {
  return { hostname: hostname(), platform: platform(), release: release(), arch: arch(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version }
}

export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = (sorted.length - 1) * q
  const low = Math.floor(index)
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low)
}

export function stats(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error('Stats require finite samples')
  const p25 = quantile(values, 0.25)
  const p75 = quantile(values, 0.75)
  return { n: values.length, median: quantile(values, 0.5), p25, p75, spread: p75 - p25,
    min: Math.min(...values), max: Math.max(...values) }
}

export function validateSample(sample) {
  if (!sample || !SCENARIOS.includes(sample.scenario) || !sample.target || !Number.isInteger(sample.round) || sample.round < 1)
    throw new Error('Invalid sample identity')
  if (!['ok', 'skipped', 'error'].includes(sample.status)) throw new Error('Invalid sample status')
  if (sample.status !== 'ok' && !sample.reason) throw new Error('Missing sample reason')
  if (!sample.metrics || typeof sample.metrics !== 'object') throw new Error('Missing metrics')
  if (sample.status === 'ok' && !Object.keys(sample.metrics).length) throw new Error('Empty successful sample')
  for (const [name, metric] of Object.entries(sample.metrics)) {
    if (!metric || !Number.isFinite(metric.value) || metric.value < 0 || !(metric.unit in USEFUL_GAIN))
      throw new Error(`Invalid metric ${name}: value=${String(metric?.value)}, unit=${String(metric?.unit)}`)
  }
  return sample
}

export function validateLabOutput(output) {
  if (output.harnessVersion !== VERSION || output.kind !== 'lab' || !Number.isFinite(Date.parse(output.createdAt)))
    throw new Error('Invalid report envelope')
  if (!output.machine?.hostname || !output.buildMode || !output.settings?.network || !Array.isArray(output.samples))
    throw new Error('Missing report conditions')
  positiveInt(output.runs, 'report runs')
  if (!Array.isArray(output.targets) || !output.targets.length) throw new Error('Missing report targets')
  const names = new Set()
  for (const target of output.targets) {
    if (!target.name || names.has(target.name) || !/^[a-f0-9]{64}$/.test(target.build?.sha256) || !Array.isArray(target.build.files))
      throw new Error('Invalid report target')
    names.add(target.name)
  }
  const identities = new Set()
  for (const sample of output.samples) {
    validateSample(sample)
    const key = JSON.stringify([sample.target, sample.scenario, sample.round])
    if (!names.has(sample.target) || sample.round > output.runs || identities.has(key)) throw new Error('Invalid report sample')
    identities.add(key)
  }
  return output
}

export function isMain(meta) {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === meta.url
}

export function fail(error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
