import { DomainError } from './errors'
import type { DeliveryCoordinates, DeliveryVehicleProfile } from './delivery-pricing'

/**
 * What a delivery actually costs, asked at the moment it is ordered.
 *
 * ## Why a published tariff is not enough
 *
 * A stored rate — a call-out plus so much per kilometre — prices every journey
 * as though the only thing that varies is its length. That is wrong in the two
 * directions that matter most to whoever is paying:
 *
 * **It is wrong about the market.** Where the delivery is bought from somebody
 * else — a courier marketplace — the price is *theirs to announce*, not ours to
 * predict. Quoting our own guess and then paying their number means eating the
 * difference on every order, in whichever direction it falls.
 *
 * **It is wrong about the moment.** Breakfast in Babol is not a smooth curve.
 * Every household wants bread inside the same ninety minutes, and a fare that
 * ignores that is underpriced exactly when couriers are scarcest and overpriced
 * for the rest of the day. This is what Snapp and Tapsi compute per request
 * rather than publish.
 *
 * So the fare is **quoted**, not looked up. This module is the contract for
 * asking, and the arithmetic for answering when nobody external can be asked.
 *
 * ## Why a quoted fare must still be frozen
 *
 * This product settles before it delivers: the customer pays, and only then
 * does a courier move. A fare that kept floating between the quote and the
 * payment would mean collecting an amount that no longer matches the job — and
 * the customer would have agreed to a number that was never charged.
 *
 * So every quote carries an expiry and, where a provider issued it, that
 * provider's own reference. Inside the window the number is honoured exactly.
 * Outside it, the fare is asked for again and the customer is shown the new one
 * before they pay. Nothing is ever silently re-priced under an order.
 *
 * ## Why a live fare is never cached
 *
 * `RouteEstimate` caches routed distances for a fortnight, and that is right: a
 * road's length does not change between breakfast and lunch. A fare does — that
 * is the entire point of asking for it. Caching one would freeze a single
 * busy morning's surge and charge it to everybody for a fortnight, with nothing
 * in the system that would ever correct it.
 */

/**
 * The adapter contract's version.
 *
 * Stored on each configuration row, so a deployment carrying only version 1
 * adapters refuses a configuration written for version 2 rather than calling it
 * with arguments it does not understand. Bumped only when the shape below
 * changes in a way an existing adapter would not survive.
 */
export const DELIVERY_FARE_ADAPTER_SPI_VERSION = 1 as const

export type DeliveryFareAdapterSpiVersion = typeof DELIVERY_FARE_ADAPTER_SPI_VERSION

export type DeliveryFareEnvironment = 'TEST' | 'PRODUCTION'

/**
 * Where the number on the customer's screen came from.
 *
 * Recorded on the quote rather than inferred later, because the three answers
 * carry different obligations. A `PROVIDER` fare is one somebody else will
 * invoice us for and can be reconciled against their statement. A `DYNAMIC`
 * fare is ours, and the factors that moved it are ours to justify. A `TARIFF`
 * fare means the live path was unavailable and the published rate stood in —
 * which is safe, and is also the state an operator wants to see if it persists.
 */
export type DeliveryFareSource = 'PROVIDER' | 'DYNAMIC' | 'TARIFF'

/**
 * One line of why the fare is what it is.
 *
 * Carried in Persian because it is shown to the customer. A fare that moved and
 * cannot say why is the thing people complain about, and "شلوغی صبحگاهی" is an
 * explanation while "surge 1.2×" is a receipt for an argument.
 */
export interface FareComponent {
  readonly code: string
  readonly labelFa: string
  /** Rial. Negative for a reduction, so the components sum to the total. */
  readonly amount: bigint
}

export interface FareQuoteRequest {
  readonly origin: DeliveryCoordinates
  readonly destination: DeliveryCoordinates
  readonly profile: DeliveryVehicleProfile
  /** As measured or estimated by the routing layer; providers price on it. */
  readonly distanceMetres: number
  readonly durationSeconds: number | null
  /**
   * How many loaves are going, which decides whether a bag or a boot is
   * needed. Deliberately the only thing about the *basket* that crosses this
   * boundary: a trip is priced on the trip, and passing the order's value would
   * mean recomputing the whole cart outside the transaction that prices it, for
   * a field most couriers ignore. An adapter that genuinely needs declared
   * value is a reason to raise the SPI version, not to widen this quietly.
   */
  readonly itemCount: number
  readonly requestedAt: Date
  readonly timeoutMs: number
  readonly configuration: DeliveryFareProviderConfigurationView
  readonly credential: ResolvedFareCredential
}

