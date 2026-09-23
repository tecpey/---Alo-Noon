'use server'

import { revalidatePath } from 'next/cache'

import type {
  AddressSummary,
  OrderSummary,
  PlaceCandidate,
  QuoteSummary,
} from '@alo-noon/contracts'

import { derivedIdempotencyKey } from './admin-format'
import { customerErrorMessage } from './customer-errors'
import { normalizeMobile } from './shop-format'
import {
  createAddress,
  createPayment,
  createQuote,
  initializePayment,
  placeOrder,
  readCart,
  reverseGeocode,
  searchPlaces,
} from './shop-api'
import { resolveCheckoutCity } from './storefront-data'

/**
 * Checkout, as four writes that each mean something.
 *
 * A quote fixes a price against a cart version and an address; an order accepts
 * that quote; a payment is opened against that order; and initialising it asks
 * the gateway where to send the customer. They are separate because each can
 * fail differently and only some can be retried — collapsing them into one
 * "checkout" call would mean a customer whose gateway was briefly down losing
 * an order that was validly placed.
 *
 * Every idempotency key is derived from what makes the step unique rather than
 * generated fresh. A customer who double-taps "پرداخت" replays onto the same
 * order and the same payment instead of buying their bread twice, and a retry
 * after a dropped connection lands on the work already done.
 */

export interface CheckoutFailure {
  ok: false
  message: string
  /** True when trying the same thing again could plausibly work. */
  retryable: boolean
}

export type QuoteResult = { ok: true; quote: QuoteSummary } | CheckoutFailure
export type AddressResult = { ok: true; address: AddressSummary } | CheckoutFailure
export type PayResult =
  | { ok: true; kind: 'redirect'; url: string; order: OrderSummary }
  /** Paid from the balance. There is no bank to wait for and nothing to poll. */
  | { ok: true; kind: 'paid'; order: OrderSummary }
  /** The order exists and is placed, but the gateway would not open a payment. */
  | { ok: true; kind: 'unpaid'; order: OrderSummary; message: string }
  /** The balance does not cover it, and this is how much is missing. */
  | { ok: true; kind: 'short'; order: OrderSummary; shortfallRial: string }
  | CheckoutFailure

function fail(code: string, fallback: string, retryable = false): CheckoutFailure {
  return { ok: false, message: customerErrorMessage(code, fallback), retryable }
}

/**
 * Saves a new delivery address.
 *
 * The coordinates come from the browser's own geolocation rather than from
 * anything typed, because the delivery fare is measured from them and the API
 * decides serviceability by them. A house number a customer mistypes is a
 * wrong label; a coordinate they mistype is a courier sent to another town.
 */
export async function createAddressAction(input: {
  label: string
  recipientName: string
  recipientPhone: string
  addressLine: string
  latitude: number
  longitude: number
  deliveryInstructions?: string
}): Promise<AddressResult> {
  const recipientPhone = normalizeMobile(input.recipientPhone)
  if (!recipientPhone) {
    return { ok: false, message: 'شمارهٔ گیرنده معتبر نیست.', retryable: false }
  }
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    return { ok: false, message: 'موقعیت مکانی ثبت نشده است.', retryable: true }
  }

  const city = await resolveCheckoutCity()
  if (!city) return { ok: false, message: 'شهر انتخاب نشده است.', retryable: false }

  const result = await createAddress({
    cityId: city.id,
    label: input.label.trim() || 'خانه',
    recipientName: input.recipientName.trim(),
    recipientPhone,
    addressLine: input.addressLine.trim(),
    latitude: input.latitude,
    longitude: input.longitude,
    // Derived from the coordinates, so a resubmitted form returns the address
    // it already made rather than a second copy of the same house.
    idempotencyKey: derivedIdempotencyKey(
      'address',
      input.latitude.toFixed(6),
      input.longitude.toFixed(6),
      recipientPhone,
    ),
    ...(input.deliveryInstructions?.trim() && {
      deliveryInstructions: input.deliveryInstructions.trim(),
    }),
  })

  if (!result.ok) return fail(result.error.code, 'ثبت نشانی ناموفق بود.')
  revalidatePath('/checkout')
  return { ok: true, address: result.data }
}

