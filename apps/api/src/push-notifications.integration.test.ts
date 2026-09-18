import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { generateOrderCode } from '@alo-noon/domain'
import type {
  AuthenticationDeliveryResult,
  PushMessageProvider,
  PushSendRequest,
  PushSendResult,
  TextMessageProvider,
  TextMessageRequest,
} from '@alo-noon/domain'

import { createPrismaAdminMessagingService } from './modules/admin-messaging'
import {
  createPrismaCustomerNotificationService,
  type CustomerNotificationService,
} from './modules/customer-notifications'
import { createPrismaPushDeviceService, type PushDeviceService } from './modules/push-devices'

/**
 * Which channel carried the message, against PostgreSQL.
 *
 * The whole value of this feature is a cost saving, and the whole risk of it is
 * a customer hearing nothing. So the properties worth testing are the two that
 * bound it: a customer with a live handset costs nothing to tell, and a
 * customer whose handset refuses is still told. Neither is provable from a
 * mock of the database, because the thing that stops a retried event sending
 * twice is a unique index, and the thing that stops a settled record being
 * rewritten is a trigger.
 *
 * What is not tested here is the last hop — Expo's servers to a real handset.
 * That needs a signed build on a real device, and no test in this repository
 * can stand in for it.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-29T09:00:00.000Z')
/**
 * One per tenant: `credentialReference` is unique across the whole table, so
 * two suites naming the same environment variable collide on an index that has
 * nothing to do with what either of them is testing.
 */
const credentialEnv = (tag: string): string => `AUTH_SMS_PUSH_${tag}`
const TOKEN = `ExponentPushToken[${suffix}aaaaaaaaaaaaaa]`

const texts: TextMessageRequest[] = []
const pushes: PushSendRequest[] = []
let nextPush: PushSendResult = { outcome: 'DELIVERED', providerReference: 'ticket-1' }

const gateway: TextMessageProvider = {
  code: 'TESTSMS',
  async sendText(request): Promise<AuthenticationDeliveryResult> {
    texts.push(request)
    request.credential.dispose()
    return {
      outcome: 'DELIVERED',
      providerReference: 'sms-1',
      normalizedCode: 'ACCEPTED',
      retryable: false,
    }
  },
}

const pushProvider: PushMessageProvider = {
  code: 'TESTPUSH',
  transport: 'EXPO',
  adapterVersion: '1.0.0',
  spiVersion: 2,
  async sendPush(request) {
    pushes.push(request)
    return nextPush
  },
}

/**
 * The browser channel, kept separate so a test can tell which one carried a
 * message. Wiring both to one recorder would pass whichever adapter ran.
 */
const webPushes: PushSendRequest[] = []
let nextWebPush: PushSendResult = { outcome: 'DELIVERED', providerReference: 'web-1' }

const webPushProvider: PushMessageProvider = {
  code: 'TESTWEBPUSH',
  transport: 'WEB_PUSH',
  adapterVersion: '1.0.0',
  spiVersion: 2,
  async sendPush(request) {
    webPushes.push(request)
    return nextWebPush
  },
}