/**
 * `Uint8Array` rather than `Buffer`, matching the routing credential beside it:
 * this package is platform-neutral and compiles for the mobile apps too, where
 * Node's `Buffer` does not exist.
 */
export interface ResolvedFareCredential {
  readonly material: Uint8Array
  dispose(): void
}

export interface DeliveryFareProviderConfigurationView {
  readonly id: string
  readonly tenantId: string
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: DeliveryFareAdapterSpiVersion
  readonly environment: DeliveryFareEnvironment
  readonly credentialReference: string
}

/**
 * A price somebody has committed to, for a while.
 *
 * `expiresAt` is the commitment, not a hint: past it the number must be asked
 * for again rather than assumed to still hold. `providerReference` is what the
 * booking is later made against — without it a marketplace has no way to know
 * that the trip being dispatched is the one it priced, and would price it a
 * second time at whatever the market is doing by then.
 */
export interface ProviderFareQuote {
  readonly amount: bigint
  readonly currency: 'IRR'
  readonly expiresAt: Date
  readonly providerReference: string
  /**
   * What the provider says its own multiplier was, in basis points, where
   * 10_000 is no surge. Informational: the amount is authoritative, and this
   * only lets the customer be told that a busy moment is why.
   */
  readonly surgeBasisPoints?: number
  readonly components?: readonly FareComponent[]
}

export interface DeliveryFareProvider {
  readonly code: string
  readonly adapterVersion: string
  readonly spiVersion: DeliveryFareAdapterSpiVersion
  /** Refused in PRODUCTION, so a stand-in cannot price a real customer. */
  readonly testOnly?: boolean
  quoteFare(request: FareQuoteRequest): Promise<ProviderFareQuote>
}

export interface DeliveryFareRegistry {
  resolve(input: {
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: number
    environment: DeliveryFareEnvironment
  }): DeliveryFareProvider
  identities(): readonly Readonly<{
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: number
    testOnly: boolean
  }>[]
}

function registryKey(code: string, version: string, spiVersion: number): string {
  return `${code}@${version}#${spiVersion}`
}

export function createDeliveryFareRegistry(
  adapters: readonly DeliveryFareProvider[],
): DeliveryFareRegistry {
  const registered = new Map<string, DeliveryFareProvider>()
  const identities: {
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: number
    testOnly: boolean
  }[] = []

  for (const adapter of adapters) {
    if (
      !/^[A-Z][A-Z0-9_]{1,31}$/.test(adapter.code) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adapter.adapterVersion) ||
      adapter.spiVersion !== DELIVERY_FARE_ADAPTER_SPI_VERSION
    ) {
      throw new DomainError(
        'DELIVERY_FARE_REGISTRY_INVALID',
        'Delivery fare adapter identity is invalid',
      )
    }
    const key = registryKey(adapter.code, adapter.adapterVersion, adapter.spiVersion)
    if (registered.has(key)) {
      throw new DomainError(
        'DELIVERY_FARE_REGISTRY_INVALID',
        'Delivery fare adapter identity is duplicated',
      )
    }
    registered.set(key, adapter)
    identities.push(
      Object.freeze({
        providerCode: adapter.code,
        adapterVersion: adapter.adapterVersion,
        adapterSpiVersion: adapter.spiVersion,
        testOnly: adapter.testOnly === true,
      }),
    )
  }

  const snapshot = Object.freeze(identities)
  const registry: DeliveryFareRegistry = {
    resolve(input: {
      providerCode: string
      adapterVersion: string
      adapterSpiVersion: number
      environment: DeliveryFareEnvironment
    }) {
      const adapter = registered.get(
        registryKey(input.providerCode, input.adapterVersion, input.adapterSpiVersion),
      )
      if (!adapter || (input.environment === 'PRODUCTION' && adapter.testOnly === true)) {
        throw new DomainError(
          'DELIVERY_FARE_ADAPTER_UNAVAILABLE',
          'Delivery fare provider is unavailable',
        )
      }
      return adapter
    },
    identities: () => snapshot,
  }
  return Object.freeze(registry)
}

