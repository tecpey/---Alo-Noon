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
 *
 * **It buys bread, and that bread is finite.** The order it places consumes the
 * offering's `dailyCapacity` like any customer's would — so running this
 * repeatedly against one tenant on one day eventually answers
 * `CAPACITY_UNAVAILABLE`, which is the capacity system working rather than a
 * fault in the drive. Two consequences worth knowing before launch day: on the
 * live host each run takes a loaf out of a real bakery's allowance, so run it
 * once and tell the bakery; and a red run late in a day of testing should be
 * read for its error code before anybody goes looking for a regression.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@alo-noon/database'

const prisma = new PrismaClient()
/**
 * `127.0.0.1` rather than `localhost`, which is not a cosmetic choice.
 *
 * The API resolves the tenant from the host the request arrived on, and the two
 * spellings are separate rows. In a workspace that has run both the demo seed
 * and the launch bootstrap they point at different tenants — `localhost` at the
 * demo shop, `127.0.0.1` at the launch one — so this script drove its HTTP at
 * one tenant while reading the other out of the database with `TENANT_ID`
 * below.
 *
 * That is the worst shape a smoke test can have. It did not fail cleanly: the
 * sign-in returned 503 because the demo tenant has no SMS provider, which reads
 * as "OTP delivery is broken" and sends you looking at the gateway, the
 * credential and the adapter — none of which were wrong. Had the demo tenant
 * happened to be fully configured, it would have passed instead, and reported
 * that a shop was ready to launch after exercising a different one.
 *
 * `assertHostMatchesTenant` below makes the mismatch impossible to have again.
 */
const BASE = process.env['LAUNCH_API_BASE'] ?? 'http://127.0.0.1:3001'
const TENANT_ID = '00000000-0000-4000-8000-000000000001'
const SMS_LOG = process.env['SMS_LOG'] ?? ''

/*
 * The three people this rehearsal signs in as.
 *
 * Overridable, because of a stall this script walks into on its second run.
 * A number with a live sign-in challenge is answered 202 with that same
 * challenge and no new message — correct, and the reason a gateway is not paid
 * every time somebody taps the button twice. But it means a re-run inside the
 * five-minute window fails at the first step with "wait and run again", and an
 * operator rehearsing a launch is exactly the person who runs this twice in a
 * row: once to see it fail, once to see the fix.
 *
 * So the numbers can be moved — but only the customer freely. The operator and
 * the courier are *identities*: bootstrap attaches the admin grants and the
 * courier profile to those exact numbers, so pointing them somewhere else signs
 * in successfully and then fails at the first privileged call with a 403. On a
 * re-run inside the window, move the customer and leave the other two alone.
 */
const CUSTOMER = process.env['LAUNCH_CUSTOMER_MOBILE'] ?? '+989120000003'
const OPERATOR = process.env['LAUNCH_OPERATOR_MOBILE'] ?? '+989120000001'
const COURIER = process.env['LAUNCH_COURIER_MOBILE'] ?? '+989120000002'

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

/**
 * The last message the sandbox gateway was asked to send.
 *
 * Each line is an ISO timestamp, a space, then the body the adapter posted —
 * so the JSON starts at the first brace rather than at the start of the line.
 * Parsing the whole line threw `Unexpected non-whitespace character at position
 * 4`, four characters being the year, which stopped this rehearsal at its first
 * step and is the sort of thing only running it finds.
 *
 * Scanned backwards for the last line that actually carries a message, because
 * the sandbox also logs requests with an empty body — a health probe writes a
 * timestamp and nothing else, and that must not be mistaken for the OTP.
 */
function lastSentMessage(): { message: string; mobile: string } | null {
  let contents: string
  try {
    contents = readFileSync(SMS_LOG, 'utf8')
  } catch {
    // No log at all means the sandbox has not been asked to send anything —
    // reported as "no message" so the step fails with its own wording rather
    // than an ENOENT stack trace that says nothing about the rehearsal.
    return null
  }
  const lines = contents.trim().split('\n').filter(Boolean)
  for (const line of [...lines].reverse()) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let parsed: { Message?: string; MobileNumber?: string[] }
    try {
      parsed = JSON.parse(line.slice(brace)) as { Message?: string; MobileNumber?: string[] }
    } catch {
      continue
    }
    if (parsed.Message) return { message: parsed.Message, mobile: parsed.MobileNumber?.[0] ?? '' }
  }
  return null
}

