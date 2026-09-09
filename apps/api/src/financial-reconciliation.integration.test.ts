import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  ADMIN_PERMISSIONS,
  CUSTOMER_WALLET_ACCOUNT,
  generateOrderCode,
  walletEntryDirection,
  type WalletEntryKind,
} from '@alo-noon/domain'

import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaOrderOperationsService } from './modules/order-operations'
import {
  createPrismaPartnerSettlementService,
  type PartnerSettlementService,
} from './modules/partner-settlement'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaWalletService, type WalletService } from './modules/wallet'
import {
  createPrismaWalletWithdrawalService,
  type WalletWithdrawalService,
} from './modules/wallet-withdrawal'

/**
 * A trading day, and then the two questions an accountant would ask.
 *
 * Every other financial test here proves one movement in isolation: a capture
 * balances, a settlement splits correctly, a refused withdrawal reverses. None
 * of them asks whether the movements agree *with each other* once a day's worth
 * have run through the same books — and that is the failure this system could
 * not survive. A ledger that balances posting by posting can still drift away
 * from the balances it is supposed to describe, and nobody finds out until a
 * customer asks for money the platform's own books say it does not owe.
 *
 * So this runs one of everything — a top-up, an order paid from a balance, an
 * order paid at a gateway, a settlement, a partner payout, a withdrawal paid, a
 * withdrawal refused, a transfer between two customers — and then asserts two
 * things that no single-movement test can:
 *
 *  1. Every posting balances, and the books balance in total. Double entry is
 *     worth nothing if it holds for each row and not for the set.
 *
 *  2. What the ledger says the platform owes its customers equals the sum of
 *     what the wallets actually hold — and each wallet equals its own statement.
 *     This is the reconciliation. The ledger is what the business reports; the
 *     balance is what the customer spends. If those two ever disagree, one of
 *     them is lying and there is no way to tell which.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger: ReturnType<typeof createPrismaPaymentLedgerService> =
  createPrismaPaymentLedgerService(prisma, { refundDestination: () => wallet })
const wallet: WalletService = createPrismaWalletService(prisma, { ledger })
const settlement: PartnerSettlementService = createPrismaPartnerSettlementService(prisma, {
  ledger,
})
const withdrawals: WalletWithdrawalService = createPrismaWalletWithdrawalService(prisma, {
  wallet,
  ledger,
})
const operations = createPrismaOrderOperationsService(prisma, {
  ledgerService: ledger,
  settlementService: settlement,
})

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-09-07T07:00:00.000Z')

const TOP_UP = 5_000_000n
const SUBTOTAL = 250_000n
const DELIVERY_FEE = 12_000n
const TOTAL = SUBTOTAL + DELIVERY_FEE
const WITHDRAWN = 400_000n
const REFUSED = 300_000n
const TRANSFERRED = 150_000n

interface Fixture {
  tenantId: string
  financeAccountId: string
  buyerId: string
  friendId: string
  bakeryId: string
  courierPartnerId: string
  walletOrderId: string
  gatewayOrderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('the books, after a day of trading', () => {
  beforeAll(async () => {
    fixture = await seed()
  }, 120_000)

  it('runs one of every money movement the platform can make', async () => {
    // Paid out of a balance: nothing crosses the platform's edge, one
    // obligation becomes another.
    const paid = await wallet.payForOrder(
      fixture.tenantId,
      fixture.buyerId,
      { orderId: fixture.walletOrderId, idempotencyKey: `rec-wallet-pay-${suffix}` },
      now,
      randomUUID(),
    )
    expect(paid.ok).toBe(true)

    // Both orders through to completion, which is what creates the earnings the
    // partners are owed.
    for (const orderId of [fixture.walletOrderId, fixture.gatewayOrderId]) {
      await walkToCompletion(orderId)
    }

    // The partner takes their money.
    const payout = await settlement.preparePayout(
      fixture.tenantId,
      fixture.financeAccountId,
      {
        party: 'BAKERY',
        partnerId: fixture.bakeryId,
        idempotencyKey: `rec-payout-${suffix}`,
      },
      now,
      randomUUID(),
    )
    expect(payout).not.toBeNull()
    await settlement.markPaid(
      fixture.tenantId,
      fixture.financeAccountId,
      { payoutId: payout!.id, bankReference: `PAYA-REC-${suffix}` },
      now,
    )

    // The customer takes some of theirs, and is refused some of theirs.
    const sent = await withdrawals.request(
      fixture.tenantId,
      fixture.buyerId,
      cardRequest(WITHDRAWN, `paid-${suffix}`),
      now,
      randomUUID(),
    )
    expect(sent.ok).toBe(true)
    if (sent.ok) {
      await withdrawals.markPaid(
        fixture.tenantId,
        fixture.financeAccountId,
        { withdrawalId: sent.withdrawal.id, bankReference: `PAYA-W-${suffix}` },
        now,
      )
    }

    const refused = await withdrawals.request(
      fixture.tenantId,
      fixture.buyerId,
      cardRequest(REFUSED, `refused-${suffix}`),
      now,
      randomUUID(),
    )
    expect(refused.ok).toBe(true)
    if (refused.ok) {
      await withdrawals.reject(
        fixture.tenantId,
        fixture.financeAccountId,
        { withdrawalId: refused.withdrawal.id, reason: 'نام صاحب کارت با حساب نمی‌خواند' },
        now,
        randomUUID(),
      )
    }

    // And gives some to a friend, which moves a balance without moving money.
    // The confirmed transfer row first: the statement lines point at it, and a
    // pair of entries with nothing to point at is not what the code writes.
    const transfer = await prisma.walletTransfer.create({
      data: {
        tenantId: fixture.tenantId,
        senderCustomerId: fixture.buyerId,
        recipientCustomerId: fixture.friendId,
        amount: TRANSFERRED,
        state: 'PENDING',
        codeDigest: 'x'.repeat(64),
        codeExpiresAt: new Date(now.getTime() + 600_000),
        idempotencyKey: `rec-transfer-${suffix}`,
        correlationId: randomUUID(),
      },
    })
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
      await wallet.transferWithin(
        transaction,
        fixture.tenantId,
        {
          transferId: transfer.id,
          senderCustomerId: fixture.buyerId,
          recipientCustomerId: fixture.friendId,
          amount: TRANSFERRED,
        },
        now,
        randomUUID(),
      )
    })
  }, 120_000)

  /**
   * Double entry, over the set rather than the row.
   *
   * The deferred trigger already refuses an unbalanced posting one at a time.
   * What it cannot see is a day: two postings that each balance but were
   * written against accounts that do not add up together.
   */
  it('balances, every posting and the whole day', async () => {
    const postings = await prisma.financialTransaction.findMany({
      where: { tenantId: fixture.tenantId },
      include: { entries: { include: { ledgerAccount: true } } },
    })
    expect(postings.length).toBeGreaterThan(5)

    let debits = 0n
    let credits = 0n
    for (const posting of postings) {
      const rowDebits = sum(posting.entries, 'DEBIT')
      const rowCredits = sum(posting.entries, 'CREDIT')
      // Named in the message: a failure here has to say which posting, or
      // finding it means reading a day of journals by hand.
      expect(`${posting.type}:${rowDebits}`).toBe(`${posting.type}:${rowCredits}`)
      // The recorded amount is the posting's own debit total, not a number
      // somebody passed alongside it — a settlement grosses up, so the two are
      // not the same figure and only one of them is the truth.
      expect(posting.amount).toBe(rowDebits)
      debits += rowDebits
      credits += rowCredits
    }
    expect(debits).toBe(credits)
    expect(debits).toBeGreaterThan(0n)
  })

  /**
   * The reconciliation: the books against the balances.
   *
   * `L_2400_CUSTOMER_WALLET` is a liability, so a credit raises it. Its balance
   * is the platform's own statement of what it owes every customer put
   * together, and the wallets are what those customers can actually spend. Two
   * numbers, computed by different code, down two different paths — a top-up
   * writes the ledger through settlement and the balance through the wallet
   * service — and the day is only correct if they are the same number.
   */
  it('owes exactly what the wallets hold', async () => {
    const entries = await prisma.ledgerEntry.findMany({
      where: { tenantId: fixture.tenantId, ledgerAccount: { code: CUSTOMER_WALLET_ACCOUNT } },
    })
    const owed = entries.reduce(
      (total, entry) => (entry.side === 'CREDIT' ? total + entry.amount : total - entry.amount),
      0n,
    )

    const wallets = await prisma.customerWallet.findMany({ where: { tenantId: fixture.tenantId } })
    const held = wallets.reduce((total, row) => total + row.balanceAmount, 0n)

    expect(owed).toBe(held)
    // Not vacuously equal: the day moved money in both directions through this
    // account, so zero on both sides would mean nothing ran.
    expect(held).toBeGreaterThan(0n)
  })

  /**
   * And each balance against its own statement.
   *
   * A customer arguing about their balance is shown the statement. If the two
   * are computed independently and can disagree, the statement is decoration.
   */
  it('gives every customer a statement that adds up to their balance', async () => {
    const wallets = await prisma.customerWallet.findMany({ where: { tenantId: fixture.tenantId } })
    expect(wallets.length).toBe(2)

    for (const row of wallets) {
      const statement = await prisma.walletEntry.findMany({
        where: { tenantId: fixture.tenantId, walletId: row.id },
        orderBy: { sequence: 'asc' },
      })
      // Direction comes from the kind, not from a column and never from the
      // sign — which is the design, so walking it through the domain's own
      // table is also a check that the kinds written here mean what the domain
      // says they mean.
      const walked = statement.reduce(
        (total, entry) => total + signed(entry.kind, entry.amount),
        0n,
      )
      expect(walked).toBe(row.balanceAmount)

      // The running balance on each line has to be the balance after that line,
      // or the statement reads as a different history from the one that
      // happened.
      let running = 0n
      for (const entry of statement) {
        running += signed(entry.kind, entry.amount)
        expect(entry.balanceAfter).toBe(running)
        // A balance never goes negative: an overdraft here is money the
        // platform lent without deciding to.
        expect(running >= 0n).toBe(true)
      }
    }
  })

  /**
   * Cash that arrived against cash that left.
   *
   * `A_1100_CASH_CLEARING` is the platform's own money position. It rises on a
   * capture and falls on a payout or a paid withdrawal, and it must never fall
   * below what came in — that would be the books claiming the platform paid out
   * money it never received.
   */
  it('never pays out more than it took in', async () => {
    const entries = await prisma.ledgerEntry.findMany({
      where: { tenantId: fixture.tenantId, ledgerAccount: { code: 'A_1100_CASH_CLEARING' } },
    })
    const cash = entries.reduce(
      (total, entry) => (entry.side === 'DEBIT' ? total + entry.amount : total - entry.amount),
      0n,
    )
    expect(cash >= 0n).toBe(true)
  })
})