// A real subscription shape — RFC 8291's example keys — so the schema that
// guards registration is exercised rather than bypassed.
const SUBSCRIPTION = {
  endpoint: `https://push.example.net/p/${suffix}`,
  keys: {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
}

interface Fixture {
  tenantId: string
  customerId: string
  orders: readonly string[]
}

let fixture: Fixture
let service: CustomerNotificationService
let devices: PushDeviceService
let nextOrder = 0

/** Each case needs an order of its own: one message per order step is the rule. */
function takeOrder(): string {
  const orderId = fixture.orders[nextOrder]
  nextOrder += 1
  if (!orderId) throw new Error('the fixture ran out of orders')
  return orderId
}

function confirmed(orderId: string) {
  return {
    name: 'order.confirmed',
    aggregateType: 'order',
    aggregateId: orderId,
    payload: { fromState: 'PENDING_CONFIRMATION', toState: 'CONFIRMED' },
    correlationId: randomUUID(),
  }
}

afterAll(async () => prisma.$disconnect())

databaseDescribe('order notifications choose a channel', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
    devices = createPrismaPushDeviceService(prisma)
    service = createPrismaCustomerNotificationService(prisma, {
      providers: [gateway],
      credentialResolver: createTestCredentialResolver(),
      environment: 'TEST',
      messagingService: createPrismaAdminMessagingService(prisma),
      push: { providers: [pushProvider, webPushProvider], devices },
    })
  }, 60_000)

  beforeEach(() => {
    texts.length = 0
    pushes.length = 0
    webPushes.length = 0
    nextPush = { outcome: 'DELIVERED', providerReference: 'ticket-1' }
    nextWebPush = { outcome: 'DELIVERED', providerReference: 'web-1' }
  })

  it('sends nothing by SMS when the customer has the app', async () => {
    await devices.register(
      fixture.tenantId,
      fixture.customerId,
      { expoPushToken: TOKEN, platform: 'ANDROID' },
      now,
    )
    const orderId = takeOrder()

    const outcome = await service.notify(fixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    expect(pushes).toHaveLength(1)
    // The saving is the entire point. A push that also texts costs the same as
    // before and pesters the customer twice.
    expect(texts).toHaveLength(0)

    // And it says what the SMS would have said. The body is the tenant's
    // template, rendered once and handed to whichever channel carries it, so a
    // customer who switches phones is not told something subtly different.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId, purpose: 'ORDER_ACCEPTED' },
    })
    expect(pushes[0]?.message.body).toBe(record.body)
    expect(pushes[0]?.message.title).toBe('سفارشتان ثبت شد')
    expect(pushes[0]?.message.data).toMatchObject({ orderId, orderCode: order.publicId })
  })

  it('records which handset carried it', async () => {
    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId: fixture.orders[0]!, purpose: 'ORDER_ACCEPTED' },
    })
    expect(record.channel).toBe('PUSH')
    expect(record.providerReference).toBe('ticket-1')

    const device = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
    })
    expect(record.pushDeviceId).toBe(device.id)
    expect(device.lastSuccessAt).not.toBeNull()
  })

  /**
   * The failure that would make this feature worse than not having it: a
   * customer whose token is dead hearing nothing at all.
   */
  it('falls back to SMS when the push is refused', async () => {
    nextPush = { outcome: 'PERMANENT_FAILURE', normalizedCode: 'DeviceNotRegistered' }
    const orderId = takeOrder()

    const outcome = await service.notify(fixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    expect(pushes).toHaveLength(1)
    expect(texts).toHaveLength(1)
    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId, purpose: 'ORDER_ACCEPTED' },
    })
    expect(record.channel).toBe('SMS')
    expect(record.pushDeviceId).toBeNull()
  })

  it('retires the token the service said was dead', async () => {
    const device = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
    })
    expect(device.enabled).toBe(false)
    expect(device.disabledReason).toBe('DeviceNotRegistered')
  })

  it('does not try a retired token again', async () => {
    const orderId = takeOrder()

    const outcome = await service.notify(fixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    // Not attempted at all: an uninstalled app must not cost a request on every
    // order for the rest of the customer's life.
    expect(pushes).toHaveLength(0)
    expect(texts).toHaveLength(1)
  })

  it('trusts the device again when the app comes back', async () => {
    await devices.register(
      fixture.tenantId,
      fixture.customerId,
      { expoPushToken: TOKEN, platform: 'ANDROID' },
      now,
    )
    const device = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
    })
    expect(device.enabled).toBe(true)
    expect(device.disabledReason).toBeNull()

    const orderId = takeOrder()
    await service.notify(fixture.tenantId, confirmed(orderId), now)
    expect(pushes).toHaveLength(1)
    expect(texts).toHaveLength(0)
  })

  it('lets SMS carry it when the push service will not answer', async () => {
    nextPush = { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'PROVIDER_UNAVAILABLE' }
    const orderId = takeOrder()

    const outcome = await service.notify(fixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    expect(texts).toHaveLength(1)
    // And the device survives it: a service having a bad minute is not evidence
    // that a customer uninstalled the app.
    const device = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
    })
    expect(device.enabled).toBe(true)
  })

  it('still refuses to tell the same customer twice about one step', async () => {
    const orderId = takeOrder()
    await service.notify(fixture.tenantId, confirmed(orderId), now)
    const before = pushes.length + texts.length

    const second = await service.notify(fixture.tenantId, confirmed(orderId), now)

    expect(second).toBe('ALREADY_HANDLED')
    expect(pushes.length + texts.length).toBe(before)
  })

  /**
   * The record is what answers a dispute, so it is frozen once it is decided.
   * Only the plan is editable, and only while the send is still pending.
   */
  it('refuses to rewrite the channel of a settled message', async () => {
    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId: fixture.orders[0]!, purpose: 'ORDER_ACCEPTED' },
    })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.customerNotification.update({
          where: { id: record.id },
          data: { channel: 'SMS' },
        })
      }),
    ).rejects.toThrow(/channel is final/)
  })

  it('takes a handset over when a second customer signs in on it', async () => {
    const other = await prisma.customer.create({
      data: { tenantId: fixture.tenantId, mobileE164: `+9891${suffix.slice(0, 8)}` },
    })

    await devices.register(
      fixture.tenantId,
      other.id,
      { expoPushToken: TOKEN, platform: 'ANDROID' },
      now,
    )

    // One row, now belonging to whoever signed in last. Two rows would mean the
    // first customer's order notifications land on a phone they do not have.
    const rows = await prisma.customerPushDevice.findMany({
      where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.customerId).toBe(other.id)
    expect(await devices.listForCustomer(fixture.tenantId, fixture.customerId)).toEqual([])
  })

  it('forgets only the caller’s own handset', async () => {
    await devices.forget(fixture.tenantId, fixture.customerId, {
      transport: 'EXPO',
      expoPushToken: TOKEN,
    })
    // It belongs to the other customer now, so signing out here must not
    // silence them.
    expect(
      await prisma.customerPushDevice.count({
        where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
      }),
    ).toBe(1)
  })
})

