import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cli, envelope, fail, isMain, jsonFile, stats, USEFUL_GAIN, VERSION } from './common.mjs'

export function summarize(documents, usefulGain = USEFUL_GAIN) {
  const groups = new Map()
  for (const [source, document] of documents.entries()) {
    if (document.harnessVersion !== VERSION) throw new Error('Harness version differs')
    for (const sample of document.samples ?? []) {
      for (const [name, metric] of Object.entries(sample.metrics ?? {})) {
        if (sample.status !== 'ok') continue
        if (!Number.isFinite(metric.value) || !(metric.unit in usefulGain)) throw new Error('Invalid metric in source')
        const key = JSON.stringify([sample.scenario, name, metric.unit])
        if (!groups.has(key)) groups.set(key, new Map())
        const targets = groups.get(key)
        if (!targets.has(sample.target)) targets.set(sample.target, [])
        targets.get(sample.target).push({ value: metric.value, round: sample.round, source })
      }
    }
  }
  const tables = []
  for (const [key, targets] of groups) {
    const [scenario, metric, unit] = JSON.parse(key)
    const rows = [...targets].map(([target, values]) => ({ target, ...stats(values.map((entry) => entry.value)) }))
    const comparisons = []
    for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
      const baseline = rows[a]; const candidate = rows[b]
      const aValues = targets.get(baseline.target); const bValues = targets.get(candidate.target)
      const deltas = []
      for (const base of aValues) {
        const other = bValues.find((entry) => entry.source === base.source && entry.round === base.round)
        if (other) deltas.push(other.value - base.value)
      }
      const threshold = Math.max(baseline.spread, usefulGain[unit])
      const delta = deltas.length ? stats(deltas).median : candidate.median - baseline.median
      const failures = documents.some((document) => document.fatalError || (document.samples ?? []).some((sample) => sample.scenario === scenario
        && [baseline.target, candidate.target].includes(sample.target) && sample.status === 'error'))
      const interleaved = !failures && deltas.length === aValues.length && deltas.length === bValues.length
        && aValues.every((entry) => documents[entry.source].kind === 'lab')
      const exceedsNoise = Math.abs(delta) > threshold
      const improvement = (metric === 'performanceScore' ? delta : -delta) > threshold
      comparisons.push({ baseline: baseline.target, candidate: candidate.target, medianDelta: delta,
        deltaMethod: deltas.length ? 'median of paired round deltas' : 'difference of medians',
        pairedN: deltas.length, threshold, baselineSpread: baseline.spread, smallestUsefulGain: usefulGain[unit],
        exceedsNoise, interleaved, keep: interleaved && improvement,
        decision: failures ? 'Failed samples; rerun comparison' : !interleaved ? 'Needs interleaved A/B samples'
          : improvement ? 'Gain exceeds noise' : exceedsNoise ? 'Regression exceeds noise' : 'Within noise' })
    }
    tables.push({ scenario, metric, unit, targets: rows, comparisons })
  }
  const outcomes = documents.flatMap((document, source) => (document.samples ?? []).filter((sample) => sample.status !== 'ok')
    .map(({ target, scenario, round, status, reason }) => ({ source, target, scenario, round, status, reason })))
  return { tables, outcomes }
}

const number = (value) => Number.isInteger(value) ? String(value) : value.toFixed(2)
const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

export function markdown(result) {
  const lines = [`# Performance harness ${VERSION}`, '', 'Spread is p75 − p25. Delta is candidate − baseline. Time, bytes, and counts improve when they fall.', '']
  for (const table of result.tables) {
    lines.push(`## ${table.scenario}: ${table.metric} (${table.unit})`, '',
      '| Target | n | Median | p25–p75 | Min–max |', '| --- | ---: | ---: | ---: | ---: |')
    for (const row of table.targets) lines.push(`| ${escape(row.target)} | ${row.n} | ${number(row.median)} | ${number(row.p25)}–${number(row.p75)} | ${number(row.min)}–${number(row.max)} |`)
    if (table.comparisons.length) {
      lines.push('', '| Baseline → candidate | Median delta | Noise threshold | Paired n | Result |', '| --- | ---: | ---: | ---: | --- |')
      for (const pair of table.comparisons) lines.push(`| ${escape(pair.baseline)} → ${escape(pair.candidate)} | ${number(pair.medianDelta)} | ${number(pair.threshold)} | ${pair.pairedN} | ${pair.decision} |`)
    }
    lines.push('')
  }
  if (result.outcomes.length) {
    lines.push('## Skips and failures', '', '| Target | Scenario | Round | Status | Reason |', '| --- | --- | ---: | --- | --- |')
    for (const row of result.outcomes) lines.push(`| ${escape(row.target)} | ${escape(row.scenario)} | ${row.round} | ${row.status} | ${escape(row.reason)} |`)
  }
  return `${lines.join('\n')}\n`
}

function conditions(document) {
  return JSON.stringify({ settings: document.settings, machine: document.machine, buildMode: document.buildMode,
    encoding: document.encoding, calibration: { quality: document.calibration?.quality, sha256: document.calibration?.sha256 }, browser: document.browser,
    camera: document.camera, syntheticImage: document.syntheticImage, serverHeaders: document.targets?.[0]?.server?.configHeaders })
}

export async function main() {
  const { values, positionals } = cli({ out: { type: 'string' } })
  if (!positionals.length) throw new Error('Usage: summarize.mjs <dir...> [--out <dir>]')
  const documents = []
  const sources = []
  for (const dir of positionals) {
    let found = false
    for (const name of ['lab.json', 'lighthouse.json']) {
      const path = resolve(dir, name)
      try { documents.push(JSON.parse(await readFile(path, 'utf8'))); sources.push(path); found = true }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!found) throw new Error(`No lab.json or lighthouse.json in ${dir}`)
  }
  const labs = documents.filter((document) => document.kind === 'lab')
  if (new Set(labs.map(conditions)).size > 1) throw new Error('Measurement conditions differ; rerun under identical conditions')
  const identities = new Map()
  for (const doc of labs) for (const target of doc.targets) {
    if (identities.has(target.name) && identities.get(target.name) !== target.build.sha256) throw new Error(`Target ${target.name} names different builds`)
    identities.set(target.name, target.build.sha256)
  }
  const result = envelope('summary', { sources, usefulGain: USEFUL_GAIN, ...summarize(documents) })
  const out = resolve(values.out ?? positionals[0])
  await jsonFile(resolve(out, 'summary.json'), result)
  await writeFile(resolve(out, 'summary.md'), markdown(result))
  process.stdout.write(`${resolve(out, 'summary.md')}\n`)
}

if (isMain(import.meta)) main().catch(fail)
