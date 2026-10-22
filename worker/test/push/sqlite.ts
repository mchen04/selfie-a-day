import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result, D1DatabaseSession } from '@cloudflare/workers-types'

class Statement implements D1PreparedStatement {
  constructor(private db: DatabaseSync, private query: string, private values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.db, this.query, values.map(value => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value
      throw new Error('Unsupported test binding')
    }))
  }

  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.values)
    return Promise.resolve((row ? column ? row[column] : { ...row } : null) as T | null)
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.db.prepare(this.query).run(...this.values)
    return Promise.resolve(this.result([], Number(result.changes), Number(result.lastInsertRowid)))
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.query).all(...this.values).map(row => ({ ...row })) as T[]
    return Promise.resolve(this.result(rows))
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.db.prepare(this.query)
    const rows = statement.all(...this.values).map(row => Object.values(row)) as T[]
    return Promise.resolve(options?.columnNames ? [statement.columns().map(column => column.name), ...rows] : rows)
  }

  private result<T>(results: T[], changes = 0, lastId = 0): D1Result<T> {
    return {
      success: true, results,
      meta: { changes, last_row_id: lastId, changed_db: changes > 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: changes },
    }
  }
}

export class SqliteDatabase implements D1Database {
  private db = new DatabaseSync(':memory:')
  private chain: Promise<unknown> = Promise.resolve()

  prepare(query: string): D1PreparedStatement {
    return new Statement(this.db, query)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const task = this.chain.then(() => this.transaction<T>(statements))
    this.chain = task.catch(() => undefined)
    return task
  }

  private async transaction<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN')
    try {
      const results: D1Result<T>[] = []
      for (const statement of statements) results.push(await statement.run<T>())
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  exec(query: string): Promise<{ count: number; duration: number }> {
    this.db.exec(query)
    return Promise.resolve({ count: 1, duration: 0 })
  }

  withSession(): D1DatabaseSession {
    return { prepare: query => this.prepare(query), batch: statements => this.batch(statements), getBookmark: () => null }
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('No test database dump')
  }

  close() {
    this.db.close()
  }
}
