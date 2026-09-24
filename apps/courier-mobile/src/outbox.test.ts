import { describe, expect, it, vi } from 'vitest'

import { CourierApiError } from './api'
import {
  createOutboxStore,
  enqueue,
  flushOutbox,
  isAlreadyApplied,
  isUnreachable,
  MAX_ENTRIES,
  STALE_AFTER_MS,
  type OutboxEntry,
} from './outbox'

const NOW = 1_800_000_000_000

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'e1',
    taskId: 't1',
    kind: 'report',
    to: 'DELIVERED',
    queuedAt: NOW,
    attempts: 0,
    ...overrides,
  }
}

/** A client that fails every call the same way. */
function failing(error: unknown) {
  return {
    respond: vi.fn().mockRejectedValue(error),
    report: vi.fn().mockRejectedValue(error),
  }
}

const working = () => ({
  respond: vi.fn().mockResolvedValue({}),
  report: vi.fn().mockResolvedValue({}),
})

describe('what gets queued and what gets shown', () => {
  it('queues when the phone could not ask', () => {
    // The stairwell, the lift, the basement car park.
    expect(isUnreachable(new TypeError('Network request failed'))).toBe(true)
    expect(isUnreachable(new CourierApiError('SERVICE_UNAVAILABLE', 503))).toBe(true)
    expect(isUnreachable(new CourierApiError('TIMEOUT', 408))).toBe(true)
  })

  it('does not queue when the server answered, because the answer is the point', () => {
    // Burying these in a queue replaces a clear refusal with silence, and the
    // courier acts on silence by assuming it worked.
    for (const code of ['DELIVERY_NOT_YOURS', 'FAILURE_REASON_REQUIRED', 'OFFER_NOT_OPEN']) {
      expect(isUnreachable(new CourierApiError(code, 400)), code).toBe(false)
    }
    expect(isUnreachable(new CourierApiError('DISPATCH_FORBIDDEN', 403))).toBe(false)
  })

  it('reads the state machine’s refusal of a repeated step as “already done”', () => {
    expect(isAlreadyApplied(new CourierApiError('DELIVERY_STEP_NOT_ALLOWED', 409))).toBe(true)
    expect(isAlreadyApplied(new CourierApiError('DELIVERY_NOT_YOURS', 403))).toBe(false)
  })
})

describe('sending what was held', () => {
  it('sends in the order the courier pressed them', async () => {
    const api = working()
    const result = await flushOutbox(
      [
        entry({ id: '1', to: 'PICKED_UP' }),
        entry({ id: '2', to: 'OUT_FOR_DELIVERY' }),
        entry({ id: '3', to: 'DELIVERED' }),
      ],
      api,
      NOW,
    )
    expect(result.sent.map((item) => item.id)).toEqual(['1', '2', '3'])
    expect(result.remaining).toEqual([])
    expect(api.report.mock.calls.map((call) => call[1])).toEqual([
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ])
  })

  it('stops at the first one it still cannot send, rather than skipping past it', async () => {
    /*
      The steps of one delivery are ordered. Sending «delivered» past a stuck
      «picked up» asks the server for a transition from a state it is not in,
      and the answer to that is an error the courier did nothing to deserve.
    */
    const api = {
      respond: vi.fn(),
      report: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValue({}),
    }
    const result = await flushOutbox(
      [entry({ id: '1', to: 'PICKED_UP' }), entry({ id: '2', to: 'DELIVERED' })],
      api,
      NOW,
    )
    expect(result.sent).toEqual([])
    expect(result.remaining.map((item) => item.id)).toEqual(['1', '2'])
    // Only the first was attempted; the second never left the queue.
    expect(api.report).toHaveBeenCalledTimes(1)
  })

  it('counts an attempt, so a permanently stuck entry is visible as one', async () => {
    const result = await flushOutbox(
      [entry({ attempts: 2 })],
      failing(new TypeError('Network request failed')),
      NOW,
    )
    expect(result.remaining[0]?.attempts).toBe(3)
  })

  it('drops a step the server has already taken without telling anybody', async () => {
    // The first attempt landed and the reply was lost. Showing this to the
    // courier would report a failure of something that worked.
    const result = await flushOutbox(
      [entry()],
      failing(new CourierApiError('DELIVERY_STEP_NOT_ALLOWED', 409)),
      NOW,
    )
    expect(result.settled.map((item) => item.id)).toEqual(['e1'])
    expect(result.sent).toEqual([])
    expect(result.remaining).toEqual([])
  })

  it('hands a real refusal back instead of retrying it forever', async () => {
    // It cannot be retried into success, and leaving it in the queue would
    // block every step behind it.
    const result = await flushOutbox(
      [entry({ id: '1' }), entry({ id: '2' })],
      failing(new CourierApiError('DELIVERY_NOT_YOURS', 403)),
      NOW,
    )
    expect(result.stale.map((item) => item.id)).toEqual(['1', '2'])
    expect(result.remaining).toEqual([])
  })
})

describe('nothing is held long enough to become a lie', () => {
  it('refuses to send a report that has gone stale', async () => {
    /*
      A «delivered» sent six hours late records a delivery at the wrong time,
      and reconstructing the day from those timestamps is the whole reason they
      exist. Worse than instant, much better than false.
    */
    const api = working()
    const result = await flushOutbox([entry({ queuedAt: NOW - STALE_AFTER_MS - 1 })], api, NOW)
    expect(result.stale).toHaveLength(1)
    expect(api.report).not.toHaveBeenCalled()
  })

  it('still sends one that is inside the window', async () => {
    const api = working()
    const result = await flushOutbox([entry({ queuedAt: NOW - STALE_AFTER_MS + 1000 })], api, NOW)
    expect(result.sent).toHaveLength(1)
    expect(api.report).toHaveBeenCalledTimes(1)
  })
})

describe('the queue itself', () => {
  it('drops the oldest rather than growing without bound', () => {
    let entries: readonly OutboxEntry[] = []
    for (let index = 0; index < MAX_ENTRIES + 5; index += 1) {
      entries = enqueue(entries, entry({ id: String(index) }))
    }
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]?.id).toBe('5')
    expect(entries.at(-1)?.id).toBe(String(MAX_ENTRIES + 4))
  })

  it('survives a stored file whose shape has moved on', async () => {
    // This file outlives app upgrades, and a crash on launch is the one failure
    // a courier mid-shift cannot work around.
    for (const raw of ['not json at all', '{"not":"an array"}', '[{"id":1}]', '[null]', '']) {
      const store = createOutboxStore({ read: async () => raw, write: async () => {} })
      await expect(store.load()).resolves.toEqual([])
    }
  })

  it('keeps the entries it does understand', async () => {
    const store = createOutboxStore({
      read: async () => JSON.stringify([entry({ id: 'good' }), { id: 'bad' }]),
      write: async () => {},
    })
    await expect(store.load()).resolves.toHaveLength(1)
  })

  it('does not fail a courier’s tap because storage failed', async () => {
    // In memory it still works for this session, which is the part that
    // matters; a storage error in front of somebody on a doorstep is not.
    const store = createOutboxStore({
      read: async () => null,
      write: async () => Promise.reject(new Error('disk full')),
    })
    await expect(store.save([entry()])).resolves.toBeUndefined()
  })
})