/**
 * Prices the basket for one address.
 *
 * The cart version is quoted back so the API can refuse a price computed
 * against a basket that has since changed. A quote also expires, which is what
 * makes it safe to show a total at all: the price a customer sees is the price
 * they will be charged, for as long as the quote says.
 */
export async function quoteAction(
  deliveryAddressId: string,
  promotionCode?: string,
  deliveryWindowStartsAt?: string,
  deliveryVehicleProfile?: 'MOTORCYCLE' | 'CAR',
): Promise<QuoteResult> {
  const cart = await readCart()
  if (!cart.ok) return fail(cart.error.code, 'سبد خرید خوانده نشد.', true)
  if (!cart.data || cart.data.items.length === 0) {
    return { ok: false, message: 'سبد خرید خالی است.', retryable: false }
  }

  const result = await createQuote({
    deliveryAddressId,
    expectedCartVersion: cart.data.version,
    // The code is part of what makes this quote unique. Without it in the key,
    // adding a code to a basket already priced would replay the undiscounted
    // quote and the customer would watch their discount do nothing.
    idempotencyKey: derivedIdempotencyKey(
      'quote',
      cart.data.id,
      String(cart.data.version),
      deliveryAddressId,
      promotionCode ?? 'none',
      deliveryWindowStartsAt ?? 'asap',
      // Part of what makes the quote unique for the same reason the code is:
      // switching to a car changes the fare, and without this the customer
      // would be replayed the motorcycle price they had already been quoted.
      deliveryVehicleProfile ?? 'auto',
    ),
    ...(promotionCode && { promotionCode }),
    ...(deliveryWindowStartsAt && { deliveryWindowStartsAt }),
    ...(deliveryVehicleProfile && { deliveryVehicleProfile }),
  })
  if (!result.ok) {
    if (result.error.code === 'DELIVERY_VEHICLE_UNAVAILABLE') {
      return fail(
        result.error.code,
        'این وسیله برای این سفارش یا این نشانی قابل انتخاب نیست.',
        false,
      )
    }
    if (result.error.code === 'DELIVERY_VEHICLE_TARIFF_MISSING') {
      return fail(
        result.error.code,
        'این سفارش به خودرو نیاز دارد و هنوز نرخ ارسال با خودرو برای این شهر ثبت نشده است.',
        false,
      )
    }
    return fail(result.error.code, 'محاسبهٔ هزینه ناموفق بود.', true)
  }
  return { ok: true, quote: result.data }
}

/**
 * Accepts the quote, opens a payment, and asks the gateway where to send the
 * customer.
 *
 * The order is placed before the payment is opened, and that order survives a
 * gateway failure. Reporting "checkout failed" and dropping it would lose an
 * order the kitchen may already be able to see; instead the order comes back
 * unpaid and the customer is told they can pay it from their orders.
 */
