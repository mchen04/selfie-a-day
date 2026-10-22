// Data-flow audit, part 1: what the app actually sends, receives and keeps.
//
//   node scripts/audit/requests.mjs <sim-evidence-dir> [--compare <other-sim-dir>] [--perf <lab.json> ...] [--json <out.json>]
//
// Reads the ten-day simulation evidence (day-NN/requests.json, storage.json and
// push.json; see tests/sim) and, optionally, perf harness lab.json reports
// (scripts/perf). Prints Markdown: requests and bytes per endpoint and per flow,
// device and server storage per day, cron/push totals and perf scenarios.
// With --compare the first directory is "before" and the second "after".
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Where a recorded browser request was answered. Playwright reports a request
 * for every image or script the page loads, including ones the browser's own
 * HTTP cache answers; Chromium gives those a negative body size (minus the
 * header size), which is how they are told apart from network traffic.
 */
export function served(record) {
  if (record.status === null) return 'failed'
  if (record.fromServiceWorker) return 'service worker'
  if (typeof record.responseBodyBytes === 'number' && record.responseBodyBytes < 0) return 'http cache'
  return 'network'
}

const ID = '[0-9a-z]{20}'
const ROUTES = [
  [new RegExp(`^/api/photos/${ID}/(master|thumb)$`), (m) => `/api/photos/:id/${m[1]}`],
  [new RegExp(`^/api/photos/${ID}$`), () => '/api/photos/:id'],
  [new RegExp(`^/api/albums/(selfies|album-${ID})$`), () => '/api/albums/:id'],
  [new RegExp(`^/api/push/prefs/(selfies|album-${ID})$`), () => '/api/push/prefs/:albumId'],
  [/^\/api\//, (m) => m.input],
]

/** "GET /api/sync (delta)" style key: method, route template, sync kind. */
export function endpoint(method, path) {
  const [pathname, query = ''] = path.split('?')
  if (!pathname.startsWith('/api/')) return `${method} app shell`
  for (const [pattern, name] of ROUTES) {
    const match = pattern.exec(pathname)
    if (match) {
      const route = name(match)
      return route === '/api/sync' ? `${method} /api/sync (${query.includes('since=') ? 'delta' : 'full'})` : `${method} ${route}`
    }
  }
  return `${method} ${pathname}`
}

const FLOWS = [
  ['offline and reconnect', /offline/],
  ['sign-in and sign-up', /signs up|signs in|sign back in/],
  ['reopen (cold start)', /reopens/],
  ['logout', /logs out|logout/],
  ['account isolation', /third user|stale tab/],
  ['capture and upload', /capture|retake|evening Selfies photo|timer/],
  ['second-device sync', /\bsees\b/],
  ['albums', /creates|renames|switch albums|create Gym/],
  ['timelapse', /timelapse/],
  ['trash, restore, delete', /trash|restore|deletes/],
  ['Download my photos (ZIP)', /ZIP/],
  ['reminders', /reminder|permission/],
]

export function flow(step) {
  return FLOWS.find(([, pattern]) => pattern.test(step))?.[0] ?? 'other'
}

const positive = (value) => (typeof value === 'number' && value > 0 ? value : 0)

function emptyTotals() {
  return { requests: 0, network: 0, 'http cache': 0, 'service worker': 0, failed: 0, sentBytes: 0, receivedBytes: 0 }
}

function add(totals, record) {
  const where = served(record)
  totals.requests++
  totals[where]++
  if (where !== 'network') return
  totals.sentBytes += positive(record.requestHeaderBytes) + positive(record.requestBodyBytes)
  totals.receivedBytes += positive(record.responseHeaderBytes) + positive(record.responseBodyBytes)
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export function readSimulation(dir) {
  const days = readdirSync(dir).filter((name) => /^day-\d\d$/.test(name)).sort()
  if (!days.length) throw new Error(`No day-NN folders in ${dir}`)
  const result = { dir, days: [], endpoints: {}, flows: {}, contexts: {}, crons: 0, pushMessages: 0, harness: 0 }
  for (const name of days) {
    const requests = readJson(join(dir, name, 'requests.json'))
    const storage = existsSync(join(dir, name, 'storage.json')) ? readJson(join(dir, name, 'storage.json')) : null
    const push = existsSync(join(dir, name, 'push.json')) ? readJson(join(dir, name, 'push.json')) : null
    const day = { day: requests.day, label: requests.label, totals: emptyTotals(), storage }
    for (const [context, records] of Object.entries(requests.contexts)) {
      for (const record of records) {
        const key = endpoint(record.method, record.path)
        add(day.totals, record)
        add(result.endpoints[key] ??= emptyTotals(), record)
        add(result.flows[flow(record.step)] ??= emptyTotals(), record)
        add(result.contexts[context] ??= emptyTotals(), record)
      }
    }
    result.harness += requests.harness?.length ?? 0
    result.crons += push?.crons?.length ?? 0
    result.pushMessages += push?.messages?.length ?? 0
    result.days.push(day)
  }
  return result
}

function table(headers, rows) {
  const align = headers.map((header, index) => (index === 0 ? '---' : '---:'))
  return [`| ${headers.join(' | ')} |`, `| ${align.join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

const kb = (bytes) => (bytes >= 10_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${bytes} B`)
const signed = (value) => (value > 0 ? `+${value}` : String(value))

function trafficRows(groups, order) {
  return order.map((key) => {
    const value = groups[key] ?? emptyTotals()
    return [key, value.requests, value.network, value['http cache'], value['service worker'], value.failed, kb(value.sentBytes), kb(value.receivedBytes)]
  })
}

const TRAFFIC = ['Requests recorded', 'Network', 'HTTP cache', 'Service worker', 'Failed or cancelled', 'Sent', 'Received']

function compareRows(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys.map((key) => {
    const a = before[key] ?? emptyTotals()
    const b = after[key] ?? emptyTotals()
    return [key, a.network, b.network, signed(b.network - a.network), kb(a.sentBytes + a.receivedBytes), kb(b.sentBytes + b.receivedBytes),
      signed(b.sentBytes + b.receivedBytes - a.sentBytes - a.receivedBytes)]
  }).filter((row) => row[1] || row[2])
}

function deviceRows(simulation) {
  const rows = []
  for (const day of simulation.days) {
    const devices = day.storage?.devices ?? {}
    for (const [name, device] of Object.entries(devices)) {
      const idb = device.indexedDB ?? {}
      const local = device.localStorage ?? []
      const caches = device.cacheStorage ?? []
      rows.push([`Day ${day.day} ${name}`, device.cookies?.join(', ') || '—',
        `${idb.kv?.count ?? 0} / ${kb(idb.kv?.bytes ?? 0)}`, `${idb.outbox?.count ?? 0} / ${kb(idb.outbox?.bytes ?? 0)}`,
        `${idb.ghosts?.count ?? 0} / ${kb(idb.ghosts?.bytes ?? 0)}`,
        `${local.length} / ${kb(local.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0))}`,
        caches.map((cache) => `${cache.entries} (${cache.apiEntries} /api)`).join(', ') || '—'])
    }
  }
  return rows
}

function serverRows(simulation) {
  return simulation.days.map((day) => {
    const server = day.storage?.server
    const rows = server?.d1?.rows ?? {}
    const owner = server?.d1?.perUser?.owner?.photos
    return [`Day ${day.day}`, rows.users ?? 0, rows.sessions ?? 0, rows.albums ?? 0,
      owner ? `${owner.active}/${owner.trashed}/${owner.purged}` : String(rows.photos ?? 0),
      rows.push_subscriptions ?? 0, rows.push_prefs ?? 0, rows.notification_log ?? 0, rows.auth_attempts ?? 0,
      rows.photo_uploads ?? 0, server?.r2 ? `${server.r2.objects} / ${kb(server.r2.bytes)}` : '—']
  })
}

/** Median of a lab.json metric per target and scenario, plus the requests of the first sample. */
export function readPerf(file) {
  const lab = readJson(file)
  const groups = new Map()
  for (const sample of lab.samples ?? []) {
    if (sample.status !== 'ok') continue
    const key = `${sample.target}\u0000${sample.scenario}`
    if (!groups.has(key)) groups.set(key, { target: sample.target, scenario: sample.scenario, metrics: {}, requests: sample.evidence?.network?.requests ?? [] })
    const group = groups.get(key)
    for (const [name, metric] of Object.entries(sample.metrics ?? {})) (group.metrics[name] ??= []).push(metric.value)
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  return [...groups.values()].map((group) => ({
    ...group, metrics: Object.fromEntries(Object.entries(group.metrics).map(([name, values]) => [name, median(values)])),
  }))
}

const BYTE_METRICS = ['transferBytes', 'bodyBytes', 'uploadRequestBytes', 'uploadResponseBytes', 'uploadMasterBytes', 'uploadThumbBytes']

function perfSection(file) {
  const groups = readPerf(file)
  const rows = groups.map((group) => [group.target, group.scenario, group.metrics.requestCount ?? '—',
    BYTE_METRICS.filter((name) => name in group.metrics).map((name) => `${name} ${group.metrics[name]}`).join(', ') || '—'])
  const lines = [`### Perf harness: ${file}`, '', table(['Target', 'Scenario', 'Requests (median)', 'Bytes (median)'], rows), '']
  for (const group of groups.filter((item) => item.requests.length)) {
    const paths = group.requests.map((request) => {
      const url = new URL(request.url)
      const where = request.fromSW ? 'sw' : request.cached ? 'cache' : request.transferBytes
      return `${request.method} ${url.pathname.replace(new RegExp(ID, 'g'), ':id')} (${where})`
    })
    lines.push(`- ${group.target} ${group.scenario}: ${paths.join('; ')}`)
  }
  return lines.join('\n')
}

export function report(simulation, { compare = null, perf = [] } = {}) {
  const byNetwork = (groups) => Object.keys(groups).sort((a, b) => groups[b].network - groups[a].network || a.localeCompare(b))
  const all = Object.values(simulation.contexts).reduce((sum, value) => {
    for (const key of Object.keys(sum)) sum[key] += value[key]
    return sum
  }, emptyTotals())
  const lines = [
    `# Data-flow audit: ${simulation.dir}`, '',
    `${simulation.days.length} simulated days. ${all.requests} browser requests recorded: ${all.network} over the network,`
      + ` ${all['http cache']} from the HTTP cache, ${all['service worker']} from the service worker, ${all.failed} failed or cancelled.`,
    `Harness API calls (seeding, second account): ${simulation.harness}. Cron runs: ${simulation.crons}. Push messages delivered: ${simulation.pushMessages}.`,
    'Bytes are network bytes (headers + body) as Playwright reports them; multipart upload bodies are not visible to it and count as 0.', '',
    '## Requests per endpoint', '', table(['Endpoint', ...TRAFFIC], trafficRows(simulation.endpoints, byNetwork(simulation.endpoints))), '',
    '## Requests per flow', '', table(['Flow', ...TRAFFIC], trafficRows(simulation.flows, byNetwork(simulation.flows))), '',
    '## Requests per device', '', table(['Device', ...TRAFFIC], trafficRows(simulation.contexts, byNetwork(simulation.contexts))), '',
  ]
  if (compare) {
    lines.push(`## Before → after (${simulation.dir} → ${compare.dir}), network requests and bytes`, '',
      table(['Endpoint', 'Before', 'After', 'Δ', 'Bytes before', 'Bytes after', 'Δ bytes'], compareRows(simulation.endpoints, compare.endpoints)), '',
      table(['Flow', 'Before', 'After', 'Δ', 'Bytes before', 'Bytes after', 'Δ bytes'], compareRows(simulation.flows, compare.flows)), '')
  }
  lines.push('## Device storage per day (count / bytes)', '',
    table(['Snapshot', 'Cookies', 'IndexedDB kv', 'outbox', 'ghosts', 'localStorage', 'Cache Storage entries'], deviceRows(compare ?? simulation)), '',
    '## Server storage per day (owner photos active/trashed/purged)', '',
    table(['Day', 'users', 'sessions', 'albums', 'photos', 'push_subscriptions', 'push_prefs', 'notification_log', 'auth_attempts', 'photo_uploads', 'R2 objects / bytes'],
      serverRows(compare ?? simulation)), '')
  for (const file of perf) lines.push(perfSection(file), '')
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { dirs: [], perf: [], json: null }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--compare') options.dirs[1] = argv[++index]
    else if (value === '--perf') options.perf.push(argv[++index])
    else if (value === '--json') options.json = argv[++index]
    else options.dirs[0] = value
  }
  options.dirs[0] ??= process.env.SIM_EVIDENCE_DIR
  if (!options.dirs[0]) throw new Error('Usage: node scripts/audit/requests.mjs <sim-evidence-dir> [--compare <dir>] [--perf <lab.json>] [--json <out.json>]')
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2))
  const simulation = readSimulation(resolve(options.dirs[0]))
  const compare = options.dirs[1] ? readSimulation(resolve(options.dirs[1])) : null
  process.stdout.write(`${report(simulation, { compare, perf: options.perf })}\n`)
  if (options.json) {
    const strip = (value) => value && { ...value, days: value.days.map(({ storage: _storage, ...day }) => day) }
    writeFileSync(options.json, `${JSON.stringify({ before: strip(simulation), after: strip(compare) }, null, 2)}\n`)
  }
}
