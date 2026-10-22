// Data-flow audit, part 2: every D1 statement the Worker can run.
//
//   node scripts/audit/queries.mjs [--json <out.json>]
//
// Builds the schema from worker/migrations in an in-memory SQLite database and
// lets SQLite itself say what each statement in worker/src (and each trigger)
// reads and writes: the authorizer reports every table/column touched, and
// EXPLAIN QUERY PLAN reports the index that serves it. Prints Markdown: one row
// per statement, then every index with the statements it serves, then the
// API response fields and whether the client reads them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '../..')
const WORKER = join(ROOT, 'worker/src')
const MIGRATIONS = join(ROOT, 'worker/migrations')

/** Which requests reach each function that runs SQL. A new function must be added here. */
const CALLERS = {
  authenticate: 'every request with a session cookie',
  createSession: 'POST /api/auth/signup, /login',
  signup: 'POST /api/auth/signup',
  incrementAttempt: 'POST /api/auth/signup, /login',
  login: 'POST /api/auth/login',
  refund: 'POST /api/auth/login',
  handleAuth: 'POST /api/auth/logout',
  purgeExpiredAuth: 'cron',
  sync: 'GET /api/sync',
  putAlbum: 'PUT /api/albums/:id',
  uploadedPhoto: 'PUT /api/photos/:id',
  uploadPhoto: 'PUT /api/photos/:id',
  ownsPhoto: 'GET /api/photos/:id/master|thumb, PATCH /api/photos/:id',
  patchPhoto: 'PATCH /api/photos/:id',
  purgeRows: 'DELETE /api/photos/:id, POST /api/trash/empty, cron',
  deletePhoto: 'DELETE /api/photos/:id',
  emptyTrash: 'POST /api/trash/empty',
  purgeExpiredTrash: 'cron',
  handlePush: '/api/push/*',
  runPushScheduler: 'cron',
}
/** Functions that run on requests that only read: a write there is a per-request write. */
const READ_PATHS = new Set(['authenticate', 'sync', 'ownsPhoto'])

/**
 * Flags that were checked and kept, with the reason. Anything flagged and not
 * listed here is a finding (tests/unit/audit.test.ts fails on it).
 */
export const KEPT = {
  'write on a read request: authenticate': 'session renewal; runs only when under 45 of 90 days remain',
  'write on a read request: sync': 'default album; runs only on a full sync (no cursor) and inserts once per account',
  'never read: albums.name_key': 'enforces case-insensitive album names (albums_active_name_key)',
  'never read: albums.updated_at': 'its update fires albums_update_revision, which moves the sync cursor',
  'never read: photos.updated_at': 'its update fires photos_update_revision, which moves the sync cursor',
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])
}

/** String constants such as PHOTO_COLUMNS that SQL templates interpolate. */
function constantsIn(sources) {
  const values = {}
  for (const source of sources) {
    for (const match of source.matchAll(/export const (\w+) = '([^']*)'/g)) values[match[1]] = match[2]
  }
  return values
}

/** Read a '…' or `…` literal starting at `start`; `${name}` becomes the constant, or `?`. */
function literalAt(source, start, known) {
  const quote = source[start]
  if (quote !== "'" && quote !== '`') return null
  let text = ''
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') { text += source[++index]; continue }
    if (char === quote) return { text, end: index + 1 }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      let depth = 1
      let inner = ''
      index += 2
      for (; depth; index++) {
        if (source[index] === '{') depth++
        if (source[index] === '}') depth--
        if (depth) inner += source[index]
      }
      index--
      text += known[inner.trim()] ?? '?'
      continue
    }
    text += char
  }
  return null
}

