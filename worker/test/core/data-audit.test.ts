import { describe, expect, it } from 'vitest'
import { audit, KEPT } from '../../../scripts/audit/queries.mjs'

// Guards the Stage 3 data-flow removals: SQLite and the TypeScript language
// service, not a hand-kept list, decide what is read. A new finding either goes
// away or gets a reason in KEPT (scripts/audit/queries.mjs).
describe('data-flow audit', () => {
  const result = audit()
  const kept = (flag: string) => flag.includes('(kept: ')

  it('maps every statement to its requests and flags nothing unexplained', () => {
    expect(result.statements.filter((item) => item.caller === 'UNMAPPED').map((item) => item.where)).toEqual([])
    // A statement after an inner arrow function belongs to the outer function.
    expect(result.statements.find((item) => item.sql.includes('password_hash FROM users'))?.fn).toBe('login')
    expect(result.statements.flatMap((item) => item.flags.filter((flag) => !kept(flag) && flag !== 'rows grow with data').map((flag) => `${item.where}: ${flag}`))).toEqual([])
  })

  it('keeps only indexes that serve a statement or enforce uniqueness', () => {
    expect(result.indexes.filter((index) => !index.unique && !index.servedBy.length).map((index) => index.name)).toEqual([])
  })

  it('stores only columns something reads, or that have a recorded reason', () => {
    expect(result.columns.filter((column) => !column.readBy.length && !KEPT[`never read: ${column.column}`]).map((column) => column.column)).toEqual([])
  })

  it('sends only response fields the client reads', () => {
    expect(result.fields.filter((field) => !field.reads.length && !field.byName.length).map((field) => `${field.object}.${field.field}`)).toEqual([])
  })
})
