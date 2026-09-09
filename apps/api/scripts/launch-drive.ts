/**
 * Drives one real order from sign-in to doorstep against a running API.
 *
 * Everything goes over HTTP exactly as the three apps would send it, so this
 * exercises what the integration tests cannot: the composition root, host-based
 * tenant resolution, route registration, cookies, and the background sweeps.
 *
 * Signing in without texting anyone: the adapter posts to a local sandbox that
 * answers in the gateway's documented shape and writes what it was asked to
 * send. The code is read out of that message, which also proves the tenant's
 * template rendered a real code into real words. Nothing reaches a real gateway
 * and no credit is spent; every other step is the genuine article.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@alo-noon/database'

const prisma = new PrismaClient()
const BASE = process.env['LAUNCH_API_BASE'] ?? 'http://localhost:3001'
const TENANT_ID = '00000000-0000-4000-8000-000000000001'
const SMS_LOG = process.env['SMS_LOG'] ?? ''

const CUSTOMER = '+989120000003'
const OPERATOR = '+989120000001'
const COURIER = '+989120000002'

let failures = 0
const step = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures += 1
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

interface Call {
  status: number
  body: unknown
  cookie?: string | undefined
}

/**
 * Reads down a JSON response without pretending to know its type.
 *
 * A driver knows what it asked for but the parsed body is genuinely `unknown`,
 * and casting it to a shape would make a wrong assumption look like a checked
 * one — which in a smoke test is the difference between a real failure and a
 * confusing crash.
 */
