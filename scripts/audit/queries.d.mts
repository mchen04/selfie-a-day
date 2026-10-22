export interface AuditedStatement {
  where: string
  fn: string
  caller: string
  method: string
  sql: string
  reads: string[]
  updates: string[]
  inserts: string[]
  deletes: string[]
  keys: string[]
  plan: string[]
  flags: string[]
}
export interface AuditedIndex { name: string; tableName: string; unique: boolean; servedBy: string[] }
export interface AuditedColumn { column: string; writtenBy: string[]; readBy: string[] }
export interface ResponseField { object: string; field: string; reads: string[]; byName: string[] }
export interface Audit { statements: AuditedStatement[]; indexes: AuditedIndex[]; columns: AuditedColumn[]; fields: ResponseField[] }

export const KEPT: Record<string, string>
export function audit(options?: { fields?: boolean }): Audit
export function report(result: Audit): string