/** `)` `.bind(…)` `.first|.all|.run` after a prepare() literal; inside a batch otherwise. */
function methodAfter(source, end) {
  let index = end
  const skip = () => { while (/\s/.test(source[index] ?? '')) index++ }
  const balanced = () => {
    let depth = 0
    do {
      if (source[index] === '(') depth++
      if (source[index] === ')') depth--
      index++
    } while (depth && index < source.length)
  }
  skip()
  if (source[index] !== ')') return 'batch'
  index++
  skip()
  if (source.startsWith('.bind(', index)) { index += 5; balanced(); skip() }
  const method = /^\.(first|all|run)\b/.exec(source.slice(index))
  return method ? method[1] : 'batch'
}

function enclosingFunction(source, index) {
  const before = source.slice(0, index)
  const names = [...before.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\([^()]*\)\s*=>)/g)]
  const last = names.at(-1)
  return last ? (last[1] ?? last[2]) : '?'
}

export function statements() {
  const paths = files(WORKER)
  const sources = Object.fromEntries(paths.map((path) => [path, readFileSync(path, 'utf8')]))
  const known = constantsIn(Object.values(sources))
  const found = []
  for (const [path, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/\.prepare\(\s*/g)) {
      const literal = literalAt(source, match.index + match[0].length, known)
      if (!literal) continue
      const line = source.slice(0, match.index).split('\n').length
      const fn = enclosingFunction(source, match.index)
      found.push({ where: `${relative(ROOT, path)}:${line}`, fn, method: methodAfter(source, literal.end),
        sql: literal.text.replace(/\s+/g, ' ').trim() })
    }
  }
  return found
}

function migrationSql() {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => readFileSync(join(MIGRATIONS, name), 'utf8')).join('\n')
}

export function triggers(sql = migrationSql()) {
  const found = []
  for (const match of sql.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?BEGIN([\s\S]*?)^END;/gm)) {
    for (const body of match[2].split(';').map((part) => part.trim()).filter(Boolean)) {
      // RAISE() only parses inside a trigger program; its arguments touch no table.
      const statement = body.replace(/NEW\.\w+/g, '?').replace(/RAISE\([^)]*\)/g, 'NULL').replace(/\s+/g, ' ')
      found.push({ where: `trigger ${match[1]}`, fn: match[1], method: 'trigger', sql: statement })
    }
  }
  return found
}

const kept = (flag, subject) => (KEPT[`${flag}: ${subject}`] ? `${flag} (kept: ${KEPT[`${flag}: ${subject}`]})` : flag)

const ACTIONS = { [constants.SQLITE_READ]: 'read', [constants.SQLITE_UPDATE]: 'update', [constants.SQLITE_INSERT]: 'insert', [constants.SQLITE_DELETE]: 'delete' }

/** What SQLite reports for one statement: columns read, columns updated, tables inserted into or deleted from, and the plan. */
function analyse(db, statement) {
  const touched = { read: new Set(), update: new Set(), insert: new Set(), delete: new Set() }
  db.setAuthorizer((action, first, second, _database, trigger) => {
    const kind = ACTIONS[action]
    // Trigger bodies are analysed as their own statements.
    if (kind && !trigger && !first?.startsWith('sqlite_')) touched[kind].add(kind === 'read' || kind === 'update' ? `${first}.${second}` : first)
    return constants.SQLITE_OK
  })
  try { db.prepare(statement.sql) }
  finally { db.setAuthorizer(null) }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all().map((row) => row.detail)
  const sql = statement.sql
  const write = touched.update.size || touched.insert.size || touched.delete.size
  const flags = []
  if (/select\s+\*/i.test(sql)) flags.push('SELECT *')
  const scans = plan.filter((detail) => /^SCAN (?!CONSTANT ROW)/.test(detail) && !/USING (COVERING )?INDEX/.test(detail))
  if (scans.length) flags.push(`full scan: ${scans.join('; ')}`)
  const rows = /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
  if (rows && statement.method !== 'first' && !/\blimit\b/i.test(sql) && !/USING (INTEGER )?PRIMARY KEY|sqlite_autoindex/.test(plan.join(' '))) {
    flags.push('rows grow with data')
  }
  if (write && READ_PATHS.has(statement.fn)) flags.push(kept('write on a read request', statement.fn))
  return {
    ...statement,
    caller: CALLERS[statement.fn] ?? (statement.method === 'trigger' ? 'trigger' : 'UNMAPPED'),
    reads: [...touched.read].sort(), updates: [...touched.update].sort(), inserts: [...touched.insert], deletes: [...touched.delete],
    keys: [...new Set([...sql.matchAll(/\bWHERE\b([\s\S]*?)(?=\bORDER BY\b|\bLIMIT\b|\bRETURNING\b|\bGROUP BY\b|\)\s*$|$)/gi)]
      .flatMap((match) => [...match[1].matchAll(/(?:(\w+)\.)?([a-z_]+)\s*(?:=|<|>|<=|>=|<>|\bIN\b|\bIS\b|\bLIKE\b)/gi)].map((term) => term[2])))]
      .filter((name) => !/^(and|or|not|null|case|when|then|else|end|exists|select)$/i.test(name)),
    plan, flags,
  }
}