export async function payAction(
  quoteId: string,
  source: 'GATEWAY' | 'BALANCE' = 'GATEWAY',
): Promise<PayResult> {
  const order = await placeOrder({
    quoteId,
    idempotencyKey: derivedIdempotencyKey('order', quoteId),
  })
  if (!order.ok) return fail(order.error.code, 'ثبت سفارش ناموفق بود.', true)
  revalidatePath('/orders')

  const payment = await createPayment({
    orderId: order.data.id,
    idempotencyKey: derivedIdempotencyKey('payment', order.data.id),
    source,
  })

  // A balance has no bank to wait for: the same call that opened the payment
  // captured it, so there is nothing to initialise and nothing to poll.
  if (source === 'BALANCE') {
    if (payment.ok) {
      revalidatePath('/wallet')
      return { ok: true, kind: 'paid', order: order.data }
    }
    const shortfall = shortfallFrom(payment.error.details)
    if (shortfall) {
      return { ok: true, kind: 'short', order: order.data, shortfallRial: shortfall }
    }
    return {
      ok: true,
      kind: 'unpaid',
      order: order.data,
      message: customerErrorMessage(payment.error.code, 'پرداخت از کیف پول انجام نشد.'),
    }
  }
  if (!payment.ok) {
    return {
      ok: true,
      kind: 'unpaid',
      order: order.data,
      message: customerErrorMessage(payment.error.code, 'سفارش ثبت شد اما پرداخت باز نشد.'),
    }
  }

  const execution = await initializePayment({
    paymentId: payment.data.id,
    idempotencyKey: derivedIdempotencyKey('initialize', payment.data.id),
  })
  if (!execution.ok) {
    return {
      ok: true,
      kind: 'unpaid',
      order: order.data,
      message: customerErrorMessage(execution.error.code, 'اتصال به درگاه برقرار نشد.'),
    }
  }

  const url = execution.data.customerAction?.url
  if (execution.data.state === 'CUSTOMER_ACTION_REQUIRED' && url) {
    return { ok: true, kind: 'redirect', url, order: order.data }
  }

  // The gateway answered without sending the customer anywhere. That is a
  // refusal, and its own code says more than "payment failed" would.
  return {
    ok: true,
    kind: 'unpaid',
    order: order.data,
    message: execution.data.failure
      ? customerErrorMessage(execution.data.failure.code, 'درگاه پرداخت را نپذیرفت.')
      : 'درگاه پرداخت در دسترس نیست. می‌توانید از بخش سفارش‌ها دوباره تلاش کنید.',
  }
}

/**
 * The missing amount inside a refusal, in Rial.
 *
 * Returned rather than phrased, because the caller shows it two ways: as a
 * sentence, and as the amount a top-up button pre-fills.
 */
function shortfallFrom(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null
  const shortfall = (details as Record<string, unknown>)['shortfall']
  if (!shortfall || typeof shortfall !== 'object') return null
  const amount = (shortfall as { amount?: unknown }).amount
  return typeof amount === 'string' && /^\d+$/.test(amount) ? amount : null
}

/**
 * Looking a place up by name, on behalf of the address form.
 *
 * A server action rather than a call from the browser, for the same reason
 * every other read here is: the session cookie is HTTP-only and the API origin
 * is not public. The city comes from the checkout session rather than the
 * caller, so a client cannot bias a search towards a city this tenant does not
 * serve.
 *
 * The three outcomes stay distinct all the way to the form, because each asks
 * something different of the customer: `unsupported` means stop offering search
 * (nothing they do will help), an empty list means try different words, and a
 * failure means try again shortly.
 */
export type PlaceSearchOutcome =
  | { state: 'results'; candidates: PlaceCandidate[] }
  | { state: 'unsupported' }
  | { state: 'failed'; message: string }

export async function searchPlacesAction(term: string): Promise<PlaceSearchOutcome> {
  const trimmed = term.trim()
  // The same floor the contract and the provider enforce. Checked here too so a
  // keystroke short of it never becomes a request at all.
  if (trimmed.length < 3) return { state: 'results', candidates: [] }

  const city = await resolveCheckoutCity()
  const result = await searchPlaces({
    term: trimmed,
    ...(city && { cityId: city.id }),
  })
  if (!result.ok) {
    return { state: 'failed', message: 'جست‌وجوی نشانی در دسترس نیست. کمی بعد دوباره تلاش کنید.' }
  }
  if (!result.data.available) return { state: 'unsupported' }
  return { state: 'results', candidates: result.data.candidates }
}

/**
 * What is at this point, for the customer to check before saving it.
 *
 * Returns null rather than a message on every failure: this is a convenience
 * shown beside a position the customer already has, and an error about it would
 * be an alarm about something that does not block them.
 */
export async function reverseGeocodeAction(
  latitude: number,
  longitude: number,
): Promise<string | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const result = await reverseGeocode({ latitude, longitude })
  return result.ok ? result.data.formattedAddress : null
}
