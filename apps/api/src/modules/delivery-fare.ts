import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  applyFareMultiplier,
  DEFAULT_DYNAMIC_FARE_POLICY,
  DYNAMIC_FARE_TTL_MS,
  dynamicFareMultiplier,
  FARE_MULTIPLIER_ONE,
  minuteOfLocalDay,
  normalizeProviderFareQuote,
  type DeliveryCoordinates,
  type DeliveryFareAdapterSpiVersion,
  type DeliveryFareProvider,
  type DeliveryFareRegistry,
  type DeliveryFareSource,
  type DeliveryVehicleProfile,
  type DynamicFarePolicy,
  type FareComponent,
  type FareDemandSignal,
  type ResolvedFareCredential,
} from '@alo-noon/domain'

/**
 * What this delivery costs, asked at the moment it is ordered.
 *
 * Three answers, in order, and the order is the design:
 *
 * 1. **A courier marketplace**, if one is configured, enabled, healthy and
 *    default. Its number is authoritative because it is the number that will be
 *    invoiced; quoting our own guess against somebody else's price means eating
 *    the difference on every order, in whichever direction it falls.
 * 2. **Our own live calculation** — the published tariff with this moment's
 *    factors applied. This is the normal path for a shop delivering with its
 *    own couriers, and it is still dynamic: the fare quoted during the
 *    breakfast rush is not the fare quoted at eleven.
 * 3. **The published tariff, flat**, where a tenant has turned the factors off.
 *
 * Like routing, this **never throws for a pricing problem**. A customer is
 * standing at a checkout; a marketplace having a bad afternoon must not be the
 * reason they cannot buy bread. Every answer carries its source, so a fare that
 * fell back can be recognised as one rather than quietly passing for a quote.
 *
 * Nothing here is cached. A routed distance keeps for a fortnight because a
 * road does not change between breakfast and lunch; a fare changes precisely
 * because the moment did, and a cached one would charge a single busy morning's
 * price to everybody until it expired.
 *
 * ## Why this is split in two
 *
 * `offerFromProvider` talks to another company's server and `ownFare` does not.
 * ADR-0010 keeps external calls out of database transactions, and the reason is
 * sharper here than usual: the quote runs in a SERIALIZABLE transaction holding
 * locks a checkout depends on, so a marketplace having a slow afternoon would
 * become a checkout having one. The provider is therefore asked *before* the
 * transaction opens, and `chooseFare` decides inside it — by which time the
 * authoritative tariff amount is known and the offer can be checked against the
 * journey it was actually quoted for.
 */
export interface ProviderFareQuery {
  readonly origin: DeliveryCoordinates
  readonly destination: DeliveryCoordinates
  readonly profile: DeliveryVehicleProfile
  readonly distanceMetres: number
  readonly durationSeconds: number | null
  readonly itemCount: number
}

/**
 * A price a marketplace has committed to, and the journey it committed to.
 *
 * The journey is carried back so the transaction can check that the cart it is
 * about to price is the one that was quoted. A cart that switched branches
 * between the two reads is a different trip, and honouring a price quoted for
 * somebody else's road is how a fare ends up unreconcilable against the
 * invoice that follows it.
 */
export interface ProviderFareOffer {
  readonly amount: bigint
  readonly providerCode: string
  readonly providerReference: string
  readonly expiresAt: Date
  readonly surgeBasisPoints: number
  readonly components: readonly FareComponent[]
  readonly quotedFor: {
    readonly branchId: string
    readonly addressId: string
    readonly profile: DeliveryVehicleProfile
  }
}

export interface OwnFareInput {
  /**
   * What the published tariff says, already through `calculateDeliveryFee` — so
   * the minimum order has been enforced and any free-delivery threshold already
   * applied. It is the floor this builds on and the answer of last resort.
   */
  readonly tariffAmount: bigint
  /** The tenant's own clock. "Is it the breakfast rush" is a question about Babol. */
  readonly timeZone: string
}

export interface ResolvedFare {
  readonly amount: bigint
  readonly source: DeliveryFareSource
  readonly providerCode: string | null
  readonly providerReference: string | null
  readonly expiresAt: Date | null
  readonly multiplierBasisPoints: number
  readonly reasonCodes: readonly string[]
  readonly components: readonly FareComponent[]
}

export interface DeliveryFareService {
  /**
   * The marketplace's price, or null when there is no marketplace, it cannot be
   * reached, or it answered with something that did not survive validation.
   * Never throws: all four outcomes mean the same thing to the caller.
   */
  offerFromProvider(
    tenantId: string,
    query: ProviderFareQuery,
    context: ProviderFareOffer['quotedFor'],
    now: Date,
  ): Promise<Readonly<ProviderFareOffer> | null>

  /** Our own price for this tariff amount, with this moment's factors. */
  ownFare(tenantId: string, input: OwnFareInput, now: Date): Promise<Readonly<ResolvedFare>>
}

