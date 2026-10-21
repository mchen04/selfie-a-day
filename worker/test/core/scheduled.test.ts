import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/core/env'
import { purgeExpiredTrash } from '../../src/core/photos'
import { runPushScheduler } from '../../src/core/push-seam'

vi.mock('../../src/core/photos', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/photos')>(),
  purgeExpiredTrash: vi.fn(),
}))

vi.mock('../../src/core/push-seam', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/push-seam')>(),
  runPushScheduler: vi.fn(),
}))

const purge = vi.mocked(purgeExpiredTrash)
const push = vi.mocked(runPushScheduler)
const env = {} as Env
const scheduledTime = 1792584000000
const controller: ScheduledController = { scheduledTime, cron: '*/5 * * * *', noRetry() {} }

function schedule(): Promise<unknown> {
  const pending: Promise<unknown>[] = []
  const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise) })
  worker.scheduled(controller, env, { waitUntil } as unknown as ExecutionContext)
  expect(waitUntil).toHaveBeenCalledOnce()
  return pending[0]!
}

describe('independent scheduled jobs', () => {
  beforeEach(() => {
    purge.mockReset().mockResolvedValue(undefined)
    push.mockReset().mockResolvedValue({ sent: 0, skipped: 0, removed: 0 })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it.each(['trash', 'push'])('runs both jobs when %s rejects', async (job) => {
    const error = new Error('Synthetic failure details')
    if (job === 'trash') purge.mockRejectedValue(error)
    else push.mockRejectedValue(error)
    await expect(schedule()).resolves.toBeUndefined()
    expect(purge).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(push).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(console.error).toHaveBeenCalledExactlyOnceWith(job === 'trash' ? 'Trash purge failed' : 'Push scheduler failed')
  })

  it.each(['trash', 'push'])('runs both jobs when %s throws synchronously', async (job) => {
    const fail = () => { throw new Error('Synthetic failure details') }
    if (job === 'trash') purge.mockImplementation(fail)
    else push.mockImplementation(fail)
    await expect(schedule()).resolves.toBeUndefined()
    expect(purge).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(push).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(console.error).toHaveBeenCalledExactlyOnceWith(job === 'trash' ? 'Trash purge failed' : 'Push scheduler failed')
  })

  it('logs both failures without logging exception details', async () => {
    purge.mockRejectedValue(new Error('Synthetic trash failure details'))
    push.mockRejectedValue({ message: 'Synthetic push failure details', detail: 'Synthetic private data' })
    await expect(schedule()).resolves.toBeUndefined()
    expect(purge).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(push).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(vi.mocked(console.error).mock.calls).toEqual([['Trash purge failed'], ['Push scheduler failed']])
  })

  it('starts push before an unfinished trash purge completes', async () => {
    let finish: (() => void) | undefined
    purge.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = schedule()
    await Promise.resolve()
    try {
      expect(push).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    } finally {
      finish!()
      await pending
    }
    expect(purge).toHaveBeenCalledExactlyOnceWith(env, scheduledTime)
    expect(console.error).not.toHaveBeenCalled()
  })
})
