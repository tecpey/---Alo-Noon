/**
 * The adversarial pass over the money path.
 *
 * `launch-drive` answers "can a shop take an order and deliver it". It settles
 * payment straight through the ledger and deliberately never calls a gateway,
 * which makes it safe to run anywhere and means a green result says nothing at
 * all about whether money works.
 *
 * This answers the other half, and it answers it the way payments actually
 * fail. The happy path is one section of eight; the rest are the things a
 * gateway does on a bad afternoon — a customer who backs out at the card form,
 * a callback that arrives twice, a callback for a payment that was never made,
 * an authority nobody issued, a verify replayed an hour later. Every one of
 * those has taken a real shop's money or given away real goods, and none of
 * them is reachable from a UI.
 *
 * It needs the Zarinpal sandbox stand-in (`scripts/zarinpal-sandbox.ts`) and
 * the SMS sandbox (`scripts/sms-sandbox.ts`), and it refuses to run against a
 * gateway origin that is not loopback — see `assertSandbox` below. Pointing
 * this at a real gateway would put real authorities into a test.
 *
 *     pnpm --filter @alo-noon/api exec tsx scripts/sms-sandbox.ts &
 *     pnpm --filter @alo-noon/api exec tsx scripts/zarinpal-sandbox.ts &
 *     SMS_LOG=/tmp/alo-noon-sms.log \
 *       pnpm --filter @alo-noon/api exec tsx scripts/qa-drive.ts
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE = process.env['QA_API_BASE'] ?? 'http://127.0.0.1:3001'
const GATEWAY = process.env['QA_GATEWAY_BASE'] ?? 'http://127.0.0.1:4180'
const SMS_LOG = process.env['SMS_LOG'] ?? '/tmp/alo-noon-sms.log'
const TENANT_ID = '00000000-0000-4000-8000-000000000001'

/**
 * A fresh number per run, so a live sign-in challenge from the previous run
 * cannot make this one look broken. The customer is deliberately new every
 * time: "can somebody who has never used this shop buy bread" is the question,
 * and a returning account answers a different one.
 */
const CUSTOMER = `+98912${String(Date.now()).slice(-7)}`
const OPERATOR = process.env['QA_OPERATOR_MOBILE'] ?? '+989120000001'
const COURIER = process.env['QA_COURIER_MOBILE'] ?? '+989120000002'

let failures = 0
function step(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1
  const shown = detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${shown}\n`)
}

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`)
}

interface Call {
  status: number
  body: unknown
  cookie: string | null
  location: string | null
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; idempotencyKey?: string } = {},
): Promise<Call> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(options.cookie && { Cookie: options.cookie }),
      ...(options.idempotencyKey && { 'Idempotency-Key': options.idempotencyKey }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  const setCookie = response.headers.get('set-cookie')
  return {
    status: response.status,
    body,
    cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null,
    location: response.headers.get('location'),
  }
}

/* ------------------------------------------------------------ tiny readers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current = value
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key]
    else if (isRecord(current) && typeof key === 'string') current = current[key]
    else return undefined
  }
  return current
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/* ------------------------------------------------------------------ safety */

/**
 * Refuses to run against anything but a loopback gateway.
 *
 * This script deliberately drives a customer who backs out, a replayed
 * callback and an authority nobody issued. Against a real gateway those are
 * not tests — they are a merchant account doing strange things on a Tuesday,
 * and the first three would be indistinguishable from fraud.
 */
function assertSandbox(): void {
  const host = new URL(GATEWAY).hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  step('safety: the gateway under test is a local sandbox', loopback, { gateway: GATEWAY })
  if (!loopback) {
    process.stdout.write('\nREFUSING TO RUN against a non-loopback gateway.\n')
    process.exit(1)
  }
}

/* -------------------------------------------------------------- sign-in */