export function audit({ fields = true } = {}) {
  const db = new DatabaseSync(':memory:')
  const sql = migrationSql()
  db.exec(sql)
  const results = [...statements(), ...triggers(sql)].map((statement) => analyse(db, statement))
  const indexes = db.prepare(`SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name`).all()
    .map((index) => {
      const servedBy = results.filter((result) => result.plan.some((detail) => new RegExp(`INDEX ${index.name}\\b`).test(detail)))
      const unique = index.sql === null || /CREATE UNIQUE INDEX/i.test(index.sql)
      return { ...index, unique, servedBy: servedBy.map((result) => result.where) }
    })
  const columns = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .flatMap(({ name: table }) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(({ name }) => {
      const column = `${table}.${name}`
      const inserted = (item) => item.inserts.includes(table)
        && new RegExp(`INSERT (?:OR \\w+ )?INTO ${table}\\s*\\(([^)]*)\\)`, 'i').exec(item.sql)?.[1].split(',').map((part) => part.trim()).includes(name)
      return {
        column,
        writtenBy: results.filter((item) => item.updates.includes(column) || inserted(item)).map((item) => item.where),
        readBy: results.filter((item) => item.reads.includes(column)).map((item) => item.where),
      }
    }))
  db.close()
  return { statements: results, indexes, columns, fields: fields ? responseFields() : [] }
}

/**
 * Fields of the API objects the client keeps (albumDto/photoDto/prefDto and the
 * sync envelope) against the property reads TypeScript finds in src/, outside
 * the API module that only forwards them.
 */
export function responseFields() {
  const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, 'tsconfig.app.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  const versions = new Map(config.fileNames.map((name) => [name, '1']))
  const service = ts.createLanguageService({
    getCompilationSettings: () => config.options, getScriptFileNames: () => config.fileNames,
    getScriptVersion: (name) => versions.get(name) ?? '1', getCurrentDirectory: () => ROOT, getDefaultLibFileName: ts.getDefaultLibFilePath,
    getScriptSnapshot: (name) => (ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name)) : undefined),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  })
  const program = service.getProgram()
  const targets = [['src/core/types.ts', 'PhotoMeta', 'photo'], ['src/core/types.ts', 'Album', 'album'],
    ['src/api/client.ts', 'SyncResponse', 'sync'], ['src/api/client.ts', 'PushPreference', 'pref']]
  const rows = []
  for (const [file, name, object] of targets) {
    const source = program.getSourceFile(join(ROOT, file))
    const declaration = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === name)
    for (const member of declaration.members) {
      const position = member.name.getStart(source)
      const references = (service.findReferences(source.fileName, position) ?? []).flatMap((entry) => entry.references)
      const reads = references.filter((reference) => {
        if (reference.isDefinition || reference.isWriteAccess) return false
        const path = relative(ROOT, reference.fileName)
        if (!path.startsWith('src/') || path === 'src/api/client.ts') return false
        const node = findNode(program.getSourceFile(reference.fileName), reference.textSpan.start)
        return node && !(ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent))
      }).map((reference) => {
        const file = program.getSourceFile(reference.fileName)
        return `${relative(ROOT, reference.fileName)}:${file.getLineAndCharacterOfPosition(reference.textSpan.start).line + 1}`
      })
      const field = member.name.getText(source)
      rows.push({ object, field, reads, byName: reads.length ? [] : readsByName(field) })
    }
  }
  return rows
}

