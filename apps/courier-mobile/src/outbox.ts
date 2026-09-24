import type { CourierApiClient, CourierReport } from './api'
import { CourierApiError } from './api'

/**
 * What a courier said, held until the signal comes back.
 *
 * A delivery rider spends the day in exactly the places a phone does not work:
 * a stairwell, a basement car park, a lift, the shadow of a block of flats. The
 * app used to answer a tap in one of those with an error message, and the
 * courier's only option was to remember to press it again once they were back
 * outside. What actually happens is that they do not — they are already on the
 * next order — and the customer is never told their bread arrived, the order
 * never closes, and the shop's own numbers say a delivery that happened did
 * not.
 *
 * So a report that cannot be sent is kept, in order, and sent when the network
 * returns. Three things make that safe rather than merely convenient:
 *
 * **Only a transport failure is queued.** `DELIVERY_NOT_YOURS` and
 * `FAILURE_REASON_REQUIRED` are the server telling the courier something true,
 * and burying those in a queue would replace a clear refusal with silence.
 * A queue is for "I could not ask", never for "the answer was no".
 *
 * **A replay that was already applied is not an error.** The delivery state
 * machine refuses a step it has already taken with `DELIVERY_STEP_NOT_ALLOWED`.
 * When a queued step replays after the first attempt did in fact land, that is
 * exactly the answer it gets — so it is read as "already done" and dropped,
 * rather than shown to the courier as a failure of something that worked.
 *
 * **Nothing is held for long.** A `DELIVERED` sent six hours late records a
 * delivery at the wrong time, and the whole point of the timestamp is that
 * somebody can reconstruct the day from it. Past `STALE_AFTER_MS` an entry
 * stops trying and is handed back to the courier to re-report, which is worse
 * than instant and much better than a lie.
 */
export interface OutboxEntry {
  /** Stable across restarts, so a replay cannot be counted twice in the queue. */
  readonly id: string
  readonly taskId: string
  readonly kind: 'respond' | 'report'
  /** For `respond`. */
  readonly accept?: boolean
  /** For `report`. */
  readonly to?: CourierReport
  readonly reasonCode?: string
  /** When the courier pressed it, not when it was sent. */
  readonly queuedAt: number
  readonly attempts: number
}

/**
 * Two hours. A delivery is minutes; anything still unsent after two hours is
 * not a network blip, it is a phone that was switched off or a rider who went
 * home, and replaying it would write yesterday into today.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000

/** Enough for a whole shift's worth of stops, and bounded so a broken network cannot fill the disk. */
export const MAX_ENTRIES = 50

export interface OutboxStorage {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

/**
 * Whether a failure means "the answer was no" or "I could not ask".
 *
 * Only the second is queued. Anything the server answered — any 4xx that is not
 * a timeout, and any parse failure — is a real verdict the courier has to see.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof CourierApiError) {
    // 0 is what a thrown fetch is normalised to; 408 and 5xx are the server
    // saying it could not answer this time rather than answering.
    return error.status === 0 || error.status === 408 || error.status >= 500
  }
  // A fetch that threw: DNS, TCP, TLS, aeroplane mode. No answer at all.
  return error instanceof TypeError || error instanceof Error
}

/**
 * Whether a refusal means the step this entry carries has already been taken.
 *
 * The delivery state machine answers a step it cannot take from the current
 * state with `DELIVERY_STEP_NOT_ALLOWED`, and that is the same answer whether
 * the step is out of order or already done. The queue only ever holds steps the
 * courier really pressed, in the order they pressed them, so when a replay of
 * one meets that refusal the overwhelmingly likely reason is that the first
 * attempt landed after all and the reply was what was lost.
 *
 * Treating it as done is the safe reading in both directions: if it truly was
 * already applied, dropping it is correct; if it was genuinely out of order,
 * the list the courier refreshes onto shows the real state, and the entry
 * staying in the queue forever would help nobody.
 */
export function isAlreadyApplied(error: unknown): boolean {
  return error instanceof CourierApiError && error.code === 'DELIVERY_STEP_NOT_ALLOWED'
}

export function isStale(entry: OutboxEntry, now: number): boolean {
  return now - entry.queuedAt >= STALE_AFTER_MS
}

export interface FlushResult {
  readonly sent: readonly OutboxEntry[]
  /** Already applied by an attempt whose reply was lost. Nothing to tell anybody. */
  readonly settled: readonly OutboxEntry[]
  /** Held too long to send honestly. The courier is told and re-reports. */
  readonly stale: readonly OutboxEntry[]
  /** Still waiting, in order. */
  readonly remaining: readonly OutboxEntry[]
}

/**
 * Sends what it can, in the order it was pressed, and stops at the first entry
 * that still cannot be sent.
 *
 * Stopping matters: the steps of one delivery are ordered — picked up, then on
 * the way, then delivered — and sending a later one past a stuck earlier one
 * would ask the server for a transition from a state it is not in.
 */
export async function flushOutbox(
  entries: readonly OutboxEntry[],
  api: Pick<CourierApiClient, 'respond' | 'report'>,
  now: number,
): Promise<FlushResult> {
  const sent: OutboxEntry[] = []
  const settled: OutboxEntry[] = []
  const stale: OutboxEntry[] = []
  const remaining: OutboxEntry[] = []
  let blocked = false

  for (const entry of entries) {
    if (blocked) {
      remaining.push(entry)
      continue
    }
    if (isStale(entry, now)) {
      stale.push(entry)
      continue
    }
    try {
      if (entry.kind === 'respond') await api.respond(entry.taskId, entry.accept === true)
      else await api.report(entry.taskId, entry.to!, entry.reasonCode)
      sent.push(entry)
    } catch (error) {
      if (isAlreadyApplied(error)) {
        settled.push(entry)
        continue
      }
      if (isUnreachable(error)) {
        blocked = true
        remaining.push({ ...entry, attempts: entry.attempts + 1 })
        continue
      }
      // A real refusal. It cannot be retried into success and it must not sit
      // in the queue blocking the steps behind it, so it leaves as "stale" —
      // the one bucket that is shown to the courier.
      stale.push(entry)
    }
  }

  return { sent, settled, stale, remaining }
}

/** Appends, dropping the oldest once the queue is full rather than growing without bound. */
export function enqueue(
  entries: readonly OutboxEntry[],
  entry: OutboxEntry,
): readonly OutboxEntry[] {
  const next = [...entries, entry]
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
}

export function createOutboxStore(storage: OutboxStorage) {
  return {
    async load(): Promise<readonly OutboxEntry[]> {
      try {
        const raw = await storage.read()
        if (!raw) return []
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        // Parsed defensively: this file survives app upgrades, and an entry
        // whose shape has moved on must not crash the app on launch — the one
        // moment a courier cannot work around.
        return parsed.filter(isEntry)
      } catch {
        return []
      }
    },
    async save(entries: readonly OutboxEntry[]): Promise<void> {
      try {
        await storage.write(JSON.stringify(entries))
      } catch {
        // A queue that cannot be written is still useful in memory for this
        // session, and a courier mid-shift must not be shown a storage error.
      }
    },
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['taskId'] === 'string' &&
    (entry['kind'] === 'respond' || entry['kind'] === 'report') &&
    typeof entry['queuedAt'] === 'number' &&
    typeof entry['attempts'] === 'number'
  )
}
