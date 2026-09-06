import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaWalletService, type WalletService } from './modules/wallet'

/**
 * A balance, against PostgreSQL.
 *
 * Every claim this service makes is a claim about concurrency or about the
 * ledger, and neither survives being tested against a mock. Two top-ups landing
 * at the same moment are a row lock or they are a lost credit; a top-up that
 * moves the balance but posts nothing is a business whose books do not mention
 * money it is holding.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-29T09:00:00.000Z')

interface Fixture {
  tenantId: string
  customerId: string
  cityId: string
  zoneId: string
  branchId: string
  topUpPaymentIds: readonly string[]
  /** A top-up the gateway has not confirmed. Nothing may be credited from it. */
  uncapturedPaymentId: string
}

let fixture: Fixture
let wallet: WalletService
let nextTopUp = 0

const takeTopUp = () => {
  const id = fixture.topUpPaymentIds[nextTopUp]
  nextTopUp += 1
  if (!id) throw new Error('the fixture ran out of top-up payments')
  return id
}

afterAll(async () => prisma.$disconnect())

databaseDescribe('customer wallet over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
    wallet = createPrismaWalletService(prisma, {
      ledger: createPrismaPaymentLedgerService(prisma),
    })
  }, 60_000)

  it('opens an empty wallet the first time a customer looks', async () => {
    const summary = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(summary.balance).toEqual({ amount: '0', currency: 'IRR' })
    // And does not open a second one on the next look.
    const again = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(again.id).toBe(summary.id)
  })

  it('credits a captured top-up and posts it to the ledger', async () => {
    const paymentId = takeTopUp()
    const summary = await wallet.creditTopUp(
      fixture.tenantId,
      { customerId: fixture.customerId, paymentId, amount: 1_000_000n },
      now,
      randomUUID(),
    )
    expect(summary.balance.amount).toBe('1000000')

    // The posting is what makes the balance real to the business. Money held
    // and not recorded is money the books say is not there.
    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, paymentId, type: 'WALLET_TOP_UP' },
      include: { entries: { include: { ledgerAccount: true } } },
    })
    expect(posting.orderId).toBeNull()
    const byAccount = Object.fromEntries(
      posting.entries.map((entry) => [entry.ledgerAccount.code, entry.side]),
    )
    // Cash arrived, and the platform now owes it back. A top-up earns nothing.
    expect(byAccount['A_1100_CASH_CLEARING']).toBe('DEBIT')
    expect(byAccount['L_2400_CUSTOMER_WALLET']).toBe('CREDIT')
  })

  /**
   * A gateway callback that arrives twice must credit once. This is the whole
   * reason the entry carries an idempotency key derived from the payment.
   */
  it('credits the same top-up only once', async () => {
    const before = await wallet.read(fixture.tenantId, fixture.customerId, now)
    const paymentId = fixture.topUpPaymentIds[0]!

    await wallet.creditTopUp(
      fixture.tenantId,
      { customerId: fixture.customerId, paymentId, amount: 1_000_000n },
      now,
      randomUUID(),
    )

    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(after.balance.amount).toBe(before.balance.amount)
    expect(
      await prisma.walletEntry.count({
        where: { tenantId: fixture.tenantId, paymentId, kind: 'TOP_UP' },
      }),
    ).toBe(1)
  })

  /**
   * The property the row lock exists for.
   *
   * Two different callbacks crediting one balance at the same instant. Without
   * the lock both read the same balance, both write their own total, and one
   * credit disappears — the customer's money, gone, with a statement line still
   * claiming it arrived.
   */
  it('never loses a credit when two land at once', async () => {
    const before = await wallet.read(fixture.tenantId, fixture.customerId, now)
    const first = takeTopUp()
    const second = takeTopUp()

    await Promise.all([
      wallet.creditTopUp(
        fixture.tenantId,
        { customerId: fixture.customerId, paymentId: first, amount: 1_000_000n },
        now,
        randomUUID(),
      ),
      wallet.creditTopUp(
        fixture.tenantId,
        { customerId: fixture.customerId, paymentId: second, amount: 1_000_000n },
        now,
        randomUUID(),
      ),
    ])

    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(BigInt(after.balance.amount)).toBe(BigInt(before.balance.amount) + 2_000_000n)
  })

  /**
   * The credit and the posting are one transaction, and this is what that buys.
   *
   * The database refuses to post a top-up whose payment is not captured. If the
   * balance had been raised in a transaction of its own, that refusal would
   * arrive too late — the customer would be holding money the books do not
   * mention, and no later run would know to take it back.
   */
  it('does not credit a balance it cannot post', async () => {
    const before = await wallet.read(fixture.tenantId, fixture.customerId, now)

    await expect(
      wallet.creditTopUp(
        fixture.tenantId,
        {
          customerId: fixture.customerId,
          paymentId: fixture.uncapturedPaymentId,
          amount: 1_000_000n,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow()

    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(after.balance.amount).toBe(before.balance.amount)
    expect(
      await prisma.walletEntry.count({
        where: { tenantId: fixture.tenantId, paymentId: fixture.uncapturedPaymentId },
      }),
    ).toBe(0)
  })

  it('reads back as a statement, newest first, with the running balance', async () => {
    const entries = await wallet.listEntries(fixture.tenantId, fixture.customerId, 50)
    expect(entries).toHaveLength(3)
    const balance = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(entries[0]?.balanceAfter.amount).toBe(balance.balance.amount)
    // Only the kind that has actually moved money so far. A statement that
    // invented one would be describing money that did not move that way.
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(['TOP_UP']))
  })

  /**
   * The whole point of a balance.
   *
   * A gateway payment is a conversation with a bank that takes as long as it
   * takes. This is not: the money is already here, so one call opens the
   * payment, walks it, posts the journal, takes the balance down and marks the
   * order paid — all of it, or none of it.
   */
  it('pays for an order out of the balance in one call', async () => {
    const before = await wallet.read(fixture.tenantId, fixture.customerId, now)
    const order = await placeOrder(400_000n)

    const result = await wallet.payForOrder(
      fixture.tenantId,
      fixture.customerId,
      { orderId: order.id, idempotencyKey: `wallet-pay-${order.id}` },
      now,
      randomUUID(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payment.state).toBe('CAPTURED')

    const paid = await prisma.order.findFirstOrThrow({ where: { id: order.id } })
    expect(paid.paymentState).toBe('PAID')
    expect(paid.paymentMethod).toBe('WALLET')

    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(BigInt(after.balance.amount)).toBe(BigInt(before.balance.amount) - 400_000n)

    // One obligation becomes another. No cash moved, because it moved when the
    // wallet was charged — touching cash clearing again would count it twice.
    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, orderId: order.id },
      include: { entries: { include: { ledgerAccount: true } } },
    })
    expect(posting.type).toBe('PAYMENT_CAPTURE')
    const byAccount = Object.fromEntries(
      posting.entries.map((entry) => [entry.ledgerAccount.code, entry.side]),
    )
    expect(byAccount).toEqual({
      L_2400_CUSTOMER_WALLET: 'DEBIT',
      L_2100_PAYMENT_CLEARING: 'CREDIT',
    })
  })

  /**
   * Not an error — an answer.
   *
   * The customer is told what is missing so the app can send them to top up
   * exactly that much, and nothing is written: no opened payment, no statement
   * line, no order half-paid.
   */
  it('refuses an order it cannot cover, and says by how much', async () => {
    const balance = await wallet.read(fixture.tenantId, fixture.customerId, now)
    const order = await placeOrder(BigInt(balance.balance.amount) + 250_000n)

    const result = await wallet.payForOrder(
      fixture.tenantId,
      fixture.customerId,
      { orderId: order.id, idempotencyKey: `wallet-short-${order.id}` },
      now,
      randomUUID(),
    )

    expect(result).toEqual({
      ok: false,
      shortfall: 250_000n,
      balance: BigInt(balance.balance.amount),
    })
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
    expect(await prisma.walletEntry.count({ where: { orderId: order.id } })).toBe(0)
    const untouched = await prisma.order.findFirstOrThrow({ where: { id: order.id } })
    expect(untouched.paymentState).toBe('NOT_STARTED')
  })

  /** A customer double-tapping pays once. */
  it('pays for the same order only once', async () => {
    const order = await placeOrder(300_000n)
    const command = { orderId: order.id, idempotencyKey: `wallet-twice-${order.id}` }

    await wallet.payForOrder(fixture.tenantId, fixture.customerId, command, now, randomUUID())
    const between = await wallet.read(fixture.tenantId, fixture.customerId, now)
    await wallet.payForOrder(fixture.tenantId, fixture.customerId, command, now, randomUUID())

    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(after.balance.amount).toBe(between.balance.amount)
    expect(
      await prisma.walletEntry.count({
        where: { tenantId: fixture.tenantId, orderId: order.id },
      }),
    ).toBe(1)
    expect(
      await prisma.financialTransaction.count({
        where: { tenantId: fixture.tenantId, orderId: order.id },
      }),
    ).toBe(1)
  })

  /**
   * The property the row lock exists for, from the spending side.
   *
   * Two orders reaching for one balance that covers only one of them. Without
   * the lock both read the same number, both decide they can afford it, and the
   * check constraint rejects the loser as a violation nobody can explain rather
   * than as a refusal somebody can act on.
   */
  it('never lets two concurrent orders overdraw one balance', async () => {
    const balance = BigInt(
      (await wallet.read(fixture.tenantId, fixture.customerId, now)).balance.amount,
    )
    const amount = balance - 1n
    const [first, second] = await Promise.all([placeOrder(amount), placeOrder(amount)])

    const results = await Promise.all(
      [first, second].map((order) =>
        wallet
          .payForOrder(
            fixture.tenantId,
            fixture.customerId,
            { orderId: order.id, idempotencyKey: `wallet-race-${order.id}` },
            now,
            randomUUID(),
          )
          .catch(() => ({ ok: false as const })),
      ),
    )

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const after = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(BigInt(after.balance.amount)).toBe(1n)
  })

  /** A statement line is a fact about money that already moved. */
  it('refuses to rewrite an entry', async () => {
    const entry = await prisma.walletEntry.findFirstOrThrow({
      where: { tenantId: fixture.tenantId },
    })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.walletEntry.update({
          where: { id: entry.id },
          data: { amount: 1n },
        })
      }),
    ).rejects.toThrow(/append-only/)
  })

  /** The last line of defence, below every service that could ever be wrong. */
  it('refuses a negative balance at the database', async () => {
    const row = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.customerWallet.update({
          where: { id: row.id },
          data: { balanceAmount: -1n },
        })
      }),
    ).rejects.toThrow()
  })
})

