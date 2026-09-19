import {
  DELIVERY_FARE_ADAPTER_SPI_VERSION,
  type DeliveryFareProvider,
  type FareComponent,
  type FareQuoteRequest,
  type ProviderFareQuote,
} from '@alo-noon/domain'

/**
 * Tapsi Pack (تپسی پک) delivery pricing, built on its published contract.
 *
 * Verified against the official specification at
 * `github.com/tapsi-delivery/api-doc` — `apis/external-services-swagger.yaml`
 * and `authorization/api-secret-key/README.md`. What those establish, and what
 * this adapter rests on:
 *
 *     GET https://api.tapsi.cab/api/v1/delivery/external/embedded/order/preview
 *         ?originLat=&originLong=&destinationLat=&destinationLong=
 *         &dateTimestamp=[&couponCode=]
 *     x-api-secret-key:   <the account's secret key>
 *     x-encoded-user-id:  <the numeric user id, base64>
 *
 * answering with a `token` and `invoicePerTimeslots[]`, each carrying
 * `timeslotId`, `startTimestamp`, `endTimestamp`, `isAvailable` and an
 * `invoice` of `{ discount, amount, paymentInAdvance, descriptions[] }`. The
 * `token` is what `POST …/order/submit` requires, which is exactly the
 * "reference the booking is later made against" this SPI is built around.
 *
 * ## Three things the specification does not say
 *
 * It is archived and incomplete, so these are stated assumptions rather than
 * facts, each made safe to be wrong about:
 *
 * **The unit of `amount`.** Rial and Toman differ by ten, and Iranian APIs are
 * split between them. Guessing silently is how an order gets charged ten times
 * its fare, so the unit is a constructor option rather than a constant, and the
 * operations guide requires the first real order to be reconciled against the
 * Tapsi invoice before this is trusted.
 *
 * **The unit of `dateTimestamp`.** Same treatment. Being wrong here costs a
 * preview with no available timeslot, which falls back to our own tariff — an
 * annoyance rather than a mispriced order.
 *
 * **How long a preview token holds.** Undocumented, so `QUOTE_TTL_MS` below is
 * deliberately short. Being wrong short costs a re-quote; being wrong long
 * would mean submitting against a price Tapsi no longer honours.
 *
 * ## Why a car is declined rather than quoted
 *
 * The documented preview takes no vehicle parameter, so there is no way to tell
 * Tapsi that this order needs a car — the price that comes back is for whatever
 * Tapsi would send. Returning it for an order that needs a car would quote a
 * motorcycle's fare for a car's job, and the person who discovers the mistake
 * is a courier at a factory gate with a fifth of the order. So a car request is
 * refused here and our own car tariff prices it, which is correct and merely
 * less competitive.
 */

const DEFAULT_ORIGIN = 'https://api.tapsi.cab'

/**
 * How long a quoted fare is treated as held.
 *
 * Not from the specification, which does not say. Five minutes is about as long
 * as a customer takes to read a basket and pay, and short enough that an
 * expired assumption shows up as a re-quote rather than as a submit refused at
 * the counter.
 */
const QUOTE_TTL_MS = 5 * 60_000

export interface TapsiPackOptions {
  /** Overridable so the adapter can be pointed at a stand-in. Never in production. */
  readonly endpointOrigin?: string
  /**
   * What `invoice.amount` is denominated in. Rial keeps it in the ledger's own
   * unit; Toman multiplies by ten on the way in, because everything past this
   * boundary is Rial.
   */
  readonly amountUnit?: 'RIAL' | 'TOMAN'
  /** What `dateTimestamp` expects. */
  readonly timestampUnit?: 'MILLISECONDS' | 'SECONDS'
}

export function createTapsiPackAdapter(options: TapsiPackOptions = {}): DeliveryFareProvider {
  const origin = (options.endpointOrigin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  const amountUnit = options.amountUnit ?? 'RIAL'
  const timestampUnit = options.timestampUnit ?? 'MILLISECONDS'

  return {
    code: 'TAPSI_PACK',
    adapterVersion: '1.0.0',
    spiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,

    async quoteFare(request: FareQuoteRequest): Promise<ProviderFareQuote> {
      if (request.profile !== 'MOTORCYCLE') {
        throw new Error('TAPSI_PACK_VEHICLE_UNSUPPORTED')
      }

      const credential = readCredential(request.credential.material)
      const url = new URL(`${origin}/api/v1/delivery/external/embedded/order/preview`)
      url.searchParams.set('originLat', String(request.origin.latitude))
      url.searchParams.set('originLong', String(request.origin.longitude))
      url.searchParams.set('destinationLat', String(request.destination.latitude))
      url.searchParams.set('destinationLong', String(request.destination.longitude))
      url.searchParams.set(
        'dateTimestamp',
        String(
          timestampUnit === 'SECONDS'
            ? Math.floor(request.requestedAt.getTime() / 1000)
            : request.requestedAt.getTime(),
        ),
      )

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-secret-key': credential.secretKey,
          // Base64 of the numeric id, exactly as the authorization document
          // specifies: user 123 is sent as "MTIz".
          'x-encoded-user-id': Buffer.from(credential.userId, 'utf8').toString('base64'),
        },
        signal: AbortSignal.timeout(request.timeoutMs),
      })
      if (!response.ok) throw new Error(`TAPSI_PACK_HTTP_${response.status}`)

      const body: unknown = await response.json()
      const token = readString(body, 'token')
      if (!token) throw new Error('TAPSI_PACK_NO_TOKEN')

      const slot = firstAvailableSlot(body)
      if (!slot) throw new Error('TAPSI_PACK_NO_AVAILABLE_TIMESLOT')

      /**
       * What we actually owe, which is the total less the discount.
       *
       * Not `amount`, which would pass on a discount Tapsi gave us as though it
       * were the customer's cost. Not `paymentInAdvance` either — that subtracts
       * the account credit as well, and credit is money already paid rather than
       * money saved, so charging on it would undercharge by whatever the wallet
       * happened to hold that morning.
       */
      const rial = toRial(slot.amount - slot.discount, amountUnit)
      if (rial < 0n) throw new Error('TAPSI_PACK_NEGATIVE_FARE')

      return {
        amount: rial,
        currency: 'IRR',
        expiresAt: new Date(request.requestedAt.getTime() + QUOTE_TTL_MS),
        // Both halves, because submitting needs both and the SPI carries one
        // string. The timeslot id leads so a token containing a colon still
        // splits correctly on the first one.
        providerReference: `${slot.timeslotId}:${token}`,
        components: slot.components.map((component) => ({
          ...component,
          amount: toRial(component.amount, amountUnit),
        })),
      }
    },
  }
}

