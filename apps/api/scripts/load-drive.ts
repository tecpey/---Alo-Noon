/**
 * What the shop does when more than one person is in it.
 *
 * Nothing here had ever been measured under concurrency, and "it is fine for a
 * soft launch" is a belief until somebody puts a number next to it. This puts
 * the numbers next to it: for each surface a customer or an operator actually
 * waits on, the median, the 95th percentile and the worst case, at a
 * concurrency a launch day could plausibly produce.
 *
 * It measures reads. Writes are deliberately left out of the hot loop — a load
 * test that places ten thousand orders leaves ten thousand orders, and the two
 * write paths that matter are already driven end to end by `qa-drive` and
 * guarded for idempotency by the integration suite. What is unknown, and what
 * this answers, is whether the shelf, the fare estimate and the operator board
 * stay usable while several people look at them at once.
 *
 * The numbers to read it against, because a percentile with no criterion is
 * decoration:
 *
 *   - **100ms** — the threshold below which a response feels instantaneous
 *     (Miller 1968; Nielsen's "Response Times" restates it and it has not
 *     moved).
 *   - **1s** — the limit for a person's flow of thought to stay uninterrupted.
 *     Past this they notice the wait.
 *   - **10s** — the limit for keeping attention at all. Past this they leave.
 *
 * A p95 under 1s on the customer's path is the bar for this launch.
 *
 *     pnpm --filter @alo-noon/api exec tsx scripts/load-drive.ts
 */
const BASE = process.env['QA_API_BASE'] ?? 'http://127.0.0.1:3001'
/**
 * The concurrencies to sweep.
 *
 * One number answers nothing. What matters is the shape: a service whose p95
 * tracks its p50 as concurrency rises has spare capacity, and one whose p95
 * lifts away from it has a queue somewhere — and the concurrency where that
 * happens is the number worth knowing before opening the shop.
 */
const LADDER = (process.env['LOAD_LADDER'] ?? '5,10,20,40')
  .split(',')
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => Number.isFinite(value) && value > 0)
const ROUNDS = Number.parseInt(process.env['LOAD_ROUNDS'] ?? '8', 10)

/**
 * The global limiter allows 600 requests a minute per client address, and this
 * script would otherwise spend the budget and then measure its own 429s.
 *
 * Staying under it is not a workaround — it is the correct measurement. What is
 * being asked is how fast the shop answers people it is willing to answer, and
 * a 429 is the shop declining to be measured.
 */
const BUDGET_PER_MINUTE = 500
let spent = 0
let windowStartedAt = Date.now()

async function withinBudget(count: number): Promise<void> {
  const elapsed = Date.now() - windowStartedAt
  if (elapsed >= 60_000) {
    spent = 0
    windowStartedAt = Date.now()
  }
  if (spent + count > BUDGET_PER_MINUTE) {
    const wait = Math.max(0, 60_000 - elapsed) + 250
    process.stdout.write(`   … pausing ${(wait / 1000).toFixed(0)}s to stay under the limiter\n`)
    await new Promise((resolve) => setTimeout(resolve, wait))
    spent = 0
    windowStartedAt = Date.now()
  }
  spent += count
}

interface Sample {
  readonly ms: number
  readonly status: number
}

function assertLoopback(): void {
  const host = new URL(BASE).hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to load a non-loopback host: ${host}`)
  }
}

async function timed(path: string): Promise<Sample> {
  const started = performance.now()
  try {
    const response = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } })
    await response.arrayBuffer()
    return { ms: performance.now() - started, status: response.status }
  } catch {
    return { ms: performance.now() - started, status: 0 }
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]!
}

async function measure(label: string, path: string, criterionMs: number): Promise<boolean> {
  process.stdout.write(`\n${label}  (want p95 ≤ ${criterionMs}ms)\n`)
  let held = true

  for (const concurrency of LADDER) {
    const samples: Sample[] = []
    for (let round = 0; round < ROUNDS; round += 1) {
      await withinBudget(concurrency)
      // A real burst: every request in a round leaves at once, rather than a
      // queue of one-at-a-time calls that would measure latency and call it load.
      samples.push(...(await Promise.all(Array.from({ length: concurrency }, () => timed(path)))))
    }

    const ok = samples.filter((sample) => sample.status >= 200 && sample.status < 400)
    const limited = samples.filter((sample) => sample.status === 429).length
    const times = ok.map((sample) => sample.ms).sort((a, b) => a - b)
    const p50 = percentile(times, 0.5)
    const p95 = percentile(times, 0.95)
    const worst = times.at(-1) ?? 0
    // A 429 is the shop declining to be measured, not a failure of the shop.
    const broken = samples.length - ok.length - limited
    const passed = broken === 0 && p95 <= criterionMs
    if (!passed) held = false

    process.stdout.write(
      `  [${passed ? 'ok  ' : 'FAIL'}] ${String(concurrency).padStart(3)} at a time  ` +
        `p50 ${p50.toFixed(0).padStart(5)}ms  p95 ${p95.toFixed(0).padStart(5)}ms  ` +
        `max ${worst.toFixed(0).padStart(6)}ms  ` +
        `${ok.length}/${samples.length} answered` +
        `${limited ? `, ${limited} rate-limited` : ''}` +
        `${broken ? `, ${broken} BROKEN` : ''}\n`,
    )
  }
  return held
}

async function main(): Promise<void> {
  assertLoopback()
  process.stdout.write(`=== sweeping ${LADDER.join(', ')} at a time, ${ROUNDS} rounds each ===\n`)

  // The city list and the shelf are what a customer waits on before they can do
  // anything at all, so they carry the tightest criterion.
  const cities = await fetch(`${BASE}/api/v1/serviceability/cities`).then(
    (response) => response.json() as Promise<{ data?: { id?: string }[] }>,
  )
  const cityId = cities.data?.[0]?.id
  if (!cityId) throw new Error('no serviceable city — is the launch tenant bootstrapped?')

  const zone = await fetch(`${BASE}/api/v1/serviceability/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cityId, latitude: 36.5387, longitude: 52.6765 }),
  }).then((response) => response.json() as Promise<{ data?: { operationalZoneId?: string } }>)
  const zoneId = zone.data?.operationalZoneId
  if (!zoneId) throw new Error('not serviceable')

  const results = [
    await measure('the city list', '/api/v1/serviceability/cities', 300),
    await measure(
      'the shelf',
      `/api/v1/catalog/products?cityId=${cityId}&operationalZoneId=${zoneId}&page=1&pageSize=20`,
      1000,
    ),
    await measure(
      'the delivery fare estimate',
      `/api/v1/delivery/estimate?cityId=${cityId}&operationalZoneId=${zoneId}`,
      1000,
    ),
    // Not a customer's path, but the one an operator refreshes all morning. If
    // this degrades, the shop stops dispatching while the storefront looks fine.
    await measure('readiness, under the same load', '/ready', 300),
  ]

  const failures = results.filter((passed) => !passed).length
  process.stdout.write(
    failures === 0
      ? '\nEVERY SURFACE HELD ITS CRITERION\n'
      : `\n${failures} SURFACE(S) MISSED THEIR CRITERION\n`,
  )
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  process.stdout.write(`\nLOAD DRIVE ABORTED: ${String(error)}\n`)
  process.exitCode = 1
})