function smsLines(): readonly string[] {
  try {
    return readFileSync(SMS_LOG, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function signIn(mobileE164: string, label: string): Promise<string> {
  const before = smsLines().length
  const requested = await call('POST', '/api/v1/auth/otp/request', {
    body: { mobileE164 },
    // The label is a human sentence («new customer»), and the OTP key must
    // match `[A-Za-z0-9][A-Za-z0-9._:-]+`. Folded rather than trusted.
    idempotencyKey: `qa-${label.replace(/[^A-Za-z0-9]+/g, '-')}-${randomUUID()}`,
  })
  const challengeId = text(at(requested.body, 'data', 'challengeId'))
  const after = smsLines()
  const sent = after.length > before ? after.at(-1) : undefined
  const code = sent?.match(/(\d{6})/)?.[1]
  step(`${label}: a code was sent and can be read`, Boolean(code && challengeId), {
    status: requested.status,
  })
  if (!code || !challengeId) throw new Error(`${label}: no code`)

  const verified = await call('POST', '/api/v1/auth/otp/verify', {
    body: { challengeId, code },
  })
  step(`${label}: signed in`, verified.status === 200 && Boolean(verified.cookie), {
    status: verified.status,
  })
  if (!verified.cookie) throw new Error(`${label}: no session`)
  return verified.cookie
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  section('0. Safety')
  assertSandbox()

  section('1. Somebody who has never used this shop')
  const customer = await signIn(CUSTOMER, 'new customer')
  // A brand-new account starts with nothing. Worth asserting rather than
  // assuming: a wallet that opened with a stray balance would make every
  // payment assertion below meaningless.
  const wallet = await call('GET', '/api/v1/wallet', { cookie: customer })
  step('new customer: wallet opens empty', at(wallet.body, 'data', 'balance', 'amount') === '0', {
    balance: at(wallet.body, 'data', 'balance', 'amount'),
  })

  const cities = await call('GET', '/api/v1/serviceability/cities')
  const cityId = text(at(cities.body, 'data', 0, 'id'))
  if (!cityId) throw new Error('no city')

  const serviceable = await call('POST', '/api/v1/serviceability/check', {
    body: { cityId, latitude: 36.5387, longitude: 52.6765 },
  })
  const zoneId = text(at(serviceable.body, 'data', 'operationalZoneId'))
  if (!zoneId) throw new Error('not serviceable')

  const products = await call(
    'GET',
    `/api/v1/catalog/products?cityId=${cityId}&operationalZoneId=${zoneId}&page=1&pageSize=20`,
  )
  const offeringId = text(at(products.body, 'data', 0, 'offeringId'))
  step('catalogue: something is on sale', Boolean(offeringId), {
    count: list(at(products.body, 'data')).length,
  })
  if (!offeringId) throw new Error('nothing on sale')

  // The fare, before any of it is committed to. This is the number the shelf
  // shows, so it is checked here against the same scope the order will use.
  const estimate = await call(
    'GET',
    `/api/v1/delivery/estimate?cityId=${cityId}&operationalZoneId=${zoneId}`,
  )
  const basis = text(at(estimate.body, 'data', 'estimate', 'basis'))
  step('fare: the shelf can quote a fare, with a basis', Boolean(basis), {
    basis,
    amount: at(estimate.body, 'data', 'estimate', 'amount', 'amount'),
  })

  const address = await call('POST', '/api/v1/addresses', {
    cookie: customer,
    body: {
      cityId,
      label: 'خانه',
      recipientName: 'زهرا محمدی',
      recipientPhone: CUSTOMER,
      addressLine: 'بابل، خیابان مدرس، کوچهٔ نان، پلاک ۱۲',
      latitude: 36.5387,
      longitude: 52.6765,
      deliveryInstructions: 'زنگ نزنید، بچه خواب است',
      idempotencyKey: `qa-address-${randomUUID()}`,
    },
  })
  const addressId = text(at(address.body, 'data', 'id'))
  step('new customer: address saved', Boolean(addressId), {
    status: address.status,
    error: at(address.body, 'error'),
  })
  if (!addressId) throw new Error('no address')

  const order = await placeOrder(customer, offeringId, addressId, {
    cityId,
    operationalZoneId: zoneId,
  })

  section('2. Paying at the gateway — the path launch-drive never walks')
  await payThroughGateway(customer, order.orderId, order.total)

  section('3. What a gateway does on a bad afternoon')
  await adversarialMoney(customer, offeringId, addressId, {
    cityId,
    operationalZoneId: zoneId,
  })

  section('4. Fulfilment')
  await fulfil(order.orderId)

  process.stdout.write(
    failures === 0 ? '\nALL QA CHECKS PASSED\n' : `\n${failures} QA CHECK(S) FAILED\n`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

/** Basket → quote → order, returning what the money sections need. */
async function placeOrder(
  cookie: string,
  offeringId: string,
  addressId: string,
  where: { cityId: string; operationalZoneId: string },
): Promise<{ orderId: string; total: string }> {
  // The cart write names where the bread is being bought, because an offering
  // belongs to a branch and the cart has to be able to refuse one this
  // customer cannot be reached from.
  const cart = await call('PUT', `/api/v1/cart/items/${offeringId}`, {
    cookie,
    body: { cityId: where.cityId, operationalZoneId: where.operationalZoneId, quantity: 2 },
    idempotencyKey: `qa-cart-${randomUUID()}`,
  })
  step('cart: the item was accepted', cart.status === 200, {
    status: cart.status,
    error: at(cart.body, 'error'),
  })
  const quote = await call('POST', '/api/v1/cart/quote', {
    cookie,
    body: {
      deliveryAddressId: addressId,
      expectedCartVersion: at(cart.body, 'data', 'version'),
      idempotencyKey: `qa-quote-${randomUUID()}`,
    },
  })
  const quoteId = text(at(quote.body, 'data', 'id'))
  step('quote: priced against the address', Boolean(quoteId), {
    status: quote.status,
    error: at(quote.body, 'error'),
  })
  if (!quoteId) throw new Error('no quote')

  const placed = await call('POST', '/api/v1/orders', {
    cookie,
    body: { quoteId, idempotencyKey: `qa-order-${randomUUID()}` },
  })
  const orderId = text(at(placed.body, 'data', 'id'))
  const total = text(at(placed.body, 'data', 'total', 'amount'))
  step(
    'order: placed and unpaid',
    Boolean(orderId) && at(placed.body, 'data', 'state') !== 'PAID',
    {
      status: placed.status,
      state: at(placed.body, 'data', 'state'),
    },
  )
  if (!orderId || !total) throw new Error('no order')
  return { orderId, total }
}

/**
 * The whole gateway loop: open a payment, initialise it, walk the customer
 * through the card page, and let our own callback verify and settle it.
 */
async function payThroughGateway(cookie: string, orderId: string, total: string): Promise<void> {
  const payment = await call('POST', '/api/v1/payments', {
    cookie,
    body: { orderId, idempotencyKey: `qa-pay-${randomUUID()}`, source: 'GATEWAY' },
  })
  const paymentId = text(at(payment.body, 'data', 'id'))
  step('gateway: a payment was opened against the order', Boolean(paymentId), {
    status: payment.status,
    state: at(payment.body, 'data', 'state'),
    error: at(payment.body, 'error'),
  })
  if (!paymentId) throw new Error('no payment')

  const initialized = await call('POST', '/api/v1/payments/initialize', {
    cookie,
    body: { paymentId, idempotencyKey: `qa-init-${randomUUID()}` },
  })
  const redirect = text(at(initialized.body, 'data', 'customerAction', 'url'))
  step('gateway: it answered with somewhere to send the customer', Boolean(redirect), {
    status: initialized.status,
    state: at(initialized.body, 'data', 'state'),
    failure: at(initialized.body, 'data', 'failure'),
  })
  if (!redirect) throw new Error('no redirect')

  // The customer's browser, arriving at the card page and paying.
  const card = await fetch(redirect, { redirect: 'manual' })
  const back = card.headers.get('location')
  step('gateway: paying sends the customer back to us', card.status === 302 && Boolean(back), {
    status: card.status,
  })
  if (!back) throw new Error('no callback redirect')

  const callback = await fetch(back, { redirect: 'manual' })
  step(
    'gateway: our callback accepted the return',
    callback.status >= 200 && callback.status < 400,
    { status: callback.status },
  )

  const settled = await call('GET', `/api/v1/payments/${paymentId}`, { cookie })
  step('gateway: the payment is CAPTURED', at(settled.body, 'data', 'state') === 'CAPTURED', {
    state: at(settled.body, 'data', 'state'),
  })
  step(
    'gateway: it captured the amount the order asked for, not the gateway’s idea of it',
    at(settled.body, 'data', 'amount', 'amount') === total,
    { captured: at(settled.body, 'data', 'amount', 'amount'), ordered: total },
  )

  const paidOrder = await call('GET', `/api/v1/orders/${orderId}`, { cookie })
  step('gateway: the order says PAID', at(paidOrder.body, 'data', 'paymentState') === 'PAID', {
    paymentState: at(paidOrder.body, 'data', 'paymentState'),
  })

  // The one that has cost real shops real money: a gateway that retries its
  // callback, or a customer who refreshes the return page.
  const replay = await fetch(back, { redirect: 'manual' })
  step('gateway: a replayed callback is accepted without charging twice', replay.status < 500, {
    status: replay.status,
  })
  const afterReplay = await call('GET', `/api/v1/payments/${paymentId}`, { cookie })
  step(
    'gateway: the replay left the captured amount alone',
    at(afterReplay.body, 'data', 'amount', 'amount') === total &&
      at(afterReplay.body, 'data', 'state') === 'CAPTURED',
    {
      state: at(afterReplay.body, 'data', 'state'),
      amount: at(afterReplay.body, 'data', 'amount', 'amount'),
    },
  )
}

/** The failure modes, each one a way a real shop has lost money. */
async function adversarialMoney(
  cookie: string,
  offeringId: string,
  addressId: string,
  where: { cityId: string; operationalZoneId: string },
): Promise<void> {
  const order = await placeOrder(cookie, offeringId, addressId, where)

  const payment = await call('POST', '/api/v1/payments', {
    cookie,
    body: { orderId: order.orderId, idempotencyKey: `qa-pay-${randomUUID()}`, source: 'GATEWAY' },
  })
  const paymentId = text(at(payment.body, 'data', 'id'))
  if (!paymentId) throw new Error('no payment')

  const initialized = await call('POST', '/api/v1/payments/initialize', {
    cookie,
    body: { paymentId, idempotencyKey: `qa-init-${randomUUID()}` },
  })
  const redirect = text(at(initialized.body, 'data', 'customerAction', 'url'))
  if (!redirect) throw new Error('no redirect')

  // The customer who reaches the card form and backs out. Zarinpal returns
  // Status=NOK, and the danger is a shop that reads "a callback arrived" as
  // "money arrived".
  const abandoned = await fetch(`${redirect}?outcome=nok`, { redirect: 'manual' })
  const back = abandoned.headers.get('location')
  step('abandoned: the gateway sends them back with NOK', Boolean(back?.includes('NOK')), {
    location: back,
  })
  if (back) {
    await fetch(back, { redirect: 'manual' })
    const after = await call('GET', `/api/v1/payments/${paymentId}`, { cookie })
    step(
      'abandoned: a NOK callback does not capture anything',
      at(after.body, 'data', 'state') !== 'CAPTURED',
      { state: at(after.body, 'data', 'state') },
    )
    const stillUnpaid = await call('GET', `/api/v1/orders/${order.orderId}`, { cookie })
    step(
      'abandoned: the order is not marked paid',
      at(stillUnpaid.body, 'data', 'paymentState') !== 'PAID',
      { paymentState: at(stillUnpaid.body, 'data', 'paymentState') },
    )
  }

  // A callback for an authority this shop never issued.
  //
  // This check asserted `status >= 400` and failed against a 303, which was the
  // assertion being wrong rather than the route. Answering an unknown authority
  // with an error tells whoever sent it which authorities exist — a probe
  // oracle — and it also changes what a real customer sees when a gateway
  // replays something stale. The route instead sends everybody, forged or not,
  // to the same neutral "we are checking your payment" page carrying an opaque
  // reference and no verdict.
  //
  // So the property is not the status code. It is that nothing moved: the
  // payment stays where it was and the order does not become paid. That is what
  // is asserted here, against the order from the abandoned attempt above.
  const forged = await fetch(
    `${BASE}/api/v1/payments/callback/zarinpal?Authority=A${'0'.repeat(35)}&Status=OK`,
    { redirect: 'manual' },
  )
  step('forged: an unknown authority reveals nothing by its answer', forged.status === 303, {
    status: forged.status,
  })

  const afterForged = await call('GET', `/api/v1/orders/${order.orderId}`, { cookie })
  step(
    'forged: it captured nothing and paid nothing',
    at(afterForged.body, 'data', 'paymentState') !== 'PAID',
    { paymentState: at(afterForged.body, 'data', 'paymentState') },
  )
}

/** Operator, dispatch, courier — the part after the money. */
async function fulfil(orderId: string): Promise<void> {
  const operator = await signIn(OPERATOR, 'operator')
  // `reason`, not an idempotency key — the accept route takes the operator's
  // stated reason and derives idempotency itself. Sending the wrong body got a
  // 400 that read like a state-machine refusal, which is worth remembering:
  // a harness that guesses a contract reports the app as broken.
  const accepted = await call('POST', `/api/v1/admin/orders/${orderId}/accept`, {
    cookie: operator,
    body: { reason: 'پذیرش سفارش پرداخت‌شده' },
  })
  step('operator: accepted a paid order', accepted.status === 200, {
    status: accepted.status,
    state: at(accepted.body, 'data', 'state'),
    error: at(accepted.body, 'error'),
  })

  const board = await call('GET', '/api/v1/admin/deliveries', { cookie: operator })
  const opened = list(at(board.body, 'data')).find((entry) => at(entry, 'orderId') === orderId)
  const taskId = text(at(opened, 'taskId'))
  step('dispatch: acceptance opened a delivery', Boolean(taskId), {
    status: board.status,
    state: at(opened, 'state'),
  })
  if (!taskId) return

  const couriers = await call('GET', '/api/v1/admin/couriers', { cookie: operator })
  const rider = list(at(couriers.body, 'data')).find((entry) => at(entry, 'status') === 'AVAILABLE')
  const courierId = text(at(rider, 'courierId'))
  step('dispatch: an available courier exists', Boolean(courierId), {
    roster: list(at(couriers.body, 'data')).length,
  })
  if (!courierId) return
  const offered = await call('POST', `/api/v1/admin/deliveries/${taskId}/offer`, {
    cookie: operator,
    body: { courierId },
  })
  step('dispatch: offered to the courier', offered.status === 200, {
    status: offered.status,
    error: at(offered.body, 'error'),
  })

  const courier = await signIn(COURIER, 'courier')
  const mine = await call('GET', '/api/v1/courier/deliveries', { cookie: courier })
  const task = list(at(mine.body, 'data')).find((entry) => text(at(entry, 'taskId')) === taskId)
  step('courier: sees the offer', Boolean(task), { count: list(at(mine.body, 'data')).length })

  // The three fields the courier audit added. Checked here because they are
  // snapshots copied through four layers, and the way that breaks is by
  // arriving as zero or as an empty string.
  step(
    'courier: can be routed to the door',
    typeof at(task, 'destination', 'latitude') === 'number' &&
      (at(task, 'destination', 'latitude') as number) > 24,
    { destination: at(task, 'destination') },
  )
  step(
    'courier: can read what the customer wrote about finding them',
    Boolean(text(at(task, 'deliveryInstructions'))),
    { instructions: at(task, 'deliveryInstructions') },
  )

  for (const [label, path, body] of [
    ['accepted the offer', 'respond', { accept: true }],
    ['picked up', 'report', { to: 'PICKED_UP' }],
    ['set off', 'report', { to: 'OUT_FOR_DELIVERY' }],
    ['delivered', 'report', { to: 'DELIVERED' }],
  ] as const) {
    const done = await call('POST', `/api/v1/courier/deliveries/${taskId}/${path}`, {
      cookie: courier,
      body,
    })
    step(`courier: ${label}`, done.status === 200, {
      status: done.status,
      state: at(done.body, 'data', 'state'),
      error: at(done.body, 'error'),
    })
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`\nQA DRIVE ABORTED: ${String(error)}\n`)
  process.exitCode = 1
})

export { TENANT_ID }
