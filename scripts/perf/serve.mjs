import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { cli, envelope, fail, isMain, localURL, positiveInt, ROOT } from './common.mjs'
import { calibrate, compressed, inventory } from './assets.mjs'

export const ENCODINGS = ['br11', 'gzip9', 'identity', 'br-dynamic']
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', map: 'application/json', txt: 'text/plain; charset=utf-8' }

function accepts(header, encoding) {
  const tokens = (header ?? '').split(',').map((entry) => entry.trim().split(';'))
  const token = tokens.find(([name]) => name === encoding) ?? tokens.find(([name]) => name === '*')
  return !!token && !token.slice(1).some((part) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(part))
}

export async function staticHandler(dist, { encoding = 'br11', api = null, calibration = null } = {}) {
  if (!ENCODINGS.includes(encoding)) throw new Error('Unknown encoding')
  if (api) api = localURL(api).origin
  if (encoding === 'br-dynamic' && !calibration) throw new Error('Missing Brotli calibration')
  const graph = await inventory(resolve(dist))
  const config = JSON.parse(await readFile(resolve(ROOT, 'vercel.json'), 'utf8'))
  const rules = (config.headers ?? []).map((rule) => ({
    regex: new RegExp(`^${rule.source}$`), headers: Object.fromEntries(rule.headers.map(({ key, value }) => [key, value])),
  }))
  const encoded = new Map()
  if (['br11', 'gzip9'].includes(encoding)) {
    for (const [path, bytes] of graph.entries) if (compressible(path)) encoded.set(path, compressed(bytes, encoding))
  }
  const metadata = { dist: resolve(dist), encoding, calibration, api, configHeaders: config.headers,
    spaFallback: true, apiProxy: !!api }
  const handler = (req, res) => {
    let path
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) }
    catch { res.writeHead(400).end(); return }
    for (const { regex, headers } of rules) if (regex.test(path)) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
    if (/^\/api(?:\/|$)/.test(path)) {
      if (!api) { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"no_local_api"}'); return }
      const incoming = new URL(req.url, 'http://localhost')
      const upstream = new URL(`${incoming.pathname}${incoming.search}`, api)
      const headers = { ...req.headers, host: upstream.host }
      const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(upstream, { method: req.method, headers, timeout: 45_000 }, (response) => {
        res.writeHead(response.statusCode, response.headers)
        response.pipe(res)
        response.on('error', () => res.destroy())
      })
      proxy.on('timeout', () => proxy.destroy(new Error('Local API timed out')))
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.on('aborted', () => proxy.destroy())
      req.pipe(proxy)
      return
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
    const selected = graph.entries.has(path) ? path : '/index.html'
    const raw = graph.entries.get(selected)
    const coding = encoding.startsWith('br') ? 'br' : encoding === 'gzip9' ? 'gzip' : 'identity'
    const useCompression = coding !== 'identity' && compressible(selected) && accepts(req.headers['accept-encoding'], coding)
    const body = !useCompression ? raw : encoded.get(selected) ?? compressed(raw, encoding, calibration?.quality)
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', TYPES[selected.split('.').pop()] ?? 'application/octet-stream')
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
    res.setHeader('Vary', 'Accept-Encoding')
    if (useCompression) res.setHeader('Content-Encoding', coding)
    res.setHeader('Content-Length', body.length)
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  return { handler, metadata, sourceText: new Map([...graph.entries].filter(([path]) => path.endsWith('.js')).map(([path, bytes]) => [path, bytes.toString()])) }
}

function compressible(path) {
  return /\.(?:html|js|css|json|webmanifest|svg|map|txt)$/.test(path)
}

export async function listen(handler, port) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()) }) }
}

export async function main() {
  const { values, positionals } = cli({ port: { type: 'string' }, encoding: { type: 'string' }, api: { type: 'string' },
    'calibration-asset': { type: 'string' } })
  if (positionals.length !== 1 || !values.port || !values.encoding) throw new Error('Usage: serve.mjs <dist> --port N --encoding br11|gzip9|identity|br-dynamic [--api <loopback origin>]')
  const dist = resolve(positionals[0])
  const calibration = values.encoding === 'br-dynamic' ? await calibrate(values['calibration-asset'] ?? process.env.PERF_ORIGINAL_ASSET ?? resolve(dist, 'assets/index-C7aPkNJ7.js')) : null
  const app = await staticHandler(dist, { encoding: values.encoding, api: values.api, calibration })
  const server = await listen(app.handler, positiveInt(values.port, 'port', 65535))
  process.stdout.write(`${JSON.stringify(envelope('server', { origin: server.origin, ...app.metadata }))}\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close().catch(fail) })
}

if (isMain(import.meta)) main().catch(fail)
