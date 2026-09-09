import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  createEmailRegistry,
  EMAIL_ADAPTER_SPI_VERSION,
  type EmailProvider,
} from '@alo-noon/domain'

import { createPrismaOperatorAlertService } from './modules/operator-alerts'

const databaseUrl = process.env['DATABASE_URL']
const describeIf = databaseUrl ? describe : describe.skip

const prisma = new PrismaClient()

/** Records what would have been sent, so the assertions are about content. */
function recordingAdapter(outcome: 'SENT' | 'TRANSIENT_FAILURE' = 'SENT') {
  const sent: { subject: string; body: string; to: string[] }[] = []
  const provider: EmailProvider = {
    code: 'SMTP',
    adapterVersion: '1.0.0',
    spiVersion: EMAIL_ADAPTER_SPI_VERSION,
    async send(request) {
      sent.push({
        subject: request.message.subject,
        body: request.message.body,
        to: request.message.to.map((recipient) => recipient.address),
      })
      return { outcome, providerReference: outcome === 'SENT' ? 'id' : null, normalizedCode: null }
    },
  }
  return { provider, sent }
}

function serviceFor(provider: EmailProvider) {
  return createPrismaOperatorAlertService(prisma, {
    registry: createEmailRegistry([provider]),
    credentialResolver: () => 'smtps://user:pass@mail.test:465',
    environment: 'TEST',
    panelUrl: 'https://alonoon.test/admin',
  })
}

async function seed(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { slug: `alert-${suffix.toLowerCase()}`, name: `نانوایی ${suffix}` },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
    await transaction.emailProviderConfiguration.create({
      data: {
        tenantId: tenant.id,
        providerCode: 'SMTP',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
        credentialReference: `env://EMAIL_${suffix}_PASSWORD`,
        senderAddress: 'no-reply@alonoon.test',
        senderName: 'الو نون',
        enabled: true,
        isDefault: true,
        healthStatus: 'HEALTHY',
        updatedAt: new Date(),
      },
    })
    // A healthy SMS provider too, so the tenant is working in every way except
    // the one a given test breaks. Without this every fixture also trips
    // SMS_PROVIDER_UNAVAILABLE — correctly, which is the point, but it would
    // make each assertion about two alerts instead of one.
    await transaction.authDeliveryProviderConfiguration.create({
      data: {
        tenantId: tenant.id,
        providerCode: 'LIMOSMS',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
        credentialReference: `env://AUTH_SMS_${suffix}_KEY`,
        senderReference: '3000',
        templateReference: 'otp-fa',
        enabled: true,
        isDefault: true,
        healthStatus: 'HEALTHY',
        updatedAt: new Date(),
      },
    })
  })
  return tenant
}

async function addRecipient(tenantId: string, address: string, criticalOnly: boolean) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.operatorAlertRecipient.create({
      data: { tenantId, address, displayName: 'اپراتور', criticalOnly, updatedAt: new Date() },
    })
  })
}

/** Parks an outbox event, which is the WARNING-severity condition. */
async function parkEvent(tenantId: string) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.domainEventOutbox.create({
      data: {
        tenantId,
        eventId: randomUUID(),
        name: 'order.accepted',
        aggregateType: 'Order',
        aggregateId: randomUUID(),
        actorType: 'SYSTEM',
        correlationId: randomUUID(),
        consentBasis: 'TRANSACTIONAL',
        payload: {},
        status: 'FAILED',
        publishAttempts: 5,
        occurredAt: new Date(),
      },
    })
  })
}