/**
 * The two halves of a Tapsi credential, out of one stored secret.
 *
 * JSON rather than two environment variables, matching how the payment adapters
 * store a multi-field credential: one reference on the configuration row means
 * one thing to rotate, and a half-rotated credential is not a state this can
 * end up in.
 */
function readCredential(material: Uint8Array): { secretKey: string; userId: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(material).toString('utf8'))
  } catch {
    throw new Error('TAPSI_PACK_CREDENTIAL_MALFORMED')
  }
  const secretKey = readString(parsed, 'secretKey')
  const userId = readString(parsed, 'userId')
  if (!secretKey || !userId) throw new Error('TAPSI_PACK_CREDENTIAL_INCOMPLETE')
  return { secretKey, userId }
}

interface PricedSlot {
  readonly timeslotId: string
  readonly amount: bigint
  readonly discount: bigint
  readonly components: readonly FareComponent[]
}

/**
 * The soonest timeslot that can actually be booked, with its invoice.
 *
 * Read defensively, like the routing adapter beside it and for the same reason:
 * the specification is archived and its examples are thin, so a shape surprise
 * must cost a fallback to our own tariff rather than a confidently wrong fare.
 * Anything that does not parse cleanly is treated as no answer at all.
 */
function firstAvailableSlot(body: unknown): PricedSlot | null {
  const slots = readArray(body, 'invoicePerTimeslots')
  for (const slot of slots) {
    if (readBoolean(slot, 'isAvailable') !== true) continue
    const timeslotId = readString(slot, 'timeslotId')
    const invoice = readRecord(slot, 'invoice')
    if (!timeslotId || !invoice) continue
    const amount = readInteger(invoice, 'amount')
    if (amount === null) continue
    return {
      timeslotId,
      amount,
      discount: readInteger(invoice, 'discount') ?? 0n,
      components: readComponents(invoice),
    }
  }
  return null
}

/**
 * The line items Tapsi itemised, in its own words.
 *
 * `title` is already Persian and already customer-facing, which is why it maps
 * straight onto the component label rather than being translated: Tapsi naming
 * its own surcharge is more accurate than us guessing at what it was for.
 */
function readComponents(invoice: Record<string, unknown>): readonly FareComponent[] {
  const components: FareComponent[] = []
  for (const entry of readArray(invoice, 'descriptions')) {
    const title = readString(entry, 'title')
    const amount = readInteger(entry, 'amount')
    if (!title || amount === null) continue
    components.push({ code: 'PROVIDER_LINE', labelFa: title.slice(0, 120), amount })
  }
  return components
}

function toRial(amount: bigint, unit: 'RIAL' | 'TOMAN'): bigint {
  return unit === 'TOMAN' ? amount * 10n : amount
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const nested = value[key]
  return isRecord(nested) ? nested : null
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : null
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'boolean' ? field : null
}

/**
 * An integer amount, refusing anything that is not exactly one.
 *
 * A float here would mean rounding somebody else's money on our side, and a
 * numeric string would mean guessing at its separators. Both come back as null,
 * which the caller treats as no answer.
 */
function readInteger(value: unknown, key: string): bigint | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'number' && Number.isSafeInteger(field) ? BigInt(field) : null
}

function readArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return []
  const field = value[key]
  return Array.isArray(field) ? field : []
}

/**
 * The two halves back out of a stored reference, for whoever submits the order.
 *
 * Split on the first colon only: a timeslot id is a simple token and a session
 * token is not guaranteed to be, so the ambiguity is resolved in the direction
 * that cannot corrupt the token.
 */
export function parseTapsiPackReference(
  reference: string,
): { timeslotId: string; token: string } | null {
  const separator = reference.indexOf(':')
  if (separator <= 0 || separator === reference.length - 1) return null
  return {
    timeslotId: reference.slice(0, separator),
    token: reference.slice(separator + 1),
  }
}
