import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'
import { walletWithdrawalSummarySchema } from '@alo-noon/contracts'

import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaWalletService, type WalletService } from './modules/wallet'
import {
  createPrismaWalletWithdrawalService,
  type WalletWithdrawalService,
} from './modules/wallet-withdrawal'

/**
 * A customer getting their money back, against PostgreSQL.
 *
 * The thing being proven is that it cannot be got twice. The balance is debited
 * when the request is made, not when a person makes the bank transfer, because
 * anything else leaves the amount spendable while the money is already on its
 * way. A refusal has to put it back exactly once, and a settled request has to
 * stay settled.
 *
 * This is also what makes the refund policy able to say the true thing. Until
 * this existed a refund became store credit and stayed store credit, because
 * there was no way for support to take an amount off a balance after sending it
 * at a bank.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger: ReturnType<typeof createPrismaPaymentLedgerService> =
  createPrismaPaymentLedgerService(prisma, {
    refundDestination: () => wallet,
  })
const wallet: WalletService = createPrismaWalletService(prisma, { ledger })
const withdrawals: WalletWithdrawalService = createPrismaWalletWithdrawalService(prisma, {
  wallet,
  ledger,
})

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-09-06T08:00:00.000Z')
const BALANCE = 1_000_000n
const ASKED = 400_000n

interface Fixture {
  tenantId: string
  customerId: string
  financeAccountId: string
  outsiderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('taking money back out of a wallet, over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
  }, 120_000)

  it('refuses an amount below the floor without touching anything', async () => {
    const result = await withdrawals.request(
      fixture.tenantId,
      fixture.customerId,
      request({ amount: 50_000n, key: `tiny-${suffix}` }),
      now,
      randomUUID(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WITHDRAWAL_BELOW_MINIMUM')
    expect(await prisma.walletWithdrawal.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
  })

  it('refuses more than the balance, and says what is missing', async () => {
    const result = await withdrawals.request(
      fixture.tenantId,
      fixture.customerId,
      request({ amount: BALANCE + 200_000n, key: `over-${suffix}` }),
      now,
      randomUUID(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('WITHDRAWAL_INSUFFICIENT_BALANCE')
      // The shortfall in Toman, which is what the customer reads.
      expect(result.message).toContain('۲۰٬۰۰۰')
    }

    // And the row it started to create is gone with the balance it could not
    // take. A request that was never funded and never will arrive is worse than
    // no request at all.
    expect(await prisma.walletWithdrawal.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
    const balance = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    expect(balance.balanceAmount).toBe(BALANCE)
  })

  it('takes the money out of the balance the moment it is asked for', async () => {
    const result = await withdrawals.request(
      fixture.tenantId,
      fixture.customerId,
      request({ amount: ASKED, key: `ask-${suffix}` }),
      now,
      randomUUID(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(walletWithdrawalSummarySchema.safeParse(result.withdrawal).success).toBe(true)
    expect(result.withdrawal.state).toBe('REQUESTED')
    // The card was sent in full and four digits were kept.
    expect(result.withdrawal.cardLastFour).toBe('4567')

    const balance = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    expect(balance.balanceAmount).toBe(BALANCE - ASKED)

    const entry = await prisma.walletEntry.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, withdrawalId: result.withdrawal.id },
    })
    expect(entry.kind).toBe('WITHDRAWAL')
    expect(entry.amount).toBe(ASKED)

    // And the books say the platform has stopped owing it.
    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, type: 'WALLET_WITHDRAWAL' },
      include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
    })
    expect(
      posting.entries.map((line) => [line.ledgerAccount.code, line.side, line.amount]),
    ).toEqual([
      ['L_2400_CUSTOMER_WALLET', 'DEBIT', ASKED],
      ['A_1100_CASH_CLEARING', 'CREDIT', ASKED],
    ])
  })

  it('never stores the full card number anywhere', async () => {
    // The single most damaging thing this table could hold. Checked as a fact
    // about the row rather than trusted to the code that wrote it.
    const rows = await prisma.walletWithdrawal.findMany({ where: { tenantId: fixture.tenantId } })
    for (const row of rows) {
      expect(row.cardLastFour).toHaveLength(4)
      // Every text column, not just the one meant to hold it: a full number
      // that leaked into the holder's name or a rejection reason would be
      // exactly as bad. BigInts are stringified by hand — JSON.stringify
      // refuses them, and a serializer that throws is not a search.
      const text = [
        row.cardLastFour,
        row.cardHolderName,
        row.iban,
        row.bankReference,
        row.rejectionReason,
        row.idempotencyKey,
      ].join(' ')
      expect(text).not.toContain('6037991234564567')
    }
  })

  it('replays a repeated request onto the one it already made', async () => {
    const replay = await withdrawals.request(
      fixture.tenantId,
      fixture.customerId,
      request({ amount: ASKED, key: `ask-${suffix}` }),
      now,
      randomUUID(),
    )
    expect(replay.ok).toBe(true)
    expect(await prisma.walletWithdrawal.count({ where: { tenantId: fixture.tenantId } })).toBe(1)
    // And it took the money once.
    const balance = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    expect(balance.balanceAmount).toBe(BALANCE - ASKED)
  })

  it('refuses an account without the finance permission', async () => {
    const [open] = await withdrawals.listOpen(fixture.tenantId, 10)
    await expect(
      withdrawals.markPaid(
        fixture.tenantId,
        fixture.outsiderId,
        { withdrawalId: open!.id, bankReference: 'INTRUDER' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_FORBIDDEN', status: 403 })
  })

  it('records the bank reference once, and will not record it twice', async () => {
    const [open] = await withdrawals.listOpen(fixture.tenantId, 10)
    expect(open?.customerMobileE164).toMatch(/^\+989/)

    const paid = await withdrawals.markPaid(
      fixture.tenantId,
      fixture.financeAccountId,
      { withdrawalId: open!.id, bankReference: 'PAYA-2026-0906-11' },
      now,
    )
    expect(paid.state).toBe('PAID')
    expect(paid.bankReference).toBe('PAYA-2026-0906-11')

    // The same call again is the same outcome, not a second transfer.
    const again = await withdrawals.markPaid(
      fixture.tenantId,
      fixture.financeAccountId,
      { withdrawalId: open!.id, bankReference: 'PAYA-2026-0906-11' },
      now,
    )
    expect(again.bankReference).toBe('PAYA-2026-0906-11')

    // A paid request cannot be walked back and refunded on top of the transfer.
    // The refusal has to be this one: the database trigger also stops it, but a
    // trigger reaches the operator as "temporarily unavailable", which reads as
    // an invitation to try again — on the one operation that must not be tried
    // again. So the code, not the trigger, has to be what answers.
    await expect(
      withdrawals.reject(
        fixture.tenantId,
        fixture.financeAccountId,
        { withdrawalId: open!.id, reason: 'پشیمان شدیم' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_ALREADY_SETTLED', status: 409 })

    // The balance is still down by exactly what was sent.
    const balance = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    expect(balance.balanceAmount).toBe(BALANCE - ASKED)
  })

  it('puts the money back when a request is refused, as its own statement line', async () => {
    const asked = await withdrawals.request(
      fixture.tenantId,
      fixture.customerId,
      request({ amount: 200_000n, key: `refuse-${suffix}` }),
      now,
      randomUUID(),
    )
    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const rejected = await withdrawals.reject(
      fixture.tenantId,
      fixture.financeAccountId,
      { withdrawalId: asked.withdrawal.id, reason: 'نام صاحب کارت با حساب نمی‌خواند' },
      now,
      randomUUID(),
    )
    expect(rejected.state).toBe('REJECTED')
    expect(rejected.rejectionReason).toBe('نام صاحب کارت با حساب نمی‌خواند')

    const balance = await prisma.customerWallet.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, customerId: fixture.customerId },
    })
    // Back to where it was after the first, paid withdrawal — the refused one
    // cost the customer nothing.
    expect(balance.balanceAmount).toBe(BALANCE - ASKED)

    // Two lines, not one edited: the statement says what happened rather than
    // pretending nothing did.
    const entries = await prisma.walletEntry.findMany({
      where: { tenantId: fixture.tenantId, withdrawalId: asked.withdrawal.id },
      orderBy: { sequence: 'asc' },
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['WITHDRAWAL', 'WITHDRAWAL_REVERSAL'])

    // And the ledger nets to nothing across the pair.
    const postings = await prisma.financialTransaction.findMany({
      where: { tenantId: fixture.tenantId, type: 'WALLET_WITHDRAWAL' },
      include: { entries: { include: { ledgerAccount: true } } },
    })
    const walletMovement = postings
      .flatMap((posting) => posting.entries)
      .filter((entry) => entry.ledgerAccount.code === 'L_2400_CUSTOMER_WALLET')
      .reduce(
        (total, entry) => (entry.side === 'DEBIT' ? total + entry.amount : total - entry.amount),
        0n,
      )
    // Only the paid one moved the liability; the refused one and its reversal
    // cancel.
    expect(walletMovement).toBe(ASKED)
  })

  it('is idempotent on a refusal too', async () => {
    const [rejected] = await prisma.walletWithdrawal.findMany({
      where: { tenantId: fixture.tenantId, state: 'REJECTED' },
    })
    const again = await withdrawals.reject(
      fixture.tenantId,
      fixture.financeAccountId,
      { withdrawalId: rejected!.id, reason: 'دوباره' },
      now,
      randomUUID(),
    )
    expect(again.state).toBe('REJECTED')
    const credits = await prisma.walletEntry.count({
      where: {
        tenantId: fixture.tenantId,
        withdrawalId: rejected!.id,
        kind: 'WITHDRAWAL_REVERSAL',
      },
    })
    expect(credits).toBe(1)
  })

  it('will not pay a request it already refused', async () => {
    // The mirror of the case above, and the more dangerous direction: the money
    // is back on the customer's balance, so paying it now sends it twice.
    const [rejected] = await prisma.walletWithdrawal.findMany({
      where: { tenantId: fixture.tenantId, state: 'REJECTED' },
    })
    await expect(
      withdrawals.markPaid(
        fixture.tenantId,
        fixture.financeAccountId,
        { withdrawalId: rejected!.id, bankReference: 'PAYA-2026-0906-99' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_ALREADY_SETTLED', status: 409 })

    const untouched = await prisma.walletWithdrawal.findFirstOrThrow({
      where: { id: rejected!.id },
    })
    expect(untouched.state).toBe('REJECTED')
    expect(untouched.bankReference).toBeNull()
  })
})

function request(input: { amount: bigint; key: string }) {
  return {
    amount: input.amount,
    cardNumber: '6037991234564567',
    cardHolderName: 'مشتری آزمایشی',
    iban: 'IR820540102680020817909002',
    idempotencyKey: `withdrawal-${input.key}-0000`,
  }
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `wdr-${suffix.toLowerCase()}`, name: `Withdrawal ${suffix}` },
  })
  const tenantId = tenant.id
  const customer = await prisma.customer.create({ data: { tenantId, mobileE164: uniqueMobile() } })

  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `wdr-provision-${suffix}` },
    now,
    randomUUID(),
  )

  // A balance to take money out of, put there the way a real one gets there: a
  // captured top-up credited through the wallet service, which posts the
  // WALLET_TOP_UP journal alongside it.
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      customerId: customer.id,
      purpose: 'WALLET_TOP_UP',
      method: 'ONLINE_GATEWAY',
      state: 'CAPTURED',
      amount: BALANCE,
      currency: 'IRR',
      idempotencyKey: `wdr-topup-${suffix}`,
      correlationId: randomUUID(),
    },
  })
  await wallet.creditTopUp(
    tenantId,
    { customerId: customer.id, paymentId: payment.id, amount: BALANCE },
    now,
    randomUUID(),
  )

  return {
    tenantId,
    customerId: customer.id,
    financeAccountId: await createAccount(tenantId, 'WDR_FINANCE', [
      ADMIN_PERMISSIONS.financeSettle,
    ]),
    // Every other admin permission and not the one that moves money out.
    outsiderId: await createAccount(tenantId, 'WDR_OPERATOR', [
      ADMIN_PERMISSIONS.ordersRead,
      ADMIN_PERMISSIONS.ordersManage,
      ADMIN_PERMISSIONS.reportsRead,
    ]),
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