export interface DeliveryFareCredentialResolver {
  resolve(
    reference: string,
    tenantId: string,
    providerCode: string,
  ): Promise<ResolvedFareCredential>
}

export interface PrismaDeliveryFareOptions {
  readonly registry: DeliveryFareRegistry
  readonly credentialResolver: DeliveryFareCredentialResolver
  readonly environment: 'TEST' | 'PRODUCTION'
  readonly invocationTimeoutMs?: number
  /**
   * The factors that move our own fare. Overridable per deployment so a tenant
   * can turn them off; per-tenant tuning from the admin panel is the next step,
   * and until it exists this is the one place the windows are written.
   */
  readonly dynamicPolicy?: DynamicFarePolicy | null
}

/**
 * Four seconds, the same budget routing gets.
 *
 * It bounds how long a checkout can be held by somebody else's server. A
 * marketplace that cannot price a trip inside four seconds during a rush is one
 * whose price we will not be waiting for, and our own fare is a perfectly good
 * answer.
 */
const DEFAULT_TIMEOUT_MS = 4_000

const flatFare = (amount: bigint): Readonly<ResolvedFare> =>
  Object.freeze({
    amount,
    source: 'TARIFF' as const,
    providerCode: null,
    providerReference: null,
    expiresAt: null,
    multiplierBasisPoints: FARE_MULTIPLIER_ONE,
    reasonCodes: Object.freeze([]),
    components: Object.freeze([]),
  })

/**
 * Which of the three answers this quote gets, decided where it is safe to
 * decide: inside the transaction, with the authoritative numbers.
 *
 * A free delivery stays free. The threshold is a promise the shop already made
 * on the screen before this one, and a marketplace quote or a rush multiplier
 * turning that zero into a number would be the most expensive kind of broken
 * promise.
 *
 * An offer is used only if it is still live and was quoted for this journey. An
 * expired one is not nearly-valid — it is a price nobody is holding any more.
 */
export function chooseFare(
  tariffAmount: bigint,
  offer: ProviderFareOffer | null,
  context: ProviderFareOffer['quotedFor'],
  own: Readonly<ResolvedFare>,
  now: Date,
): Readonly<ResolvedFare> {
  if (tariffAmount === 0n) return flatFare(0n)
  if (
    offer &&
    offer.expiresAt > now &&
    offer.quotedFor.branchId === context.branchId &&
    offer.quotedFor.addressId === context.addressId &&
    offer.quotedFor.profile === context.profile
  ) {
    return Object.freeze({
      amount: offer.amount,
      source: 'PROVIDER' as const,
      providerCode: offer.providerCode,
      providerReference: offer.providerReference,
      expiresAt: offer.expiresAt,
      multiplierBasisPoints: offer.surgeBasisPoints,
      reasonCodes: Object.freeze(
        offer.surgeBasisPoints > FARE_MULTIPLIER_ONE ? ['PROVIDER_SURGE'] : [],
      ),
      components: offer.components,
    })
  }
  return own
}