/** An order waiting to be paid for, priced at exactly what the test needs. */
async function placeOrder(total: bigint) {
  return prisma.order.create({
    data: {
      tenantId: fixture.tenantId,
      idempotencyKey: `wallet-order-${randomUUID()}`,
      customerId: fixture.customerId,
      bakeryBranchId: fixture.branchId,
      cityId: fixture.cityId,
      operationalZoneId: fixture.zoneId,
      state: 'PENDING_CONFIRMATION',
      paymentState: 'NOT_STARTED',
      recipientNameSnapshot: 'زهرا محمدی',
      recipientPhoneSnapshot: '+989120000000',
      bakeryNameSnapshot: 'نانوایی',
      deliveryAddressSnapshot: 'نشانی',
      deliveryLatitudeSnapshot: '36.5442',
      deliveryLongitudeSnapshot: '52.6781',
      subtotalAmount: total,
      deliveryFeeAmount: 0n,
      discountAmount: 0n,
      totalAmount: total,
      createdAt: now,
      updatedAt: now,
    },
  })
}

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `wallet-${suffix.toLowerCase()}`, name: `Wallet ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `WLT${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `WLZ${suffix}`.slice(0, 16),
      nameFa: 'ناحیه',
      isActive: true,
    },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Wallet Bakery ${suffix}`,
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
      code: `WLB${suffix}`.slice(0, 16),
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })

  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: `+9893${suffix.slice(0, 7)}` },
  })

  // Top-up payments the gateway has already captured. A wallet is credited from
  // one of these, never from a request: the money is only the customer's once
  // the bank says so.
  const topUpPaymentIds: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const payment = await prisma.payment.create({
      data: {
        tenantId,
        customerId: customer.id,
        purpose: 'WALLET_TOP_UP',
        method: 'ONLINE_GATEWAY',
        state: 'CAPTURED',
        amount: 1_000_000n,
        currency: 'IRR',
        idempotencyKey: `wallet-topup-${suffix}-${index}`,
        correlationId: randomUUID(),
      },
    })
    topUpPaymentIds.push(payment.id)
  }

  // One the gateway has not answered for yet.
  const uncaptured = await prisma.payment.create({
    data: {
      tenantId,
      customerId: customer.id,
      purpose: 'WALLET_TOP_UP',
      method: 'ONLINE_GATEWAY',
      state: 'CREATED',
      amount: 1_000_000n,
      currency: 'IRR',
      idempotencyKey: `wallet-topup-open-${suffix}`,
      correlationId: randomUUID(),
    },
  })

  return {
    tenantId,
    customerId: customer.id,
    cityId: city.id,
    zoneId: zone.id,
    branchId: branch.id,
    topUpPaymentIds,
    uncapturedPaymentId: uncaptured.id,
  }
}