/**
 * A provider's answer, checked before any of it reaches a customer or a ledger.
 *
 * An adapter talks to somebody else's server, and this is the boundary where
 * that stops being trusted. A negative fare would credit the customer, a fare
 * with no expiry would be honoured forever, and an expiry already in the past
 * would make every quote instantly stale — all three are cheaper to refuse here
 * than to discover in the ledger.
 */
export function normalizeProviderFareQuote(
  quote: ProviderFareQuote,
  now: Date,
): Readonly<ProviderFareQuote> {
  if (typeof quote.amount !== 'bigint' || quote.amount < 0n) {
    throw new DomainError('INVALID_FARE_QUOTE', 'A quoted fare cannot be negative')
  }
  if (quote.currency !== 'IRR') {
    throw new DomainError('INVALID_FARE_QUOTE', 'A quoted fare must be in Rial')
  }
  if (!(quote.expiresAt instanceof Date) || Number.isNaN(quote.expiresAt.getTime())) {
    throw new DomainError('INVALID_FARE_QUOTE', 'A quoted fare must say when it stops holding')
  }
  if (quote.expiresAt <= now) {
    throw new DomainError('INVALID_FARE_QUOTE', 'A quoted fare has already expired')
  }
  if (!/^[\w.:@=+/-]{1,200}$/.test(quote.providerReference)) {
    throw new DomainError('INVALID_FARE_QUOTE', 'A quoted fare must carry a usable reference')
  }
  if (
    quote.surgeBasisPoints !== undefined &&
    (!Number.isSafeInteger(quote.surgeBasisPoints) || quote.surgeBasisPoints < 0)
  ) {
    throw new DomainError('INVALID_FARE_QUOTE', 'A surge multiplier cannot be negative')
  }
  return Object.freeze({
    amount: quote.amount,
    currency: quote.currency,
    expiresAt: quote.expiresAt,
    providerReference: quote.providerReference,
    ...(quote.surgeBasisPoints !== undefined && { surgeBasisPoints: quote.surgeBasisPoints }),
    ...(quote.components && { components: Object.freeze([...quote.components]) }),
  })
}

/**
 * Multipliers held as basis points rather than decimals.
 *
 * 10_000 is ×1. Money here is an integer number of Rial, and a float multiplier
 * reintroduces exactly the representation error that integer money exists to
 * avoid — two customers quoted "the same" 1.15× would not always be charged the
 * same amount. Basis points keep the whole calculation in integers.
 */
export const FARE_MULTIPLIER_ONE = 10_000

/**
 * A window of the day that prices differently, in the tenant's own timezone.
 *
 * Half-open [from, until): a window ending at 9 and one starting at 9 do not
 * both claim nine o'clock. Minutes are counted from local midnight, so a window
 * may not wrap past it — two windows express a night shift, which also keeps
 * "does this minute fall inside" a comparison rather than a special case.
 */
export interface FarePeakWindow {
  readonly code: string
  readonly labelFa: string
  readonly fromMinuteOfDay: number
  readonly untilMinuteOfDay: number
  readonly multiplierBasisPoints: number
}

export interface DynamicFarePolicy {
  readonly peakWindows: readonly FarePeakWindow[]
  /**
   * Whether the fare may move with how busy the shop is right now.
   *
   * Off by default, and that is a deliberate default rather than an unfinished
   * one. This sells bread, which is a staple; a price that climbs when
   * everybody needs it is a different proposition from one that climbs for a
   * taxi, and it is a decision for whoever runs the shop and answers for it —
   * not a behaviour to inherit by installing software.
   */
  readonly demandEnabled: boolean
  /**
   * Orders waiting per available courier before demand starts to count. Below
   * it the multiplier is exactly ×1, so an ordinary morning is never surcharged.
   */
  readonly demandThresholdPerCourier: number
  /** Added per whole order per courier above the threshold. */
  readonly demandStepBasisPoints: number
  /**
   * The hard ceiling on everything multiplied together.
   *
   * A cap rather than a warning: demand signals come from live counts, and a
   * miscount, a courier app that failed to check in, or a quiet hour with one
   * courier logged off should not be able to quote somebody four times the
   * fare. Whatever the factors say, the customer cannot be charged past this.
   */
  readonly maxMultiplierBasisPoints: number
}