function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; idempotencyKey?: string } = {},
): Promise<Call> {
  const response = await fetch(`${BASE}${path}`, {
    method,
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
    ...(setCookie && { cookie: setCookie.split(';')[0] }),
  }
}

/** The last message the sandbox gateway was asked to send. */
function lastSentMessage(): { message: string; mobile: string } | null {
  const lines = readFileSync(SMS_LOG, 'utf8').trim().split('\n').filter(Boolean)
  const last = lines.at(-1)
  if (!last) return null
  const parsed = JSON.parse(last) as { Message?: string; MobileNumber?: string[] }
  return parsed.Message ? { message: parsed.Message, mobile: parsed.MobileNumber?.[0] ?? '' } : null
}

async function signIn(mobileE164: string, label: string): Promise<string> {
  const requested = await call('POST', '/api/v1/auth/otp/request', {
    body: { mobileE164 },
    idempotencyKey: `launch-${label}-${randomUUID()}`,
  })
  step(`${label}: OTP request accepted`, requested.status === 202 || requested.status === 200, {
    status: requested.status,
  })

  const challengeId = text(at(requested.body, 'data', 'challengeId'))
  const sent = lastSentMessage()
  const otp = sent?.message.match(/\d{6}/)?.[0]
  step(`${label}: the gateway was handed a rendered message`, Boolean(otp), {
    message: sent?.message,
    mobile: sent?.mobile,
  })
  if (!otp || !challengeId) throw new Error('no code was sent')

  const verified = await call('POST', '/api/v1/auth/otp/verify', {
    body: { challengeId, code: otp },
  })
  step(`${label}: signed in`, verified.status === 200 && Boolean(verified.cookie), {
    status: verified.status,
  })
  if (!verified.cookie) throw new Error('no session cookie')
  return verified.cookie
}

async function main(): Promise<void> {
  console.log('=== 1. Customer ===')
  const customer = await signIn(CUSTOMER, 'customer')

  const cities = await call('GET', '/api/v1/serviceability/cities')
  const cityId = text(at(cities.body, 'data', 0, 'id'))
  step('catalog: an active city is published', Boolean(cityId), {
    count: list(at(cities.body, 'data')).length,
  })
  if (!cityId) throw new Error('no active city')

  const serviceable = await call('POST', '/api/v1/serviceability/check', {
    body: { cityId, latitude: 36.5387, longitude: 52.6765 },
  })
  const zoneId = text(at(serviceable.body, 'data', 'operationalZoneId'))
  step('catalog: the branch address is serviceable', Boolean(zoneId), at(serviceable.body, 'data'))
  if (!zoneId) throw new Error('address is not serviceable')

  const products = await call(
    'GET',
    `/api/v1/catalog/products?cityId=${cityId}&operationalZoneId=${zoneId}&page=1&pageSize=20`,
  )
  const first = at(products.body, 'data', 0)
  const offeringId =
    text(at(first, 'offerings', 0, 'offeringId')) ??
    text(at(first, 'offerings', 0, 'id')) ??
    text(at(first, 'offeringId')) ??
    text(at(first, 'id'))
  step('catalog: a sellable offering is listed', Boolean(offeringId), {
    products: list(at(products.body, 'data')).length,
  })
  if (!offeringId) throw new Error(`no offering: ${JSON.stringify(first)}`)

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
      idempotencyKey: `launch-address-${randomUUID()}`,
    },
  })
  step('customer: address saved', address.status === 201 || address.status === 200, {
    status: address.status,
    error: at(address.body, 'error'),
  })
  const addressId = text(at(address.body, 'data', 'id'))

  const cart = await call('PUT', `/api/v1/cart/items/${offeringId}`, {
    cookie: customer,
    body: { cityId, operationalZoneId: zoneId, quantity: 2 },
  })
  step('customer: item added to cart', cart.status === 200, {
    status: cart.status,
    error: at(cart.body, 'error'),
  })
  const cartVersion = at(cart.body, 'data', 'version')

  const quote = await call('POST', '/api/v1/cart/quote', {
    cookie: customer,
    body: {
      deliveryAddressId: addressId,
      expectedCartVersion: cartVersion,
      idempotencyKey: `launch-quote-${randomUUID()}`,
    },
  })
  step('customer: quote priced', quote.status === 201 || quote.status === 200, {
    status: quote.status,
    total: at(quote.body, 'data', 'totalAmount'),
    error: at(quote.body, 'error'),
  })

  const order = await call('POST', '/api/v1/orders', {
    cookie: customer,
    body: {
      quoteId: text(at(quote.body, 'data', 'id')),
      idempotencyKey: `launch-order-${randomUUID()}`,
    },
  })
  step('customer: order placed', order.status === 201 || order.status === 200, {
    status: order.status,
    state: at(order.body, 'data', 'state'),
    error: at(order.body, 'error'),
  })
  const orderId = text(at(order.body, 'data', 'id'))
  if (!orderId) throw new Error('no order')

  const payment = await call('POST', '/api/v1/payments', {
    cookie: customer,
    body: { orderId, idempotencyKey: `launch-payment-${randomUUID()}` },
  })
  step('customer: payment opened', payment.status === 201 || payment.status === 200, {
    status: payment.status,
    state: at(payment.body, 'data', 'state'),
    error: at(payment.body, 'error'),
  })

  console.log('\n=== 2. Money (through the ledger, no real gateway) ===')
  await settlePayment(orderId)
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  step('order is PAID with a real captured transaction', paid.paymentState === 'PAID', {
    paymentState: paid.paymentState,
  })

  console.log('\n=== 3. Operator ===')
  const operator = await signIn(OPERATOR, 'operator')

  const adminOrders = await call('GET', '/api/v1/admin/orders?page=1&pageSize=10', {
    cookie: operator,
  })
  step('operator: sees the order in the panel', adminOrders.status === 200, {
    status: adminOrders.status,
    count: list(at(adminOrders.body, 'data')).length,
  })

  const accepted = await call('POST', `/api/v1/admin/orders/${orderId}/accept`, {
    cookie: operator,
    body: { reason: 'پذیرش سفارش' },
  })
  step('operator: accepted the order', accepted.status === 200, {
    status: accepted.status,
    state: at(accepted.body, 'data', 'state'),
    error: at(accepted.body, 'error'),
  })

  const board = await call('GET', '/api/v1/admin/deliveries', { cookie: operator })
  const task = list(at(board.body, 'data')).find((entry) => at(entry, 'orderId') === orderId)
  const taskId = text(at(task, 'taskId'))
  step('dispatch: acceptance opened a delivery', Boolean(taskId), {
    status: board.status,
    state: at(task, 'state'),
  })
  if (!taskId) throw new Error('no delivery task')

  const couriers = await call('GET', '/api/v1/admin/couriers', { cookie: operator })
  const rider = list(at(couriers.body, 'data')).find((entry) => at(entry, 'status') === 'AVAILABLE')
  const courierId = text(at(rider, 'courierId'))
  step('dispatch: an available courier exists', Boolean(courierId), {
    roster: list(at(couriers.body, 'data')).length,
  })
  if (!courierId) throw new Error('no available courier')

  const offered = await call('POST', `/api/v1/admin/deliveries/${taskId}/offer`, {
    cookie: operator,
    body: { courierId },
  })
  step('dispatch: offered to the courier', offered.status === 200, {
    status: offered.status,
    state: at(offered.body, 'data', 'state'),
    error: at(offered.body, 'error'),
  })

  const afterOffer = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  step(
    'dispatch: an unanswered offer does not promise the customer a courier',
    afterOffer.deliveryState === 'UNASSIGNED',
    { deliveryState: afterOffer.deliveryState },
  )

  console.log('\n=== 4. Courier ===')
  const courier = await signIn(COURIER, 'courier')

  const mine = await call('GET', '/api/v1/courier/deliveries', { cookie: courier })
  step('courier: sees the offer', mine.status === 200 && list(at(mine.body, 'data')).length === 1, {
    status: mine.status,
    count: list(at(mine.body, 'data')).length,
    error: at(mine.body, 'error'),
  })
  step(
    'courier: can see the recipient phone to call',
    Boolean(text(at(mine.body, 'data', 0, 'recipientPhone'))),
    { phone: at(mine.body, 'data', 0, 'recipientPhone') },
  )

  for (const [label, path, body] of [
    ['accepted the offer', `respond`, { accept: true }],
    ['picked up the bread', `report`, { to: 'PICKED_UP' }],
    ['set off', `report`, { to: 'OUT_FOR_DELIVERY' }],
    ['delivered', `report`, { to: 'DELIVERED' }],
  ] as const) {
    const result = await call('POST', `/api/v1/courier/deliveries/${taskId}/${path}`, {
      cookie: courier,
      body,
    })
    step(`courier: ${label}`, result.status === 200, {
      status: result.status,
      state: at(result.body, 'data', 'state'),
      error: at(result.body, 'error'),
    })
  }

  console.log('\n=== 5. What the system now says ===')
  const finished = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  step('order: delivery state is DELIVERED', finished.deliveryState === 'DELIVERED', {
    deliveryState: finished.deliveryState,
  })
  // The order itself must close, or every report that counts completed orders
  // undercounts and the customer is never told it arrived.
  step('order: the order itself reached COMPLETED', finished.state === 'COMPLETED', {
    state: finished.state,
  })

  const fulfillment = await prisma.fulfillment.findFirst({ where: { orderId } })
  step('order: fulfillment completed alongside it', fulfillment?.state === 'COMPLETED', {
    state: fulfillment?.state,
  })

  const customerView = await call('GET', `/api/v1/orders/${orderId}`, { cookie: customer })
  step('customer: can follow their own order', customerView.status === 200, {
    status: customerView.status,
    deliveryState: at(customerView.body, 'data', 'deliveryState'),
  })

  // The publisher sweeps every fifteen seconds; give it one window.
  console.log('waiting for the outbox publisher…')
  await new Promise((resolve) => setTimeout(resolve, 18_000))

  const notifications = await prisma.customerNotification.findMany({ where: { orderId } })
  const purposes = notifications.map((entry) => entry.purpose)
  step(
    'notifications: the customer was told at every step that matters',
    ['ORDER_ACCEPTED', 'ORDER_READY', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_COMPLETED'].every(
      (purpose) => purposes.includes(purpose as never),
    ),
    notifications.map((entry) => ({ purpose: entry.purpose, state: entry.state })),
  )

  const pending = await prisma.domainEventOutbox.count({
    where: { tenantId: TENANT_ID, status: 'PENDING' },
  })
  step('outbox: drained rather than accumulating forever', pending === 0, { pending })

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exitCode = failures === 0 ? 0 : 1
}

/**
 * Walks the payment to captured through the ledger.
 *
 * The gateway itself cannot be reached from here and must not be: a real
 * initialize would send a real merchant request. What matters for the rest of
 * the flow is that the order is PAID by the same path production uses, and the
 * database refuses to mark it so without exactly one captured transaction.
 */
async function settlePayment(orderId: string): Promise<void> {
  const { createPrismaPaymentLedgerService } = await import('../src/modules/payment-ledger.js')
  const ledger = createPrismaPaymentLedgerService(prisma)
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } })
  const now = new Date()

  for (const to of ['PENDING', 'AUTHORIZED'] as const) {
    await ledger.transition(
      TENANT_ID,
      { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: `launch-${to}-${payment.id}` },
      now,
      randomUUID(),
    )
  }
  await ledger.capture(
    TENANT_ID,
    {
      paymentId: payment.id,
      idempotencyKey: `launch-capture-${payment.id}`,
      entries: [
        { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: order.totalAmount },
        { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: order.totalAmount },
      ],
    },
    now,
    randomUUID(),
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