export function createPrismaDeliveryFareService(
  prisma: PrismaClient,
  options: PrismaDeliveryFareOptions,
): DeliveryFareService {
  const timeoutMs = options.invocationTimeoutMs ?? DEFAULT_TIMEOUT_MS
  // `null` is a deliberate opt-out and `undefined` is "nobody said", which are
  // not the same: the first chose flat pricing, the second gets the documented
  // default.
  const dynamicPolicy =
    options.dynamicPolicy === null ? null : (options.dynamicPolicy ?? DEFAULT_DYNAMIC_FARE_POLICY)

  return {
    async offerFromProvider(tenantId, query, context, now) {
      const configuration = await withTenantRead(prisma, tenantId, (transaction) =>
        transaction.deliveryFareProviderConfiguration.findFirst({
          where: {
            tenantId,
            environment: options.environment,
            enabled: true,
            isDefault: true,
            healthStatus: 'HEALTHY',
          },
        }),
      ).catch(() => null)
      if (!configuration) return null

      let provider: DeliveryFareProvider
      try {
        provider = options.registry.resolve({
          providerCode: configuration.providerCode,
          adapterVersion: configuration.adapterVersion,
          adapterSpiVersion: configuration.adapterSpiVersion as DeliveryFareAdapterSpiVersion,
          environment: options.environment,
        })
      } catch {
        // A configuration naming an adapter this build does not carry.
        return null
      }

      const credential = await options.credentialResolver
        .resolve(configuration.credentialReference, tenantId, configuration.providerCode)
        .catch(() => null)
      if (!credential) return null

      try {
        const quoted = normalizeProviderFareQuote(
          await provider.quoteFare({
            origin: query.origin,
            destination: query.destination,
            profile: query.profile,
            distanceMetres: query.distanceMetres,
            durationSeconds: query.durationSeconds,
            itemCount: query.itemCount,
            requestedAt: now,
            timeoutMs,
            configuration: {
              id: configuration.id,
              tenantId,
              providerCode: configuration.providerCode,
              adapterVersion: configuration.adapterVersion,
              adapterSpiVersion: configuration.adapterSpiVersion as DeliveryFareAdapterSpiVersion,
              environment: options.environment,
              credentialReference: configuration.credentialReference,
            },
            credential,
          }),
          now,
        )
        return Object.freeze({
          amount: quoted.amount,
          providerCode: configuration.providerCode,
          providerReference: quoted.providerReference,
          expiresAt: quoted.expiresAt,
          surgeBasisPoints: quoted.surgeBasisPoints ?? FARE_MULTIPLIER_ONE,
          components: Object.freeze([...(quoted.components ?? [])]),
          quotedFor: Object.freeze({ ...context }),
        })
      } catch {
        // A refusal, a timeout, a malformed answer and an outage are the same
        // event to a customer at a checkout, and all four deserve the fallback
        // rather than an error page.
        return null
      } finally {
        credential.dispose()
      }
    },

    async ownFare(tenantId, input, now) {
      if (input.tariffAmount === 0n) return flatFare(0n)
      if (!dynamicPolicy) return flatFare(input.tariffAmount)

      // Read only when it can change the answer: two counts on the hot checkout
      // path is real cost for a tenant that has demand pricing switched off.
      const demand = dynamicPolicy.demandEnabled ? await readDemand(prisma, tenantId) : null

      const decision = dynamicFareMultiplier(
        dynamicPolicy,
        minuteOfLocalDay(now, input.timeZone),
        demand ?? undefined,
      )
      const { amount, uplift } = applyFareMultiplier(input.tariffAmount, decision)
      /**
       * `DYNAMIC` only when something actually moved it.
       *
       * The fare already varies with the journey — distance, vehicle, area,
       * load — and all of that happened in the tariff before this function saw
       * the number. Labelling an untouched tariff `DYNAMIC` would claim a
       * factor applied when none did, and since the customer-facing
       * explanation keys off the source, it would also promise an explanation
       * there is nothing to explain.
       */
      if (decision.basisPoints === FARE_MULTIPLIER_ONE) return flatFare(amount)
      return Object.freeze({
        amount,
        source: 'DYNAMIC' as const,
        providerCode: null,
        providerReference: null,
        expiresAt: new Date(now.getTime() + DYNAMIC_FARE_TTL_MS),
        multiplierBasisPoints: decision.basisPoints,
        reasonCodes: Object.freeze(decision.reasons.map((reason) => reason.code)),
        components: Object.freeze(
          uplift === 0n
            ? []
            : [
                { code: 'BASE', labelFa: 'کرایهٔ پایه', amount: input.tariffAmount },
                ...decision.reasons.map((reason) => ({
                  code: reason.code,
                  labelFa: reason.labelFa,
                  amount: uplift,
                })),
              ],
        ),
      })
    },
  }
}

/**
 * How busy the shop is right now.
 *
 * Work already promised and not yet at a door, against couriers on shift. Read
 * live rather than sampled on a schedule: a five-minute-old picture of a
 * breakfast rush is a picture of a different rush.
 */
async function readDemand(
  prisma: PrismaClient,
  tenantId: string,
): Promise<FareDemandSignal | null> {
  try {
    return await withTenantRead(prisma, tenantId, async (transaction) => {
      const [openOrders, availableCouriers] = await Promise.all([
        transaction.deliveryTask.count({
          where: {
            tenantId,
            // DELIVERED, FAILED and CANCELLED are finished work and say nothing
            // about how loaded the next hour is.
            state: {
              in: ['UNASSIGNED', 'ASSIGNMENT_PENDING', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY'],
            },
          },
        }),
        transaction.courier.count({ where: { tenantId, status: 'AVAILABLE' } }),
      ])
      return { openOrders, availableCouriers }
    })
  } catch {
    // A demand signal that cannot be read is not a reason to fail a checkout,
    // and not a reason to guess either: without it the multiplier falls back to
    // the time of day alone, which is the conservative direction.
    return null
  }
}

async function withTenantRead<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}

/**
 * The credential behind an `env://DELIVERY_FARE_…` reference.
 *
 * The prefix is enforced rather than suggested, for the same reason routing
 * enforces its own: without it a configuration row could name `DATABASE_URL`
 * and have its value handed to a third party's adapter.
 */
export function createEnvironmentDeliveryFareCredentialResolver(
  environment: Readonly<Record<string, string | undefined>>,
): DeliveryFareCredentialResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const match = /^env:\/(?:\/)?(DELIVERY_FARE_[A-Z0-9_]{1,120})$/.exec(reference)
      const value = match ? environment[match[1]!] : undefined
      if (!value || value.trim().length === 0) {
        throw new Error('DELIVERY_FARE_CREDENTIAL_UNAVAILABLE')
      }
      const material = Buffer.from(value.trim(), 'utf8')
      return { material, dispose: () => material.fill(0) }
    },
  })
}
