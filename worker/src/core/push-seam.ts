import type { Env } from './env'

export function handlePush(_request: Request, _env: Env, _context: { userId: string; url: URL }): Promise<Response | null> {
  return Promise.resolve(null)
}

export function runPushScheduler(_env: Env, _now: number): Promise<{ sent: number; skipped: number; removed: number }> {
  return Promise.resolve({ sent: 0, skipped: 0, removed: 0 })
}
