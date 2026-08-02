import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { LedgerEntrySide, PaymentAggregateState, PaymentTransitionActor } from '@alo-noon/domain'

import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantId = '00000000-0000-4000-8000-000000000001'

afterAll(async () => prisma.$disconnect())

databaseDescribe('payment and ledger PostgreSQL foundation', () => {
  it('persists idempotent payments, governed transitions, and atomic double-entry capture', async () => {
    const suffix = randomUUID().slice(0, 8)
    const now = new Date('2026-08-03T00:00:00.000Z')
    const correlationId = randomUUID()
    const fixture = await createOrderFixture(suffix)
    const secondFixture = await createOrderFixture(`${suffix}-b`)
    const accounts = await Promise.all([
      prisma.ledgerAccount.create({
        data: {
          tenantId,
          code: `CASH_${suffix.toUpperCase()}`,
          name: 'Cash clearing',
          type: 'ASSET',
          currency: 'IRR',
        },
      }),
      prisma.ledgerAccount.create({
        data: {
          tenantId,
          code: `ORDER_REVENUE_${suffix.toUpperCase()}`,
          name: 'Order revenue clearing',
          type: 'LIABILITY',
          currency: 'IRR',
        },
      }),
    ])
    const service = createPrismaPaymentLedgerService(prisma)
    const initializeKey = `payment-initialize-${suffix}`
    const initialized = await service.initialize(
      tenantId,
      fixture.customer.id,
      { orderId: fixture.order.id, idempotencyKey: initializeKey },
      now,
      correlationId,
    )
    expect(initialized).toMatchObject({
      orderId: fixture.order.id,
      customerId: fixture.customer.id,
      state: 'CREATED',
      amount: { amount: '530000', currency: 'IRR' },
      version: 1,
    })
    expect(
      await service.initialize(
        tenantId,
        fixture.customer.id,
        { orderId: fixture.order.id, idempotencyKey: initializeKey },
        now,
        randomUUID(),
      ),
    ).toEqual(initialized)
    await expect(
      service.initialize(
        tenantId,
        fixture.customer.id,
        { orderId: secondFixture.order.id, idempotencyKey: initializeKey },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await expect(
      service.initialize(
        tenantId,
        secondFixture.customer.id,
        { orderId: fixture.order.id, idempotencyKey: `payment-foreign-${suffix}` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.order.update({
          where: { id: secondFixture.order.id },
          data: { paymentState: 'PAID' },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow('exactly one captured payment transaction')
    expect(
      (await prisma.order.findUnique({ where: { id: secondFixture.order.id } }))?.paymentState,
    ).toBe('NOT_STARTED')

    await expect(
      service.transition(
        tenantId,
        {
          paymentId: initialized.id,
          to: PaymentAggregateState.AUTHORIZED,
          actor: PaymentTransitionActor.SYSTEM,
          idempotencyKey: `payment-skip-${suffix}`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('not allowed')

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: initialized.id,
            fromState: 'CREATED',
            toState: 'PENDING',
            actorType: 'SYSTEM',
            version: 3,
            idempotencyKey: `payment-history-gap-${suffix}`,
            correlationId: randomUUID(),
            occurredAt: now,
          },
        })
        await transaction.payment.update({
          where: { id: initialized.id },
          data: { state: 'PENDING', version: 3 },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow('contiguous transition history')
    expect(
      await prisma.payment.findUnique({
        where: { id: initialized.id },
        select: { state: true, version: true },
      }),
    ).toEqual({ state: 'CREATED', version: 1 })

    const pending = await service.transition(
      tenantId,
      {
        paymentId: initialized.id,
        to: PaymentAggregateState.PENDING,
        actor: PaymentTransitionActor.SYSTEM,
        idempotencyKey: `payment-pending-${suffix}`,
      },
      new Date(now.getTime() + 1_000),
      randomUUID(),
    )
    expect(pending).toMatchObject({ state: 'PENDING', version: 2 })
    expect(
      await service.transition(
        tenantId,
        {
          paymentId: initialized.id,
          to: PaymentAggregateState.PENDING,
          actor: PaymentTransitionActor.SYSTEM,
          idempotencyKey: `payment-pending-${suffix}`,
        },
        new Date(now.getTime() + 1_000),
        randomUUID(),
      ),
    ).toEqual(pending)
    await expect(
      service.transition(
        tenantId,
        {
          paymentId: initialized.id,
          to: PaymentAggregateState.PENDING,
          actor: PaymentTransitionActor.STAFF,
          actorId: randomUUID(),
          idempotencyKey: `payment-pending-${suffix}`,
        },
        new Date(now.getTime() + 1_000),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    const authorized = await service.transition(
      tenantId,
      {
        paymentId: initialized.id,
        to: PaymentAggregateState.AUTHORIZED,
        actor: PaymentTransitionActor.SYSTEM,
        idempotencyKey: `payment-authorized-${suffix}`,
      },
      new Date(now.getTime() + 2_000),
      randomUUID(),
    )
    expect(authorized).toMatchObject({ state: 'AUTHORIZED', version: 3 })

    const captureKey = `payment-capture-${suffix}`
    const captureCommand = {
      paymentId: initialized.id,
      idempotencyKey: captureKey,
      entries: [
        {
          accountCode: accounts[0].code,
          side: LedgerEntrySide.DEBIT,
          amount: 530_000n,
        },
        {
          accountCode: accounts[1].code,
          side: LedgerEntrySide.CREDIT,
          amount: 530_000n,
        },
      ],
    } as const

    const failingService = createPrismaPaymentLedgerService(prisma, {
      beforeCommit: async () => {
        throw new Error('INJECTED_FINANCIAL_ROLLBACK')
      },
    })
    await expect(
      failingService.capture(
        tenantId,
        captureCommand,
        new Date(now.getTime() + 3_000),
        randomUUID(),
      ),
    ).rejects.toThrow('INJECTED_FINANCIAL_ROLLBACK')
    expect(await prisma.financialTransaction.count({ where: { paymentId: initialized.id } })).toBe(
      0,
    )
    expect(
      await prisma.ledgerEntry.count({
        where: { financialTransaction: { paymentId: initialized.id } },
      }),
    ).toBe(0)
    expect((await prisma.payment.findUnique({ where: { id: initialized.id } }))?.state).toBe(
      'AUTHORIZED',
    )
    expect((await prisma.order.findUnique({ where: { id: fixture.order.id } }))?.paymentState).toBe(
      'PENDING',
    )
    expect(
      await prisma.auditEvent.count({
        where: { entityId: initialized.id, action: { startsWith: 'payment.' } },
      }),
    ).toBe(3)
    expect(
      await prisma.domainEventOutbox.count({
        where: { aggregateId: initialized.id, aggregateType: 'payment' },
      }),
    ).toBe(3)

    await expect(
      prisma.$transaction(async (transaction) => {
        const nextVersion = authorized.version + 1
        await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: initialized.id,
            fromState: 'AUTHORIZED',
            toState: 'CAPTURED',
            actorType: 'SYSTEM',
            version: nextVersion,
            idempotencyKey: `missing-journal-transition-${suffix}`,
            correlationId: randomUUID(),
            occurredAt: new Date(now.getTime() + 3_000),
          },
        })
        await transaction.payment.update({
          where: { id: initialized.id },
          data: { state: 'CAPTURED', version: nextVersion },
        })
        await transaction.order.update({
          where: { id: fixture.order.id },
          data: { paymentState: 'PAID' },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow('exactly one financial transaction')
    expect((await prisma.payment.findUnique({ where: { id: initialized.id } }))?.state).toBe(
      'AUTHORIZED',
    )
    expect((await prisma.order.findUnique({ where: { id: fixture.order.id } }))?.paymentState).toBe(
      'PENDING',
    )

    await expect(
      prisma.$transaction(async (transaction) => {
        const nextVersion = authorized.version + 1
        await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: initialized.id,
            fromState: 'AUTHORIZED',
            toState: 'CAPTURED',
            actorType: 'SYSTEM',
            version: nextVersion,
            idempotencyKey: `unbalanced-transition-${suffix}`,
            correlationId: randomUUID(),
            occurredAt: new Date(now.getTime() + 3_000),
          },
        })
        await transaction.payment.update({
          where: { id: initialized.id },
          data: { state: 'CAPTURED', version: nextVersion },
        })
        await transaction.order.update({
          where: { id: fixture.order.id },
          data: { paymentState: 'PAID' },
        })
        const header = await transaction.financialTransaction.create({
          data: {
            tenantId,
            paymentId: initialized.id,
            orderId: fixture.order.id,
            type: 'PAYMENT_CAPTURE',
            amount: 530_000n,
            currency: 'IRR',
            idempotencyKey: `unbalanced-posting-${suffix}`,
            correlationId: randomUUID(),
            occurredAt: new Date(now.getTime() + 3_000),
            postedAt: new Date(now.getTime() + 3_000),
          },
        })
        await transaction.ledgerEntry.create({
          data: {
            tenantId,
            financialTransactionId: header.id,
            ledgerAccountId: accounts[0].id,
            sequence: 1,
            side: 'DEBIT',
            amount: 530_000n,
            currency: 'IRR',
          },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow('balanced double-entry')
    expect((await prisma.payment.findUnique({ where: { id: initialized.id } }))?.state).toBe(
      'AUTHORIZED',
    )

    const captures = await Promise.all([
      service.capture(tenantId, captureCommand, new Date(now.getTime() + 4_000), randomUUID()),
      service.capture(tenantId, captureCommand, new Date(now.getTime() + 4_000), randomUUID()),
    ])
    expect(captures[0]).toEqual(captures[1])
    expect(captures[0].payment).toMatchObject({ state: 'CAPTURED', version: 4 })
    expect(captures[0].transaction.entries).toHaveLength(2)
    expect(captures[0].transaction.amount.amount).toBe('530000')
    expect(await prisma.financialTransaction.count({ where: { paymentId: initialized.id } })).toBe(
      1,
    )
    expect(
      await prisma.ledgerEntry.count({
        where: { financialTransaction: { paymentId: initialized.id } },
      }),
    ).toBe(2)
    expect((await prisma.order.findUnique({ where: { id: fixture.order.id } }))?.paymentState).toBe(
      'PAID',
    )
    expect(
      await prisma.paymentStateTransition.findMany({
        where: { paymentId: initialized.id },
        orderBy: { version: 'asc' },
        select: { fromState: true, toState: true, version: true },
      }),
    ).toEqual([
      { fromState: null, toState: 'CREATED', version: 1 },
      { fromState: 'CREATED', toState: 'PENDING', version: 2 },
      { fromState: 'PENDING', toState: 'AUTHORIZED', version: 3 },
      { fromState: 'AUTHORIZED', toState: 'CAPTURED', version: 4 },
    ])
    expect(
      await prisma.auditEvent.count({
        where: { entityId: initialized.id, action: { startsWith: 'payment.' } },
      }),
    ).toBe(4)
    expect(
      await prisma.domainEventOutbox.count({
        where: { aggregateId: initialized.id, aggregateType: 'payment' },
      }),
    ).toBe(4)
    expect(
      await prisma.domainEventOutbox.count({
        where: {
          aggregateId: captures[0].transaction.id,
          name: 'financial.transaction_posted',
        },
      }),
    ).toBe(1)

    await expect(
      service.capture(
        tenantId,
        { ...captureCommand, entries: [{ ...captureCommand.entries[0], amount: 1n }] },
        new Date(now.getTime() + 4_000),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await expect(
      prisma.financialTransaction.update({
        where: { id: captures[0].transaction.id },
        data: { amount: 1n },
      }),
    ).rejects.toThrow('append-only')
    await expect(
      prisma.ledgerEntry.delete({ where: { id: captures[0].transaction.entries[0]!.id } }),
    ).rejects.toThrow('append-only')

    await verifyForcedRls(suffix, initialized.id, captures[0].transaction.id)
  })
})

async function createOrderFixture(suffix: string) {
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '1').slice(0, 9)}`,
      lifecycleStatus: 'ACTIVE',
    },
  })
  const city = await prisma.city.create({
    data: { tenantId, code: `PAY-${suffix}`, nameFa: 'شهر تست مالی', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `PAY-ZONE-${suffix}`, nameFa: 'منطقه مالی' },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Payment Bakery ${suffix}`,
      displayNameFa: 'نانوایی مالی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `PAY-BRANCH-${suffix}`,
      nameFa: 'شعبه مالی',
      addressLine: 'نشانی شعبه مالی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: `order-payment-${suffix}`,
      customerId: customer.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      bakeryBranchId: branch.id,
      state: 'PENDING_CONFIRMATION',
      paymentState: 'NOT_STARTED',
      productionState: 'UNSCHEDULED',
      deliveryState: 'UNASSIGNED',
      recipientNameSnapshot: 'مشتری مالی',
      recipientPhoneSnapshot: '+989111111111',
      deliveryAddressSnapshot: 'نشانی معتبر تست پرداخت',
      deliveryLatitudeSnapshot: '36.5387',
      deliveryLongitudeSnapshot: '52.6765',
      bakeryNameSnapshot: 'نانوایی مالی',
      subtotalAmount: 500_000n,
      deliveryFeeAmount: 30_000n,
      discountAmount: 0n,
      totalAmount: 530_000n,
      currency: 'IRR',
    },
  })
  return { customer, order }
}

async function verifyForcedRls(suffix: string, paymentId: string, transactionId: string) {
  const roleName = `payment_rls_${randomUUID().replaceAll('-', '')}`
  const foreignTenant = randomUUID()
  await prisma.ledgerAccount.create({
    data: {
      tenantId: foreignTenant,
      code: `FOREIGN_${suffix.toUpperCase()}`,
      name: 'Foreign tenant account',
      type: 'ASSET',
    },
  })
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
  for (const table of [
    'Payment',
    'PaymentStateTransition',
    'LedgerAccount',
    'FinancialTransaction',
    'LedgerEntry',
  ]) {
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "${roleName}"`,
    )
  }
  try {
    const withoutTenant = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "Payment"
      `
    })
    expect(withoutTenant[0]?.count).toBe(0n)
    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return Promise.all([
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Payment" WHERE "id" = ${paymentId}::uuid
        `,
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "FinancialTransaction" WHERE "id" = ${transactionId}::uuid
        `,
      ])
    })
    expect(visible[0]).toEqual([{ id: paymentId }])
    expect(visible[1]).toEqual([{ id: transactionId }])
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        await transaction.$executeRaw`
          INSERT INTO "LedgerAccount" (
            "id", "tenantId", "code", "name", "type", "currency", "createdAt", "updatedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${foreignTenant}::uuid, 'CROSS_TENANT', 'Cross tenant',
            'ASSET', 'IRR', now(), now()
          )
        `
      }),
    ).rejects.toThrow()
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
  }
}
