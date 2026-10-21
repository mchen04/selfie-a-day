import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cli, envelope, fail, isMain, jsonFile, localURL, machine, positiveInt, stats } from './common.mjs'

function command(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`Lighthouse exited ${code}: ${stderr}`))
    })
  })
}

export async function main() {
  const { values, positionals } = cli({ url: { type: 'string' }, runs: { type: 'string', default: '5' }, out: { type: 'string' },
    name: { type: 'string', default: 'served' } })
  if (positionals.length || !values.url || !values.out) throw new Error('Usage: lighthouse.mjs --url <loopback URL> --runs 5 --out <dir>')
  const url = localURL(values.url).href
  const runs = positiveInt(values.runs, 'runs')
  if (!process.env.LIGHTHOUSE_BIN) throw new Error('LIGHTHOUSE_BIN must point to an installed Lighthouse binary')
  const { chromium } = await import('@playwright/test')
  const chrome = process.env.CHROME_PATH ?? chromium.executablePath()
  await access(chrome)
  const out = resolve(values.out)
  await mkdir(out, { recursive: true })
  const path = resolve(out, 'lighthouse.json')
  try { await access(path); throw new Error('Output already exists; choose a new directory') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const env = { ...process.env, CHROME_PATH: chrome }
  const version = await command(process.env.LIGHTHOUSE_BIN, ['--version'], env)
  const result = envelope('lighthouse', { url, machine: machine(), chromePath: chrome, lighthouseVersion: version,
    preset: 'default mobile', throttling: 'Lighthouse default mobile simulated (separate from lab CDP settings)', runs, samples: [] })
  await jsonFile(path, result)
  for (let round = 1; round <= runs; round++) {
    const runPath = resolve(out, `lighthouse-run-${round}.json`)
    try {
      await command(process.env.LIGHTHOUSE_BIN, [url, '--only-categories=performance', '--form-factor=mobile', '--throttling-method=simulate',
        '--output=json', `--output-path=${runPath}`, '--quiet',
        '--chrome-flags=--headless=new --disable-dev-shm-usage --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1;[::1]'], env)
      const report = JSON.parse(await readFile(runPath, 'utf8'))
      report.harnessVersion = result.harnessVersion
      await jsonFile(runPath, report)
      if (report.runtimeError) throw new Error(report.runtimeError.message)
      const metrics = {}
      const performance = report.categories?.performance?.score
      if (!Number.isFinite(performance)) throw new Error('Lighthouse returned no performance score')
      metrics.performanceScore = { value: performance * 100, unit: 'score' }
      for (const [name, id, unit] of [['fcpMs', 'first-contentful-paint', 'ms'], ['lcpMs', 'largest-contentful-paint', 'ms'],
        ['blockingMs', 'total-blocking-time', 'ms'], ['cls', 'cumulative-layout-shift', 'ratio'], ['speedIndexMs', 'speed-index', 'ms'],
        ['transferBytes', 'total-byte-weight', 'bytes']]) {
        const value = report.audits[id]?.numericValue
        if (!Number.isFinite(value)) throw new Error(`Missing Lighthouse audit: ${id}`)
        metrics[name] = { value, unit }
      }
      result.samples.push({ target: values.name, scenario: 'lighthouse', round, status: 'ok', metrics,
        evidence: { report: runPath, lighthouseVersion: report.lighthouseVersion, userAgent: report.userAgent, configSettings: report.configSettings } })
    } catch (error) {
      result.samples.push({ target: values.name, scenario: 'lighthouse', round, status: 'error', reason: error.message, metrics: {} })
      process.exitCode = 1
    }
    const good = result.samples.filter((sample) => sample.status === 'ok')
    result.medians = Object.fromEntries(Object.keys(good[0]?.metrics ?? {}).map((key) => [key,
      { ...stats(good.map((sample) => sample.metrics[key].value)), unit: good[0].metrics[key].unit }]))
    await jsonFile(path, result)
  }
}

if (isMain(import.meta)) main().catch(fail)
