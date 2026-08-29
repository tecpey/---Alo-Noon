import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
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
const CREDENTIAL_ENV = `AUTH_SMS_PUSH_${suffix}`
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
  adapterVersion: '1.0.0',
  spiVersion: 1,
  async sendPush(request) {
    pushes.push(request)
    return nextPush
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
    process.env[CREDENTIAL_ENV] = 'a-long-enough-test-secret'
    fixture = await seedTenant()
    devices = createPrismaPushDeviceService(prisma)
    service = createPrismaCustomerNotificationService(prisma, {
      providers: [gateway],
      credentialResolver: createTestCredentialResolver(),
      environment: 'TEST',
      messagingService: createPrismaAdminMessagingService(prisma),
      push: { provider: pushProvider, devices },
    })
  }, 60_000)

  beforeEach(() => {
    texts.length = 0
    pushes.length = 0
    nextPush = { outcome: 'DELIVERED', providerReference: 'ticket-1' }
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
    await devices.forget(fixture.tenantId, fixture.customerId, TOKEN)
    // It belongs to the other customer now, so signing out here must not
    // silence them.
    expect(
      await prisma.customerPushDevice.count({
        where: { tenantId: fixture.tenantId, expoPushToken: TOKEN },
      }),
    ).toBe(1)
  })
})

function createTestCredentialResolver() {
  return {
    async resolve() {
      const material = Buffer.from(process.env[CREDENTIAL_ENV] ?? '', 'utf8')
      return { material, dispose: () => material.fill(0) }
    },
  }
}

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `push-${suffix.toLowerCase()}`, name: `Push ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `PSH-${suffix}`, nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `PSHZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Push Bakery ${suffix}`,
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
      code: `PSHB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: `+9890${suffix.slice(0, 8)}` },
  })

  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.authDeliveryProviderConfiguration.create({
      data: {
        tenantId,
        providerCode: gateway.code,
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
        credentialReference: `env://${CREDENTIAL_ENV}`,
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
        tenantId,
        idempotencyKey: `push-${suffix}-${index}`,
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