/**
 * The starting policy: the two rushes a bakery actually has, and no surge.
 *
 * The windows are the ones bread is bought in — dawn and the hour before
 * dinner — and the uplift on them is small (×1.15 and ×1.10) because it is
 * paying for couriers being scarce at those hours, not for the customer having
 * no alternative. Every number here is a stated assumption to be replaced by
 * the first month of real orders: the data needed is completed deliveries per
 * hour against couriers on shift.
 */
export const DEFAULT_DYNAMIC_FARE_POLICY: DynamicFarePolicy = Object.freeze({
  peakWindows: Object.freeze([
    Object.freeze({
      code: 'MORNING_RUSH',
      labelFa: 'شلوغی صبحگاهی',
      fromMinuteOfDay: 6 * 60,
      untilMinuteOfDay: 9 * 60,
      multiplierBasisPoints: 11_500,
    }),
    Object.freeze({
      code: 'EVENING_RUSH',
      labelFa: 'شلوغی عصرگاهی',
      fromMinuteOfDay: 17 * 60,
      untilMinuteOfDay: 20 * 60,
      multiplierBasisPoints: 11_000,
    }),
  ]),
  demandEnabled: false,
  demandThresholdPerCourier: 3,
  demandStepBasisPoints: 500,
  maxMultiplierBasisPoints: 15_000,
})

export interface FareDemandSignal {
  /** Orders accepted and not yet delivered. */
  readonly openOrders: number
  /** Couriers on shift and able to take another job. */
  readonly availableCouriers: number
}

export interface FareMultiplierDecision {
  readonly basisPoints: number
  /** Why, in the order it should be explained. Empty when the fare is flat. */
  readonly reasons: readonly { readonly code: string; readonly labelFa: string }[]
  /** Whether the cap bound the result, which an operator wants to know. */
  readonly capped: boolean
}

function assertPolicy(policy: DynamicFarePolicy): void {
  if (
    !Number.isSafeInteger(policy.maxMultiplierBasisPoints) ||
    policy.maxMultiplierBasisPoints < FARE_MULTIPLIER_ONE
  ) {
    throw new DomainError('INVALID_FARE_POLICY', 'The fare cap cannot be below ×1')
  }
  for (const window of policy.peakWindows) {
    if (
      !Number.isSafeInteger(window.fromMinuteOfDay) ||
      !Number.isSafeInteger(window.untilMinuteOfDay) ||
      window.fromMinuteOfDay < 0 ||
      window.untilMinuteOfDay > 24 * 60 ||
      window.fromMinuteOfDay >= window.untilMinuteOfDay
    ) {
      throw new DomainError('INVALID_FARE_POLICY', 'A peak window must be a real span of one day')
    }
    if (
      !Number.isSafeInteger(window.multiplierBasisPoints) ||
      window.multiplierBasisPoints < FARE_MULTIPLIER_ONE
    ) {
      throw new DomainError('INVALID_FARE_POLICY', 'A peak window cannot discount below ×1')
    }
  }
}

/**
 * How much this moment costs above an ordinary one.
 *
 * Takes the minute of the local day rather than a `Date`, because "is it the
 * breakfast rush" is a question about Babol's clock and a server's clock is
 * neither here nor there. The caller converts once, with the tenant's timezone.
 *
 * Windows do not compound. Where two overlap the larger wins, which is the
 * conservative reading of a table somebody edited twice: two rushes that happen
 * to touch should not multiply into a third, larger one nobody wrote down.
 */