describeIf('integration: operator alerts', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('says nothing at all when nothing is wrong', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await addRecipient(tenant.id, `quiet-${suffix.toLowerCase()}@example.test`, false)
    const { provider, sent } = recordingAdapter()

    const summary = await serviceFor(provider).sweep(tenant.id, new Date(), randomUUID())

    // Not even a connection opened. There is deliberately no all-clear message:
    // an operator who receives one learns to skim.
    expect(sent).toHaveLength(0)
    expect(summary.sent).toBe(0)
  })

  it('tells the operator once, then holds its tongue while it stays true', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await addRecipient(tenant.id, `ops-${suffix.toLowerCase()}@example.test`, false)
    await parkEvent(tenant.id)
    const { provider, sent } = recordingAdapter()
    const service = serviceFor(provider)
    const now = new Date()

    const first = await service.sweep(tenant.id, now, randomUUID())
    expect(first.sent).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toContain(`نانوایی ${suffix}`)
    expect(sent[0]?.body).toContain('https://alonoon.test/admin')

    // Same condition, one minute later. A message every sweep is a message
    // nobody reads by the third morning.
    const second = await service.sweep(tenant.id, new Date(now.getTime() + 60_000), randomUUID())
    expect(second.sent).toBe(0)
    expect(second.suppressed).toBeGreaterThan(0)
    expect(sent).toHaveLength(1)

    // And the suppression is counted rather than discarded: "we knew for six
    // hours and said nothing" is a different fact from "we did not know".
    const dispatch = await prisma.operatorAlertDispatch.findFirst({
      where: { tenantId: tenant.id, kind: 'OUTBOX_EVENTS_PARKED' },
    })
    expect(dispatch?.suppressedSinceLastSend).toBeGreaterThan(0)
    expect(dispatch?.sendCount).toBe(1)
  })

  it('speaks again once the quiet period has passed', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await addRecipient(tenant.id, `later-${suffix.toLowerCase()}@example.test`, false)
    await parkEvent(tenant.id)
    const { provider, sent } = recordingAdapter()
    const service = serviceFor(provider)
    const now = new Date()

    await service.sweep(tenant.id, now, randomUUID())
    const sevenHoursLater = new Date(now.getTime() + 7 * 60 * 60_000)
    await service.sweep(tenant.id, sevenHoursLater, randomUUID())

    expect(sent).toHaveLength(2)
  })

  it('keeps a warning away from an address that asked for critical only', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await addRecipient(tenant.id, `owner-${suffix.toLowerCase()}@example.test`, true)
    await parkEvent(tenant.id)
    const { provider, sent } = recordingAdapter()

    const summary = await serviceFor(provider).sweep(tenant.id, new Date(), randomUUID())

    // Parked events are a WARNING, and the only listener wants criticals.
    expect(sent).toHaveLength(0)
    expect(summary.sent).toBe(0)

    // The claim must be released, not held: nothing was said, so a changed
    // audience should be free to hear it on the next sweep.
    const dispatch = await prisma.operatorAlertDispatch.findFirst({
      where: { tenantId: tenant.id, kind: 'OUTBOX_EVENTS_PARKED' },
    })
    expect(dispatch?.lastSentAt).toBeNull()
  })

  it('does not burn the quiet period on a message that failed to send', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await addRecipient(tenant.id, `flaky-${suffix.toLowerCase()}@example.test`, false)
    await parkEvent(tenant.id)
    const failing = recordingAdapter('TRANSIENT_FAILURE')
    const service = serviceFor(failing.provider)
    const now = new Date()

    const first = await service.sweep(tenant.id, now, randomUUID())
    expect(first.failed).toBe(1)

    // A minute later, with the mail server back. Waiting out six hours for a
    // message nobody received would be the worst of both.
    const second = await service.sweep(tenant.id, new Date(now.getTime() + 60_000), randomUUID())
    expect(second.sent + second.failed).toBe(1)
    expect(failing.sent).toHaveLength(2)
  })

  it('skips a tenant with nobody listening rather than treating it as an error', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const tenant = await seed(suffix)
    await parkEvent(tenant.id)
    const { provider, sent } = recordingAdapter()

    const summary = await serviceFor(provider).sweep(tenant.id, new Date(), randomUUID())

    expect(summary.skippedNoChannel).toBe(true)
    expect(summary.failed).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('does not leak one tenant’s trouble into another’s inbox', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const troubled = await seed(suffix)
    const calm = await seed(`Z${suffix}`.slice(0, 8))
    await addRecipient(troubled.id, `a-${suffix.toLowerCase()}@example.test`, false)
    await addRecipient(calm.id, `b-${suffix.toLowerCase()}@example.test`, false)
    await parkEvent(troubled.id)
    const { provider, sent } = recordingAdapter()
    const service = serviceFor(provider)

    await service.sweep(calm.id, new Date(), randomUUID())

    expect(sent).toHaveLength(0)
  })
})
