import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * The customer's entry into the payment cycle, against PostgreSQL.
 *
 * The rules worth checking here are the ownership ones. A payment is opened
 * from an order id the client supplies, and the only thing standing between
 * that and paying for someone else's bread is that the service resolves the
 * order under the session's own customer.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger = createPrismaPaymentLedgerService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')

interface Fixture {
  tenantId: string
  customerId: string
  strangerId: string
  payableOrderId: string
  secondOrderId: string
  strangerOrderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('customer payment checkout over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('opens a payment for the order, at the order total', async () => {
    const payment = await ledger.initialize(
      fixture.tenantId,
      fixture.customerId,
      { orderId: fixture.payableOrderId, idempotencyKey: `checkout-${suffix}-first` },
      now,
      randomUUID(),
    )

    expect(payment.orderId).toBe(fixture.payableOrderId)
    expect(payment.state).toBe('CREATED')
    // The amount comes from the order, never from the request — a
    // client-supplied amount would be a client-chosen price.
    expect(payment.amount.amount).toBe('250000')
  })

  it('replays the same key onto the same payment rather than opening a second', async () => {
    const again = await ledger.initialize(
      fixture.tenantId,
      fixture.customerId,
      { orderId: fixture.payableOrderId, idempotencyKey: `checkout-${suffix}-first` },
      now,
      randomUUID(),
    )
    const payments = await prisma.payment.count({ where: { orderId: fixture.payableOrderId } })
    expect(payments).toBe(1)
    expect(again.state).toBe('CREATED')
  })

  it('refuses a second payment for an order that already has one', async () => {
    await expect(
      ledger.initialize(
        fixture.tenantId,
        fixture.customerId,
        { orderId: fixture.payableOrderId, idempotencyKey: `checkout-${suffix}-second` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_EXISTS' })
  })

  it('refuses to open a payment against another customer order', async () => {
    // The order exists; it is simply not theirs. Reported as not found rather
    // than forbidden, so the refusal does not confirm the order is real.
    await expect(
      ledger.initialize(
        fixture.tenantId,
        fixture.customerId,
        { orderId: fixture.strangerOrderId, idempotencyKey: `checkout-${suffix}-stranger` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('reads a payment back for its owner, and hides it from everyone else', async () => {
    const opened = await ledger.initialize(
      fixture.tenantId,
      fixture.customerId,
      { orderId: fixture.secondOrderId, idempotencyKey: `checkout-${suffix}-read` },
      now,
      randomUUID(),
    )

    const mine = await ledger.findForCustomer(fixture.tenantId, fixture.customerId, opened.id)
    expect(mine?.id).toBe(opened.id)
    expect(mine?.state).toBe('CREATED')

    const theirs = await ledger.findForCustomer(fixture.tenantId, fixture.strangerId, opened.id)
    expect(theirs).toBeNull()
  })

  it('reports a payment that does not exist as absent, not as an error', async () => {
    const missing = await ledger.findForCustomer(fixture.tenantId, fixture.customerId, randomUUID())
    expect(missing).toBeNull()
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `checkout-${suffix.toLowerCase()}`, name: `Checkout ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `CHK-${suffix}`, nameFa: 'شهر پرداخت', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `CHKZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Checkout Bakery ${suffix}`,
      displayNameFa: 'نانوایی پرداخت',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `CHKB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })

  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: uniqueMobile() },
  })
  const stranger = await prisma.customer.create({
    data: { tenantId, mobileE164: uniqueMobile() },
  })

  const order = (customerId: string, key: string) =>
    prisma.order
      .create({
        data: {
          tenantId,
          idempotencyKey: key,
          customerId,
          bakeryBranchId: branch.id,
          cityId: city.id,
          operationalZoneId: zone.id,
          // Awaiting confirmation with nothing paid — the only state the ledger
          // will open a payment against, and where checkout leaves an order.
          state: 'PENDING_CONFIRMATION',
          recipientNameSnapshot: 'گیرنده',
          recipientPhoneSnapshot: '+989120000000',
          bakeryNameSnapshot: 'نانوایی پرداخت',
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
      .then((row) => row.id)

  return {
    tenantId,
    customerId: customer.id,
    strangerId: stranger.id,
    payableOrderId: await order(customer.id, `chk-${suffix}-1`),
    secondOrderId: await order(customer.id, `chk-${suffix}-2`),
    strangerOrderId: await order(stranger.id, `chk-${suffix}-3`),
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '7').slice(0, 9)}`
}