/** Structural reads TypeScript cannot tie to the interface (another type with the same field). */
function readsByName(field) {
  const hits = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(entry.name) && !['src/api/client.ts', 'src/core/types.ts'].includes(relative(ROOT, path))) {
        readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
          if (new RegExp(`\\.${field}\\b`).test(line)) hits.push(`${relative(ROOT, path)}:${index + 1}`)
        })
      }
    }
  }
  visit(join(ROOT, 'src'))
  return hits
}

function findNode(source, position) {
  let found
  const visit = (node) => {
    if (position >= node.getStart(source) && position < node.getEnd()) {
      found = node
      ts.forEachChild(node, visit)
    }
  }
  visit(source)
  return found
}

const cell = (values) => (values.length ? values.join(', ') : '—')

export function report({ statements: results, indexes, columns, fields }) {
  const lines = ['# D1 statements', '',
    `${results.filter((item) => item.method !== 'trigger').length} statements in worker/src and ${results.filter((item) => item.method === 'trigger').length} trigger statements.`, '',
    '| Where | Function → requests | Call | Reads | Writes | WHERE | Plan | Flags |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const item of results) {
    const writes = [...item.inserts.map((table) => `insert ${table}`), ...item.updates, ...item.deletes.map((table) => `delete ${table}`)]
    lines.push(`| ${item.where} | ${item.fn} → ${item.caller} | ${item.method} | ${cell(item.reads)} | ${cell(writes)} | ${cell(item.keys)} | ${cell(item.plan)} | ${cell(item.flags)} |`)
  }
  lines.push('', '# Indexes', '', '| Index | Table | Unique | Served statements |', '| --- | --- | --- | --- |')
  for (const index of indexes) {
    const served = index.servedBy.length ? index.servedBy.join(', ') : index.unique ? 'none (enforces uniqueness)' : '**none: serves no statement**'
    lines.push(`| ${index.name} | ${index.tableName} | ${index.unique ? 'yes' : 'no'} | ${served} |`)
  }
  lines.push('', '# Columns', '', '| Column | Written by | Read by |', '| --- | --- | --- |')
  for (const column of columns) {
    const unread = KEPT[`never read: ${column.column}`] ? `never read (kept: ${KEPT[`never read: ${column.column}`]})` : '**never read**'
    lines.push(`| ${column.column} | ${column.writtenBy.length} | ${column.readBy.length ? `${column.readBy.length}: ${column.readBy.slice(0, 3).join(', ')}${column.readBy.length > 3 ? ', …' : ''}` : unread} |`)
  }
  lines.push('', '# Response fields the client keeps', '', '| Object | Field | Client reads (src/, outside src/api/client.ts) |', '| --- | --- | --- |')
  const list = (values) => `${values.length}: ${values.slice(0, 3).join(', ')}${values.length > 3 ? ', …' : ''}`
  for (const field of fields) {
    const reads = field.reads.length ? list(field.reads) : field.byName.length ? `by name only, ${list(field.byName)}` : '**none**'
    lines.push(`| ${field.object} | ${field.field} | ${reads} |`)
  }
  const unmapped = results.filter((item) => item.caller === 'UNMAPPED')
  if (unmapped.length) lines.push('', `Unmapped functions (add them to CALLERS): ${unmapped.map((item) => `${item.fn} (${item.where})`).join(', ')}`)
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = audit()
  process.stdout.write(`${report(result)}\n`)
  const json = process.argv.indexOf('--json')
  if (json > 0) writeFileSync(process.argv[json + 1], `${JSON.stringify(result, null, 2)}\n`)
}
