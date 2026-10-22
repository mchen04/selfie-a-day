import { expect, test } from '@playwright/test'
import { dayLabel } from './calendar.ts'
import { DAYS, STARTS } from './days.ts'
import { PushReceiver } from './push.ts'
import { Day, writeSummary } from './sim.ts'

/**
 * Ten simulated days of Selfie a Day, one test per day, in calendar order.
 * Each day records soft checks so it always writes its evidence, then fails if
 * any check failed. State (browser profiles, server data) carries over from
 * day to day on disk, so a failed day does not stop the next one from running.
 */
const receiver = new PushReceiver()

test.beforeAll(async () => { await receiver.start() })
test.afterAll(async () => {
  await receiver.stop()
  writeSummary()
})

for (const [index, script] of DAYS.entries()) {
  const n = index + 1
  test(dayLabel(n), async () => {
    const day = new Day(n, receiver, STARTS[index]!)
    try {
      await day.step('day script', 'invariants', () => script(day))
      await day.invariants()
    } finally {
      await day.finish()
    }
    expect(day.failures(), `${dayLabel(n)}: failed checks`).toEqual([])
  })
}
