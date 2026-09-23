import {
  DELIVERY_FARE_ADAPTER_SPI_VERSION,
  type DeliveryFareProvider,
  type FareQuoteRequest,
  type ProviderFareQuote,
} from '@alo-noon/domain'

/**
 * Snapp Box (اسنپ‌باکس) delivery pricing.
 *
 * ## Where this contract comes from, and how far to trust it
 *
 * Snapp's own API documentation is at `api-docs.snapp-box.com`, which this
 * project could not reach. What it is built on instead is
 * `@snapp-store/snapp-box-sdk` on npm, which ships Snapp's own OpenAPI document
 * as `spec/api.yaml` and generates its client from it — so the paths, the field
 * names and the vocabulary below are Snapp's, read out of Snapp's specification
 * including its worked request and response examples.
 *
 * That is good evidence and it is not the vendor's own word: the package is
 * version 1.0.0, published in 2022, by an individual rather than by Snapp. So
 * the one thing left where being wrong would cost money — the unit — is a
 * constructor option, exactly as the Tapsi adapter beside this one treats its
 * own unknowns, and the operations guide requires the first real order to be
 * reconciled against a Snapp invoice before this provider is marked HEALTHY.
 *
 * The vocabulary is worth stating because none of it is guessable, and every
 * one of these was wrong on the first attempt at this adapter before the
 * specification's own example was read:
 *
 *     deliveryFarePaymentType   'prepaid'   (not 'SENDER'; 'cod' is the other)
 *     customerWalletType        'SNAPP_BOX'
 *     terminal.type             'pickup' / 'drop'   (lower case, and 'drop')
 *     terminal.paymentType      'prepaid'
 *     terminal.collectCash      'no'        (a string, not a boolean)
 *     city                      'tehran', 'mashhad', 'isfahan' — lower case
 *     deliveryCategory          'bike' / 'van'
 *
 * What the specification establishes:
 *
 *     POST https://customer.snapp-box.com/v1/customer/order/pricing
 *     Authorization: <the API key>
 *
 * with a body of `{ city, deliveryCategory, deliveryFarePaymentType, isReturn,
 * pricingId, sequenceNumberDeliveryCollection, totalFare, voucherCode,
 * waitingTime, customerWalletType, terminals[], id }`, each terminal carrying
 * `{ latitude, longitude, address, contactName, contactPhoneNumber, type,
 * sequenceNumber, … }` — and answering with `{ rateChartId, pricingConfigId,
 * distanceCharged, terminalsCharged, timeFactor, totalFare, pricingId }`.
 *
 * `pricingId` is the reference the order is later created against, which is
 * exactly what this SPI's `providerReference` is for.
 *
 * The staging origin is `customer-stg.snapp-box.com`.
 *
 * ## The header is not a Bearer token
 *
 * The generated client sets `Authorization` to the key verbatim — no `Bearer `
 * prefix. Worth stating because it is invisible when wrong: a prefixed key
 * comes back 401, which reads as a bad credential rather than as a bad header,
 * and an operator would spend the afternoon re-issuing a key that was fine.
 *
 * ## What is assumed, and what each assumption costs
 *
 * **The unit of `totalFare`.** Rial and Toman differ by ten and Iranian APIs
 * are split between them. A constructor option, defaulting to Rial, because
 * guessing silently is how an order gets charged ten times its fare.
 *
 * **`city` and `deliveryCategory`.** Typed as free strings, with the examples
 * above as the known vocabulary — and `GET /v2/delivery-category/by-city` lists
 * what a given account may actually use, which is the authority. Babol is not
 * among the three cities the specification names, so this cannot be a constant:
 * they are configuration, and a tenant that has not set them gets no quote and
 * falls back to our own tariff, which is correct and merely less competitive.
 *
 * **How long `pricingId` holds.** Undocumented, so `QUOTE_TTL_MS` is
 * deliberately short. Being wrong short costs a re-quote; being wrong long
 * would mean creating an order against a price Snapp no longer honours.
 *
 * ## Why a car is declined rather than quoted
 *
 * `deliveryCategory` is how Snapp is told what kind of vehicle to send, and
 * this adapter is configured with exactly one. Quoting a motorcycle's fare for
 * an order that needs a car would be discovered by a courier at a factory gate
 * with a fifth of the load, so a car request is refused here and our own car
 * tariff prices it. The same decision the Tapsi adapter makes, for the same
 * reason.
 */

const DEFAULT_ORIGIN = 'https://customer.snapp-box.com'

/**
 * How long a quoted fare is treated as held.
 *
 * Not from the specification, which does not say. Five minutes is about as long
 * as a customer takes to read a basket and pay, and short enough that an expired
 * assumption shows up as a re-quote rather than as an order refused at creation.
 */
const QUOTE_TTL_MS = 5 * 60_000

