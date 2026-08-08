import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import type {
  AuthenticationDeliveryResult,
  TextMessageProvider,
  TextMessageRequest,
} from '@alo-noon/domain'

import { createPrismaAdminMessagingService } from './modules/admin-messaging'
import {
  createPrismaCustomerNotificationService,
  type CustomerNotificationService,
} from './modules/customer-notifications'
import { createPrismaOutboxPublisher } from './modules/outbox-publisher'

/**
 * From a committed order event to a message on a phone, against PostgreSQL.
 *
 * The property worth the most here is that the customer is texted once. The
 * publisher is at-least-once by construction — it sends, then marks the event
 * published — so the test drives the same event twice and asserts the gateway
 * saw one call. Everything else follows from that: a suppressed template sends
 * nothing but still records why, and a gateway failure leaves a row that says
 * what went wrong instead of a silence.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')
const CREDENTIAL_ENV = `AUTH_SMS_NOTIFY_${suffix}`

const sent: TextMessageRequest[] = []
let nextResult: AuthenticationDeliveryResult = {
  outcome: 'DELIVERED',
  providerReference: 'msg-1',
  normalizedCode: 'ACCEPTED',
  retryable: false,
}

const gateway: TextMessageProvider = {
  code: 'TESTSMS',
  async sendText(request) {
    sent.push(request)
    request.credential.dispose()
    return nextResult
  },
}

interface Fixture {
  tenantId: string
  orderId: string
  customerId: string
}

let fixture: Fixture
let service: CustomerNotificationService

afterAll(async () => prisma.$disconnect())

databaseDescribe('customer notifications over PostgreSQL', () => {
  beforeAll(async () => {
    process.env[CREDENTIAL_ENV] = 'a-long-enough-test-secret'
    fixture = await seedTenant()
    service = createPrismaCustomerNotificationService(prisma, {
      providers: [gateway],
      credentialResolver: createTestCredentialResolver(),
      environment: 'TEST',
      messagingService: createPrismaAdminMessagingService(prisma),
    })
  }, 60_000)

  it('ignores an event no customer needs a text about', async () => {
    // Most domain events are not news. Scheduling the dough is one of them, and
    // a text about it is money spent to annoy someone.
    const outcome = await service.notify(
      fixture.tenantId,
      {
        name: 'order.production_advanced',
        aggregateType: 'order',
        aggregateId: fixture.orderId,
        payload: { toState: 'SCHEDULED' },
        correlationId: randomUUID(),
      },
      now,
    )
    expect(outcome).toBe('NOT_APPLICABLE')
    expect(sent).toHaveLength(0)
  })

  it('sends the tenant default wording, filled from the order', async () => {
    const outcome = await service.notify(
      fixture.tenantId,
      {
        name: 'order.confirmed',
        aggregateType: 'order',
        aggregateId: fixture.orderId,
        payload: { fromState: 'PENDING_CONFIRMATION', toState: 'CONFIRMED' },
        correlationId: randomUUID(),
      },
      now,
    )

    expect(outcome).toBe('SENT')
    expect(sent).toHaveLength(1)
    const message = sent[0]!
    expect(message.mobileE164).toBe('+989120000000')
    // The order's own public code, not its internal id, because it is what a
    // customer can read back to whoever answers the phone.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } })
    expect(message.body).toContain(order.publicId)
    expect(message.body).not.toMatch(/[{}]/)

    const record = await prisma.customerNotification.findFirst({
      where: { orderId: fixture.orderId, purpose: 'ORDER_ACCEPTED' },
    })
    expect(record).toMatchObject({ state: 'SENT', providerReference: 'msg-1', attempts: 1 })
  })

  it('does not text the customer twice for the same step', async () => {
    const before = sent.length
    const outcome = await service.notify(
      fixture.tenantId,
      {
        name: 'order.confirmed',
        aggregateType: 'order',
        aggregateId: fixture.orderId,
        payload: { fromState: 'PENDING_CONFIRMATION', toState: 'CONFIRMED' },
        correlationId: randomUUID(),
      },
      now,
    )
    expect(outcome).toBe('ALREADY_HANDLED')
    expect(sent).toHaveLength(before)
  })

  it('records why nothing was sent when the tenant switched a message off', async () => {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
      await transaction.messageTemplate.create({
        data: {
          tenantId: fixture.tenantId,
          channel: 'SMS',
          purpose: 'ORDER_COMPLETED',
          body: 'سفارش {orderCode} تحویل شد.',
          enabled: false,
        },
      })
    })

    const before = sent.length
    const outcome = await service.notify(
      fixture.tenantId,
      {
        name: 'order.completed',
        aggregateType: 'order',
        aggregateId: fixture.orderId,
        payload: { toState: 'COMPLETED' },
        correlationId: randomUUID(),
      },
      now,
    )

    expect(outcome).toBe('SUPPRESSED')
    expect(sent).toHaveLength(before)
    // Recorded rather than skipped silently, so "why did nobody get a text"
    // has an answer that is not "read the code".
    const record = await prisma.customerNotification.findFirst({
      where: { orderId: fixture.orderId, purpose: 'ORDER_COMPLETED' },
    })
    expect(record?.state).toBe('SUPPRESSED')
  })

  it('records the reason when the gateway refuses', async () => {
    nextResult = { outcome: 'REJECTED', normalizedCode: 'PROVIDER_REJECTED', retryable: false }
    const outcome = await service.notify(
      fixture.tenantId,
      {
        name: 'order.cancelled',
        aggregateType: 'order',
        aggregateId: fixture.orderId,
        payload: { toState: 'CANCELLED', reason: 'اتمام موجودی' },
        correlationId: randomUUID(),
      },
      now,
    )
    expect(outcome).toBe('FAILED')

    const record = await prisma.customerNotification.findFirst({
      where: { orderId: fixture.orderId, purpose: 'ORDER_CANCELLED' },
    })
    expect(record).toMatchObject({ state: 'FAILED', failureCode: 'PROVIDER_REJECTED' })
    nextResult = {
      outcome: 'DELIVERED',
      providerReference: 'msg-1',
      normalizedCode: 'ACCEPTED',
      retryable: false,
    }
  })

  it('refuses to rewrite what a customer was already told', async () => {
    const record = await prisma.customerNotification.findFirstOrThrow({
      where: { orderId: fixture.orderId, purpose: 'ORDER_ACCEPTED' },
    })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.customerNotification.update({
          where: { id: record.id },
          data: { body: 'چیز دیگری گفتیم' },
        })
      }),
    ).rejects.toThrow(/content is immutable/)

    // And a settled outcome cannot be re-decided by a stray retry.
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.customerNotification.update({
          where: { id: record.id },
          data: { state: 'FAILED', failureCode: 'RETHOUGHT' },
        })
      }),
    ).rejects.toThrow(/outcome is final/)
  })

  it('drains the outbox and stops re-reading what it published', async () => {
    const publisher = createPrismaOutboxPublisher(prisma, { notificationService: service })
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
      await transaction.domainEventOutbox.create({
        data: {
          tenantId: fixture.tenantId,
          eventId: randomUUID(),
          name: 'order.in_fulfillment',
          aggregateType: 'order',
          aggregateId: fixture.orderId,
          actorType: 'STAFF',
          correlationId: randomUUID(),
          consentBasis: 'TRANSACTIONAL',
          payload: { toState: 'IN_FULFILLMENT' },
          occurredAt: now,
        },
      })
    })

    const before = sent.length
    const first = await publisher.publish(fixture.tenantId, 50, now)
    expect(first.published).toBeGreaterThan(0)
    expect(first.failed).toBe(0)
    expect(sent.length).toBe(before + 1)

    // A published row is not claimed again, so the sweep running every fifteen
    // seconds does not re-send anything.
    const second = await publisher.publish(fixture.tenantId, 50, now)
    expect(second.claimed).toBe(0)
    expect(sent.length).toBe(before + 1)
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
    data: { slug: `notify-${suffix.toLowerCase()}`, name: `Notify ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `NTF-${suffix}`, nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `NTFZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Notify Bakery ${suffix}`,
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
      code: `NTFB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '5').slice(0, 9)}`,
    },
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

  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: `notify-${suffix}`,
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

  return { tenantId, orderId: order.id, customerId: customer.id }
}