/**
 * The browser channel, which on an iPhone is the only one this platform can
 * ever have: Apple does not accept Iranian developer enrolments, so there is no
 * App Store build and the shop added to a home screen is the whole story.
 *
 * Its own tenant, because the suite above ends with the handset owned by
 * somebody else and these cases are about a customer with a browser and nothing
 * more.
 */
databaseDescribe('order notifications reach a browser', () => {
  let browserFixture: Fixture
  let browserService: CustomerNotificationService
  let taken = 0

  beforeAll(async () => {
    browserFixture = await seedTenant('b')
    browserService = createPrismaCustomerNotificationService(prisma, {
      providers: [gateway],
      credentialResolver: createTestCredentialResolver(),
      environment: 'TEST',
      messagingService: createPrismaAdminMessagingService(prisma),
      push: { providers: [pushProvider, webPushProvider], devices },
    })
  }, 60_000)

  beforeEach(() => {
    texts.length = 0
    pushes.length = 0
    webPushes.length = 0
    nextPush = { outcome: 'DELIVERED', providerReference: 'ticket-1' }
    nextWebPush = { outcome: 'DELIVERED', providerReference: 'web-1' }
  })

  function nextBrowserOrder(): string {
    const orderId = browserFixture.orders[taken]
    taken += 1
    if (!orderId) throw new Error('the fixture ran out of orders')
    return orderId
  }

  it('stores a subscription and hands it back whole', async () => {
    const summary = await devices.register(
      browserFixture.tenantId,
      browserFixture.customerId,
      { platform: 'WEB', subscription: SUBSCRIPTION },
      now,
    )
    expect(summary.platform).toBe('WEB')
    expect(summary.enabled).toBe(true)

    // Whole, because a subscription missing any of the three is stored, sent
    // to, and silently discarded by the browser.
    const listed = await devices.listForCustomer(browserFixture.tenantId, browserFixture.customerId)
    expect(listed).toEqual([
      {
        transport: 'WEB_PUSH',
        id: summary.id,
        subscription: {
          endpoint: SUBSCRIPTION.endpoint,
          p256dh: SUBSCRIPTION.keys.p256dh,
          auth: SUBSCRIPTION.keys.auth,
        },
        platform: 'WEB',
        enabled: true,
        lastSeenAt: now,
      },
    ])
  })

  it('sends nothing by SMS when the customer has the shop installed', async () => {
    const orderId = nextBrowserOrder()
    const outcome = await browserService.notify(browserFixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    expect(webPushes).toHaveLength(1)
    // Routed by transport: the Expo adapter must not be handed a subscription.
    expect(pushes).toHaveLength(0)
    expect(texts).toHaveLength(0)
    expect(webPushes[0]?.target).toEqual({
      transport: 'WEB_PUSH',
      subscription: {
        endpoint: SUBSCRIPTION.endpoint,
        p256dh: SUBSCRIPTION.keys.p256dh,
        auth: SUBSCRIPTION.keys.auth,
      },
    })

    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId, purpose: 'ORDER_ACCEPTED' },
    })
    expect(record.channel).toBe('PUSH')
    expect(record.providerReference).toBe('web-1')
    expect(webPushes[0]?.message.body).toBe(record.body)
  })

  /**
   * Re-subscribing is how a browser repairs itself, and a browser that has been
   * refused once must be believed when it comes back.
   */
  it('retires a revoked subscription and trusts it again when it returns', async () => {
    nextWebPush = { outcome: 'PERMANENT_FAILURE', normalizedCode: 'DeviceNotRegistered' }
    const outcome = await browserService.notify(
      browserFixture.tenantId,
      confirmed(nextBrowserOrder()),
      now,
    )
    expect(outcome).toBe('SENT')
    // The SMS still went, which is the promise: push is preferred, never
    // trusted.
    expect(texts).toHaveLength(1)

    const retired = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: browserFixture.tenantId, webPushEndpoint: SUBSCRIPTION.endpoint },
    })
    expect(retired.enabled).toBe(false)
    expect(retired.disabledReason).toBe('DeviceNotRegistered')

    await devices.register(
      browserFixture.tenantId,
      browserFixture.customerId,
      { platform: 'WEB', subscription: SUBSCRIPTION },
      now,
    )
    const back = await prisma.customerPushDevice.findFirstOrThrow({
      where: { tenantId: browserFixture.tenantId, webPushEndpoint: SUBSCRIPTION.endpoint },
    })
    expect(back.enabled).toBe(true)
    expect(back.disabledReason).toBeNull()
    // One row, not two: subscribing again must update the row rather than leave
    // a retired duplicate behind that nothing will ever clean up.
    expect(back.id).toBe(retired.id)
  })

  it('takes a browser over when a second customer signs in on it', async () => {
    const other = await prisma.customer.create({
      data: {
        tenantId: browserFixture.tenantId,
        mobileE164: `+9892${suffix.slice(0, 8)}`,
      },
    })
    await devices.register(
      browserFixture.tenantId,
      other.id,
      { platform: 'WEB', subscription: SUBSCRIPTION },
      now,
    )

    const rows = await prisma.customerPushDevice.findMany({
      where: { tenantId: browserFixture.tenantId, webPushEndpoint: SUBSCRIPTION.endpoint },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.customerId).toBe(other.id)
    expect(
      await devices.listForCustomer(browserFixture.tenantId, browserFixture.customerId),
    ).toEqual([])
  })

  /**
   * A customer with the app on a phone and the shop on a tablet. The one they
   * opened most recently is the one they are holding, and the two transports
   * are ordered against each other rather than queued one after the other.
   */
  it('reaches whichever device the customer last opened', async () => {
    const both = await prisma.customer.create({
      data: {
        tenantId: browserFixture.tenantId,
        mobileE164: `+9893${suffix.slice(0, 8)}`,
      },
    })
    const older = new Date(now.getTime() - 60 * 60 * 1000)
    await devices.register(
      browserFixture.tenantId,
      both.id,
      { expoPushToken: `ExponentPushToken[${suffix}bbbbbbbbbbbbbb]`, platform: 'ANDROID' },
      now,
    )
    await devices.register(
      browserFixture.tenantId,
      both.id,
      {
        platform: 'WEB',
        subscription: { ...SUBSCRIPTION, endpoint: `${SUBSCRIPTION.endpoint}-tablet` },
      },
      older,
    )

    const listed = await devices.listForCustomer(browserFixture.tenantId, both.id)
    expect(listed.map((device) => device.transport)).toEqual(['EXPO', 'WEB_PUSH'])
  })

  /**
   * A deployment with no VAPID keys has browser subscriptions in its database
   * and no adapter that can use them. It must behave exactly as it did before
   * web push existed — the SMS carries the message — rather than reporting a
   * failure or retiring devices that are perfectly alive.
   */
  it('falls back to SMS when no adapter speaks the device’s transport', async () => {
    const expoOnly = createPrismaCustomerNotificationService(prisma, {
      providers: [gateway],
      credentialResolver: createTestCredentialResolver(),
      environment: 'TEST',
      messagingService: createPrismaAdminMessagingService(prisma),
      push: { providers: [pushProvider], devices },
    })
    const lonely = await prisma.customer.create({
      data: {
        tenantId: browserFixture.tenantId,
        mobileE164: `+9894${suffix.slice(0, 8)}`,
      },
    })
    await devices.register(
      browserFixture.tenantId,
      lonely.id,
      {
        platform: 'WEB',
        subscription: { ...SUBSCRIPTION, endpoint: `${SUBSCRIPTION.endpoint}-lonely` },
      },
      now,
    )
    const orderId = nextBrowserOrder()
    await prisma.order.update({ where: { id: orderId }, data: { customerId: lonely.id } })

    const outcome = await expoOnly.notify(browserFixture.tenantId, confirmed(orderId), now)

    expect(outcome).toBe('SENT')
    expect(webPushes).toHaveLength(0)
    expect(texts).toHaveLength(1)
    const untouched = await prisma.customerPushDevice.findFirstOrThrow({
      where: {
        tenantId: browserFixture.tenantId,
        webPushEndpoint: `${SUBSCRIPTION.endpoint}-lonely`,
      },
    })
    expect(untouched.enabled).toBe(true)
  })
})