export interface SnappBoxOptions {
  /** Overridable so the adapter can be pointed at staging or at a stand-in. */
  readonly endpointOrigin?: string
  /**
   * What `totalFare` is denominated in. Rial keeps it in the ledger's own unit;
   * Toman multiplies by ten on the way in, because everything past this
   * boundary is Rial.
   */
  readonly amountUnit?: 'RIAL' | 'TOMAN'
  /**
   * The city and vehicle class in Snapp's own vocabulary, which only Snapp
   * defines. Without them there is no quote — see the note above on why that is
   * the right failure.
   */
  readonly city?: string
  readonly deliveryCategory?: string
}

export function createSnappBoxAdapter(options: SnappBoxOptions = {}): DeliveryFareProvider {
  const origin = (options.endpointOrigin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  const amountUnit = options.amountUnit ?? 'RIAL'

  return {
    code: 'SNAPP_BOX',
    adapterVersion: '1.0.0',
    spiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,

    async quoteFare(request: FareQuoteRequest): Promise<ProviderFareQuote> {
      if (request.profile !== 'MOTORCYCLE') {
        throw new Error('SNAPP_BOX_VEHICLE_UNSUPPORTED')
      }
      if (!options.city || !options.deliveryCategory) {
        throw new Error('SNAPP_BOX_CATEGORY_NOT_CONFIGURED')
      }

      const apiKey = Buffer.from(request.credential.material).toString('utf8').trim()
      if (!apiKey) throw new Error('SNAPP_BOX_CREDENTIAL_MALFORMED')

      const response = await fetch(`${origin}/v1/customer/order/pricing`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Verbatim. See the note above: a `Bearer ` prefix here fails as a
          // 401 that looks like a bad key.
          Authorization: apiKey,
        },
        body: JSON.stringify({
          city: options.city,
          deliveryCategory: options.deliveryCategory,
          // 'prepaid', Snapp's word for "billed to the account", against 'cod'
          // for "the courier collects it at the door". The customer pays us and
          // we pay Snapp; cash on delivery does not exist in this product at
          // all, so 'cod' is not reachable from here.
          deliveryFarePaymentType: 'prepaid',
          isReturn: false,
          pricingId: null,
          sequenceNumberDeliveryCollection: 1,
          totalFare: null,
          voucherCode: null,
          waitingTime: 0,
          customerWalletType: 'SNAPP_BOX',
          id: null,
          terminals: [
            // Sequence numbers count every stop in order, pickups first — so
            // the bakery is 1 and the doorstep is 2.
            terminal(1, 'pickup', request.origin),
            terminal(2, 'drop', request.destination),
          ],
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      })
      if (!response.ok) throw new Error(`SNAPP_BOX_HTTP_${response.status}`)

      const body: unknown = await response.json()
      const pricingId = readString(body, 'pricingId')
      const totalFare = readInteger(body, 'totalFare')
      // Read defensively, like the adapter beside it: a shape surprise must
      // cost a fallback to our own tariff, never a confidently wrong fare.
      if (!pricingId || totalFare === null) throw new Error('SNAPP_BOX_UNREADABLE_PRICE')

      const rial = toRial(totalFare, amountUnit)
      if (rial < 0n) throw new Error('SNAPP_BOX_NEGATIVE_FARE')

      return {
        amount: rial,
        currency: 'IRR',
        expiresAt: new Date(request.requestedAt.getTime() + QUOTE_TTL_MS),
        providerReference: pricingId,
        // Snapp itemises the charge as factors rather than as money —
        // `distanceCharged`, `terminalsCharged`, `timeFactor` — which are
        // inputs to its own rate chart and not amounts. Presenting them as
        // Rial components would be printing a multiplier as a price, so this
        // returns none rather than inventing a breakdown.
        components: [],
      }
    },
  }
}

/** One end of the journey, in the shape `POST /v1/customer/order/pricing` takes. */
function terminal(
  sequenceNumber: number,
  type: 'pickup' | 'drop',
  at: { latitude: number; longitude: number },
) {
  return {
    id: null,
    latitude: at.latitude,
    longitude: at.longitude,
    type,
    sequenceNumber,
    // Pricing is worked out from the coordinates; the contact and address
    // fields belong to order creation, and sending real customer details to
    // price a basket would be handing over a name and a phone number for a
    // delivery that may never be ordered.
    address: '',
    contactName: '',
    contactPhoneNumber: '',
    plate: '',
    unit: '',
    comment: '',
    // A string, and Snapp's own example spells it 'no' rather than 'false'.
    collectCash: 'no',
    paymentType: 'prepaid',
    cashOnPickup: 0,
    cashOnDelivery: 0,
    isHub: null,
    vendorId: null,
  }
}

function toRial(amount: bigint, unit: 'RIAL' | 'TOMAN'): bigint {
  return unit === 'TOMAN' ? amount * 10n : amount
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : null
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