export function dynamicFareMultiplier(
  policy: DynamicFarePolicy,
  minuteOfLocalDay: number,
  demand?: FareDemandSignal,
): Readonly<FareMultiplierDecision> {
  assertPolicy(policy)
  if (!Number.isSafeInteger(minuteOfLocalDay) || minuteOfLocalDay < 0 || minuteOfLocalDay >= 1440) {
    throw new DomainError('INVALID_FARE_INPUT', 'The minute of day is not a minute of a day')
  }

  const reasons: { code: string; labelFa: string }[] = []
  let basisPoints = FARE_MULTIPLIER_ONE

  const peak = policy.peakWindows
    .filter(
      (window) =>
        minuteOfLocalDay >= window.fromMinuteOfDay && minuteOfLocalDay < window.untilMinuteOfDay,
    )
    .sort((left, right) => right.multiplierBasisPoints - left.multiplierBasisPoints)[0]
  if (peak && peak.multiplierBasisPoints > FARE_MULTIPLIER_ONE) {
    basisPoints = peak.multiplierBasisPoints
    reasons.push({ code: peak.code, labelFa: peak.labelFa })
  }

  if (policy.demandEnabled && demand) {
    if (!Number.isSafeInteger(demand.openOrders) || demand.openOrders < 0) {
      throw new DomainError('INVALID_FARE_INPUT', 'Open orders cannot be negative')
    }
    if (!Number.isSafeInteger(demand.availableCouriers) || demand.availableCouriers < 0) {
      throw new DomainError('INVALID_FARE_INPUT', 'Available couriers cannot be negative')
    }
    // No couriers at all is not infinite demand — it is a shop that should stop
    // taking orders, which capacity handles. Surcharging instead would quote a
    // capped fare for a delivery nobody can make.
    if (demand.availableCouriers > 0) {
      const perCourier = Math.floor(demand.openOrders / demand.availableCouriers)
      const over = perCourier - policy.demandThresholdPerCourier
      if (over > 0) {
        // Added to the peak rather than multiplied by it: two independent
        // reasons for the fare to rise should sum, not compound into a number
        // neither of them describes.
        basisPoints += over * policy.demandStepBasisPoints
        reasons.push({ code: 'HIGH_DEMAND', labelFa: 'تقاضای زیاد در این لحظه' })
      }
    }
  }

  const capped = basisPoints > policy.maxMultiplierBasisPoints
  return Object.freeze({
    basisPoints: capped ? policy.maxMultiplierBasisPoints : basisPoints,
    reasons: Object.freeze(reasons),
    capped,
  })
}

/**
 * The smallest step a fare is expressed in: 1,000 Rial, which is 100 Toman.
 *
 * A multiplied fare lands on numbers like 63,250 Rial, and quoting that tells
 * the customer they are looking at the output of a formula rather than a price.
 * Rounding is to the nearest step rather than upward, so the rounding itself is
 * not a quiet extra charge.
 */
export const FARE_ROUNDING_STEP_RIAL = 1_000n

export function roundFareToStep(amount: bigint, step = FARE_ROUNDING_STEP_RIAL): bigint {
  if (step <= 0n) throw new DomainError('INVALID_FARE_INPUT', 'A rounding step must be positive')
  const remainder = amount % step
  if (remainder === 0n) return amount
  return remainder * 2n >= step ? amount - remainder + step : amount - remainder
}

/**
 * A base fare with this moment's multiplier applied.
 *
 * Zero stays zero: a free delivery that a busy morning turns into 7,000 Rial
 * would be the most expensive kind of broken promise, because the customer was
 * told it was free on the screen before this one.
 */
export function applyFareMultiplier(
  baseAmount: bigint,
  decision: FareMultiplierDecision,
): { readonly amount: bigint; readonly uplift: bigint } {
  if (baseAmount < 0n) throw new DomainError('INVALID_FARE_INPUT', 'A base fare cannot be negative')
  if (baseAmount === 0n || decision.basisPoints === FARE_MULTIPLIER_ONE) {
    return Object.freeze({ amount: baseAmount, uplift: 0n })
  }
  const multiplied = (baseAmount * BigInt(decision.basisPoints)) / BigInt(FARE_MULTIPLIER_ONE)
  const amount = roundFareToStep(multiplied)
  return Object.freeze({ amount, uplift: amount - baseAmount })
}

/**
 * The minute of the day a `Date` falls on, in a named timezone.
 *
 * Via `Intl` rather than by adding a stored offset, because Iran has changed
 * whether it keeps daylight saving within the lifetime of code like this, and a
 * hardcoded +03:30 would price the breakfast rush an hour out on the day that
 * changes again.
 */
export function minuteOfLocalDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? NaN)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? NaN)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new DomainError('INVALID_FARE_INPUT', 'The local time could not be read')
  }
  // `hour12: false` yields 24 for midnight in some ICU versions rather than 0,
  // which would fall outside every window and silently disable night pricing.
  return (hour % 24) * 60 + minute
}

/**
 * How long our own quoted fare holds.
 *
 * Long enough to read a basket and pay, short enough that a fare quoted in the
 * calm before the rush is not still being honoured in the middle of it. A
 * provider's own expiry always wins over this — it is their commitment, not
 * ours to extend.
 */
export const DYNAMIC_FARE_TTL_MS = 15 * 60 * 1_000