function createTestCredentialResolver() {
  return {
    async resolve(reference: string) {
      const variable = reference.replace(/^env:\/\//, '')
      const material = Buffer.from(process.env[variable] ?? '', 'utf8')
      return { material, dispose: () => material.fill(0) }
    },
  }
}

/**
 * A tenant of its own per suite. `label` keeps the slugs, codes and phone
 * numbers apart: every one of them is unique somewhere, and two suites sharing
 * a suffix fail on whichever index they reach first rather than on anything
 * they were testing.
 */
async function seedTenant(label = 'a'): Promise<Fixture> {
  const tag = `${suffix}${label.toUpperCase()}`
  const tenant = await prisma.tenant.create({
    data: { slug: `push-${tag.toLowerCase()}`, name: `Push ${tag}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `PSH-${tag}`, nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `PSHZ-${tag}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Push Bakery ${tag}`,
      displayNameFa: 'نانوایی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `PSHB-${tag}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: `+9890${tag.slice(0, 8)}` },
  })
  process.env[credentialEnv(tag)] = 'a-long-enough-test-secret'

  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.authDeliveryProviderConfiguration.create({
      data: {
        tenantId,
        providerCode: gateway.code,
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
        credentialReference: `env://${credentialEnv(tag)}`,
        senderReference: 'test-sender',
        templateReference: 'otp-fa',
        enabled: true,
        isDefault: true,
        priority: 100,
      },
    })
  })

  const orders: string[] = []
  for (let index = 0; index < 8; index += 1) {
    const order = await prisma.order.create({
      data: {
        publicId: generateOrderCode((length) => randomBytes(length)),
        tenantId,
        idempotencyKey: `push-${tag}-${index}`,
        customerId: customer.id,
        bakeryBranchId: branch.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        state: 'PENDING_CONFIRMATION',
        recipientNameSnapshot: 'زهرا محمدی',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: 250_000n,
        deliveryFeeAmount: 0n,
        discountAmount: 0n,
        totalAmount: 250_000n,
        createdAt: now,
        updatedAt: now,
      },
    })
    orders.push(order.id)
  }

  return { tenantId, customerId: customer.id, orders }
}