/** A statement line's effect on the balance, per the domain's direction table. */
function signed(kind: WalletEntryKind, amount: bigint): bigint {
  return walletEntryDirection(kind) === 'CREDIT' ? amount : -amount
}

function sum(
  entries: ReadonlyArray<{ side: string; amount: bigint }>,
  side: 'DEBIT' | 'CREDIT',
): bigint {
  return entries.reduce((total, entry) => (entry.side === side ? total + entry.amount : total), 0n)
}

function cardRequest(amount: bigint, key: string) {
  return {
    amount,
    cardNumber: '6037991234564567',
    cardHolderName: 'خریدار آزمایشی',
    idempotencyKey: `rec-withdrawal-${key}`,
  }
}

async function walkToCompletion(orderId: string): Promise<void> {
  const actor = { accountId: fixture.financeAccountId }
  await operations.accept(
    fixture.tenantId,
    actor,
    { orderId, reason: 'پذیرش نانوایی' },
    now,
    randomUUID(),
  )
  for (const to of ['SCHEDULED', 'IN_PRODUCTION', 'READY'] as const) {
    await operations.advanceProduction(
      fixture.tenantId,
      actor,
      { orderId, to, reason: `پیشروی تولید به ${to}` },
      now,
      randomUUID(),
    )
  }
  await operations.startFulfillment(
    fixture.tenantId,
    actor,
    { orderId, reason: 'تحویل به پیک' },
    now,
    randomUUID(),
  )
  await operations.complete(
    fixture.tenantId,
    actor,
    { orderId, reason: 'تحویل شد' },
    now,
    randomUUID(),
  )
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `rec-${suffix.toLowerCase()}`, name: `Reconciliation ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `REC-${suffix}`, nameFa: 'شهر تراز', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `RECZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Reconciliation Bakery ${suffix}`,
      displayNameFa: 'نانوایی تراز',
      partnerStatus: 'ACTIVE',
      commissionBasisPoints: 1500,
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `RECB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const partner = await prisma.courierPartner.create({
    data: {
      tenantId,
      code: `RECC-${suffix}`,
      displayName: 'شرکت پیک تراز',
      isActive: true,
      deliveryShareBasisPoints: 8000,
    },
  })
  const buyer = await prisma.customer.create({ data: { tenantId, mobileE164: uniqueMobile() } })
  const friend = await prisma.customer.create({ data: { tenantId, mobileE164: uniqueMobile() } })

  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `rec-provision-${suffix}` },
    now,
    randomUUID(),
  )

  const financeAccountId = await createAccount(tenantId, 'RECONCILIATION_ADMIN', [
    ADMIN_PERMISSIONS.ordersRead,
    ADMIN_PERMISSIONS.ordersManage,
    ADMIN_PERMISSIONS.financeSettle,
  ])

  // The balance, arriving the way a real one does: a captured gateway payment
  // credited through the wallet service.
  const topUp = await prisma.payment.create({
    data: {
      tenantId,
      customerId: buyer.id,
      purpose: 'WALLET_TOP_UP',
      method: 'ONLINE_GATEWAY',
      state: 'CAPTURED',
      amount: TOP_UP,
      currency: 'IRR',
      idempotencyKey: `rec-topup-${suffix}`,
      correlationId: randomUUID(),
    },
  })
  await wallet.creditTopUp(
    tenantId,
    { customerId: buyer.id, paymentId: topUp.id, amount: TOP_UP },
    now,
    randomUUID(),
  )
  // No separate cash posting: `creditTopUp` writes the whole WALLET_TOP_UP
  // journal itself — cash clearing debited, the customer wallet liability
  // credited — which is exactly the pairing the reconciliation below reads.

  const order = async (key: string): Promise<string> => {
    const created = await prisma.order.create({
      data: {
        publicId: generateOrderCode((length) => randomBytes(length)),
        tenantId,
        idempotencyKey: key,
        customerId: buyer.id,
        bakeryBranchId: branch.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        state: 'PENDING_CONFIRMATION',
        recipientNameSnapshot: 'گیرنده',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی تراز',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: SUBTOTAL,
        deliveryFeeAmount: DELIVERY_FEE,
        discountAmount: 0n,
        totalAmount: TOTAL,
        createdAt: now,
        updatedAt: now,
      },
    })
    return created.id
  }

  const walletOrderId = await order(`rec-${suffix}-wallet`)
  const gatewayOrderId = await order(`rec-${suffix}-gateway`)

  // The second order goes through a gateway rather than a balance, so the day
  // covers both ways a customer can pay.
  const payment = await ledger.initialize(
    tenantId,
    buyer.id,
    { orderId: gatewayOrderId, idempotencyKey: `rec-init-${suffix}` },
    now,
    randomUUID(),
  )
  for (const to of ['PENDING', 'AUTHORIZED'] as const) {
    await ledger.transition(
      tenantId,
      { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: `rec-${to}-${suffix}` },
      now,
      randomUUID(),
    )
  }
  await ledger.capture(
    tenantId,
    {
      paymentId: payment.id,
      idempotencyKey: `rec-capture-${suffix}`,
      entries: [
        { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: TOTAL },
        { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: TOTAL },
      ],
    },
    now,
    randomUUID(),
  )

  return {
    tenantId,
    financeAccountId,
    buyerId: buyer.id,
    friendId: friend.id,
    bakeryId: bakery.id,
    courierPartnerId: partner.id,
    walletOrderId,
    gatewayOrderId,
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '8').slice(0, 9)}`
}

async function createAccount(
  tenantId: string,
  roleCode: string,
  permissions: readonly string[],
): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: { mobileE164: uniqueMobile(), verifiedAt: now },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.tenantMembership.create({
      data: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
    })
  })

  const role = await prisma.authorizationRole.upsert({
    where: { code: `${roleCode}_${suffix}` },
    update: {},
    create: { code: `${roleCode}_${suffix}`, name: roleCode },
  })
  for (const code of permissions) {
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: `Integration permission ${code}` },
    })
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })
  return account.id
}
