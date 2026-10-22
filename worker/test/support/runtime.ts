import type { ExecutionContext } from '@cloudflare/workers-types'
import worker from '../../src/index'
import type { Env } from '../../src/core/env'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const previous = Date.now
    const now = request.headers.get('X-Test-Now')
    if (now) Date.now = () => Number(now)
    try {
      const url = new URL(request.url)
      if (url.pathname === '/__test/scheduled') {
        const pending: Promise<unknown>[] = []
        worker.scheduled({ scheduledTime: Number(url.searchParams.get('at')), cron: '*/5 * * * *', noRetry() {} }, env, {
          ...ctx,
          waitUntil(promise: Promise<unknown>) { pending.push(promise) },
        })
        await Promise.all(pending)
        return new Response(null, { status: 204 })
      }
      return await worker.fetch(request, env)
    } finally {
      Date.now = previous
    }
  },
}