/** How many lines the sandbox log already had, so a stale code cannot be read. */
function sentCount(): number {
  try {
    return readFileSync(SMS_LOG, 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

async function signIn(mobileE164: string, label: string): Promise<string> {
  const before = sentCount()
  const requested = await call('POST', '/api/v1/auth/otp/request', {
    body: { mobileE164 },
    idempotencyKey: `launch-${label}-${randomUUID()}`,
  })
  step(`${label}: OTP request accepted`, requested.status === 202 || requested.status === 200, {
    status: requested.status,
  })

  const challengeId = text(at(requested.body, 'data', 'challengeId'))
  /*
   * Only a message this run caused. A request for a number that already has a
   * live challenge is answered 202 with that same challenge and *no* new
   * message — which is correct, and the reason a gateway is not paid every time
   * somebody taps the button twice. Reading the log blindly would then pick up
   * the previous run's code and fail at the next step with a 401 that says
   * nothing about why.
   */
  const sent = sentCount() > before ? lastSentMessage() : null
  if (!sent) {
    step(
      `${label}: a fresh code was sent`,
      false,
      'The API reused a live sign-in challenge, so no new message went out. ' +
        'Wait for the resend window on this number, or re-run with a fresh one: ' +
        'LAUNCH_CUSTOMER_MOBILE / LAUNCH_OPERATOR_MOBILE / LAUNCH_COURIER_MOBILE.',
    )
  }
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

/**
 * That the shop answering on `BASE` is the shop this script checks in the
 * database.
 *
 * Runs before anything else, because every later step reads from both sides: an
 * order placed over HTTP against one tenant and then looked up with `TENANT_ID`
 * in another produces failures that describe none of what is wrong.
 *
 * The city list is the cheapest tenant-scoped thing the API will answer without
 * a session, and comparing ids rather than names is what makes it conclusive —
 * two tenants can both have a city called «بابل», and in this workspace they do.
 */
async function assertHostMatchesTenant(): Promise<void> {
  const cities = await call('GET', '/api/v1/serviceability/cities')
  const served = list(at(cities.body, 'data'))
    .map((city) => text(at(city, 'id')))
    .filter((id): id is string => Boolean(id))
  const mine = await prisma.city.findMany({
    where: { tenantId: TENANT_ID, id: { in: served } },
    select: { id: true },
  })
  const matches = mine.length > 0
  step(`host ${BASE} serves the tenant this script checks`, matches, {
    citiesServed: served.length,
    ofWhichThisTenants: mine.length,
  })
  if (!matches) {
    throw new Error(
      `${BASE} resolves to a different tenant than ${TENANT_ID}. ` +
        'Point LAUNCH_API_BASE at a host registered to this tenant — the API ' +
        'picks the tenant from the request host, and "localhost" and ' +
        '"127.0.0.1" are separate registrations.',
    )
  }
}

async function main(): Promise<void> {
  console.log('=== 0. Who am I talking to ===')
  await assertHostMatchesTenant()

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
  /*
     A 403 here is almost never a broken panel. It is the operator number not
     being the one bootstrap granted — see the note on the constants above —
     and saying so is the difference between a one-line fix and an afternoon
     spent reading the permission tables.
  */
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
  /*
    The rider has to be able to *get there*, not only read an address.

    Checked here rather than only in a unit test because these are snapshots
    copied through four layers — order, fulfilment, task, view — and the way
    they break is by quietly arriving as zero, which routes a courier to the
    Gulf of Guinea rather than to a door in Babol.
  */
  const destination = at(mine.body, 'data', 0, 'destination')
  const pickup = at(mine.body, 'data', 0, 'pickup')
  const plausible = (point: unknown): boolean => {
    const latitude = at(point, 'latitude')
    const longitude = at(point, 'longitude')
    // Iran's box, roughly. Zero is inside no country this shop delivers to.
    return (
      typeof latitude === 'number' &&
      typeof longitude === 'number' &&
      latitude > 24 &&
      latitude < 40 &&
      longitude > 43 &&
      longitude < 64
    )
  }
  step('courier: can be routed to the door, not just told the address', plausible(destination), {
    destination,
  })
  step('courier: can be routed to the bakery to collect', plausible(pickup), { pickup })

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
