import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { cli, envelope, fail, isMain, jsonFile, buildIdentity } from './common.mjs'
import { compressed, inventory } from './assets.mjs'

export function wireAsset(url, encoding) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { 'Accept-Encoding': encoding }, timeout: 30_000,
    }, (response) => {
      let bytes = 0
      response.on('data', (chunk) => { bytes += chunk.length })
      response.on('error', reject)
      response.on('end', () => resolve({ requestedEncoding: encoding, status: response.statusCode, bodyBytes: bytes,
        contentEncoding: response.headers['content-encoding'] ?? 'identity',
        contentLength: response.headers['content-length'] ?? null, vary: response.headers.vary ?? null }))
    })
    request.on('timeout', () => request.destroy(new Error('Served asset timed out')))
    request.on('error', reject)
    request.end()
  })
}

export async function main() {
  const { values, positionals } = cli({ json: { type: 'string' }, served: { type: 'string' } })
  if (positionals.length !== 1) throw new Error('Usage: sizes.mjs <dist> [--json out] [--served <origin>]')
  const dist = resolve(positionals[0])
  const graph = await inventory(dist)
  const origin = values.served ? new URL(values.served) : null
  if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash)) throw new Error('--served must be an HTTP(S) origin')
  const files = []
  for (const [path, bytes] of graph.entries) {
    const file = { path, raw: bytes.length, gzip9: compressed(bytes, 'gzip9').length, br11: compressed(bytes, 'br11').length,
      initial: graph.initial.has(path), lazy: graph.lazy.has(path), precache: graph.precache.has(path) }
    if (origin && file.initial) {
      file.served = []
      for (const encoding of ['br', 'gzip']) file.served.push(await wireAsset(new URL(path, origin), encoding))
    }
    files.push(file)
  }
  const totals = {}
  for (const group of ['all', 'initial', 'lazy', 'precache']) {
    const selected = files.filter((file) => group === 'all' || file[group])
    totals[group] = { files: selected.length, ...Object.fromEntries(['raw', 'gzip9', 'br11']
      .map((key) => [key, selected.reduce((sum, file) => sum + file[key], 0)])) }
  }
  const result = envelope('sizes', { dist, build: await buildIdentity(dist), files, totals,
    externalReferences: graph.external, missingReferences: graph.missing, missingPrecache: graph.missingPrecache,
    servedOrigin: origin?.origin ?? null })
  if (values.json) await jsonFile(values.json, result)
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (graph.missing.length || graph.missingPrecache.length || files.some((file) => file.served?.some((entry) => entry.status !== 200)))
    process.exitCode = 1
}

if (isMain(import.meta)) main().catch(fail)
