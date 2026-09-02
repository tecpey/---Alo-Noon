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
  topUpPaymentIds: readonly string[]
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

  it('reads back as a statement, newest first, with the running balance', async () => {
    const entries = await wallet.listEntries(fixture.tenantId, fixture.customerId, 50)
    expect(entries).toHaveLength(3)
    const balance = await wallet.read(fixture.tenantId, fixture.customerId, now)
    expect(entries[0]?.balanceAfter.amount).toBe(balance.balance.amount)
    // Only the kind that has actually moved money so far. A statement that
    // invented one would be describing money that did not move that way.
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(['TOP_UP']))
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

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `wallet-${suffix.toLowerCase()}`, name: `Wallet ${suffix}` },
  })
  const tenantId = tenant.id

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

  return { tenantId, customerId: customer.id, topUpPaymentIds }
}
