import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordTrigger, triggerCounts } from '../src/audit.ts'

/**
 * The ledger the plugin writes, under the temporary home the suite points at.
 */
function ledgerPath(): string {
  return join(process.env['DSH_HOME'] as string, 'dsh-rules', 'triggers.json')
}

/** Wait for the coalesced flush to land, rather than guessing a delay. */
async function waitForFlush(): Promise<Record<string, number>> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(ledgerPath())) {
      await new Promise<void>(resolve => setTimeout(resolve, 60))
      return JSON.parse(readFileSync(ledgerPath(), 'utf8')) as Record<string, number>
    }
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  }
  throw new Error('the trigger ledger was never flushed')
}

// One lifecycle in one test: the module keeps a coalescing timer and a
// not-yet-flushed delta, and splitting this across cases leaks that state.
describe('the trigger ledger', () => {
  it('counts deliveries, persists them once, and never double-counts', async () => {
    recordTrigger('ts-no-any')
    recordTrigger('ts-no-any')
    recordTrigger('ts-set-map')

    expect(triggerCounts()['ts-no-any']).toBe(2)
    expect(triggerCounts()['ts-set-map']).toBe(1)

    const persisted = await waitForFlush()
    expect(persisted['ts-no-any']).toBe(2)
    expect(persisted['ts-set-map']).toBe(1)

    // After the flush the in-memory delta is empty and the file holds the
    // totals; reading merges the two, so these must not drift upwards.
    expect(triggerCounts()['ts-no-any']).toBe(2)
    expect(triggerCounts()['ts-no-any']).toBe(2)
    expect(triggerCounts()['ts-set-map']).toBe(1)
  })
})
