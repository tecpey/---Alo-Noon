import type { Prisma, PrismaClient } from '@alo-noon/database'
import type { WalletWithdrawalSummary } from '@alo-noon/contracts'
import {
  ADMIN_PERMISSIONS,
  MINIMUM_WITHDRAWAL,
  withdrawalJournal,
  withdrawalRefusalMessage,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'
import { assertDeferredConstraints } from './deferred-constraints.js'
import type { LedgerPostingCommand } from './payment-ledger.js'
import type { WalletService } from './wallet.js'

/**
 * The way out of the wallet.
 *
 * A balance could arrive four ways and leave two — spent on bread, or sent to
 * another customer — so a refund became credit and stayed credit. That is a
 * policy nobody chose, and it is the reason the refund page could not say the
 * true thing: the platform had no way to hand somebody their money back.
 *
 * It could not be done by hand either. Support could make a bank transfer and
 * had no way to take the matching amount off the balance, so the customer would
 * have been paid twice — once to their card, once still standing on their wallet
 * screen and spendable.
 *
 * Three acts, and the order between them is the control:
 *
 * 1. **The customer asks.** The balance is debited *now*, and the ledger posting
 *    that says the platform has stopped owing them goes with it, in one
 *    transaction. Holding the money only as an intention would leave it
 *    spendable while somebody at a bank was already sending it.
 * 2. **A person sends the money**, by hand, at a bank. Nothing here does that:
 *    the platform holds no banking credentials, and a withdrawal desk that could
 *    move money on a session cookie is the single most attractive thing in this
 *    system to steal.
 * 3. **Somebody records what the bank called it**, or refuses the request with a
 *    reason — and a refusal puts the money back, visibly, as its own statement
 *    line.
 */
export interface WalletWithdrawalService {
  /**
   * The customer's own request. Returns a refusal they can act on rather than
   * throwing, because "your balance is ۴۰٬۰۰۰ تومان short" is a sentence to
   * show somebody and an exception is not.
   */
  request(
    tenantId: string,
    customerId: string,
    command: WithdrawalRequest,
    now: Date,
    correlationId: string,
  ): Promise<
    { ok: true; withdrawal: WalletWithdrawalSummary } | { ok: false; code: string; message: string }
  >

  /** What this customer has asked for, newest first. */
  listForCustomer(
    tenantId: string,
    customerId: string,
    limit: number,
  ): Promise<WalletWithdrawalSummary[]>

  /** The operator's queue: everything still open, oldest first. */
  listOpen(tenantId: string, limit: number): Promise<StaffWithdrawalSummary[]>

  /** Records that somebody sent the money, and what the bank called it. */
  markPaid(
    tenantId: string,
    actorAccountId: string,
    command: { withdrawalId: string; bankReference: string },
    now: Date,
  ): Promise<WalletWithdrawalSummary>

  /** Refuses it and puts the money back on the balance. */
  reject(
    tenantId: string,
    actorAccountId: string,
    command: { withdrawalId: string; reason: string },
    now: Date,
    correlationId: string,
  ): Promise<WalletWithdrawalSummary>
}

export interface WithdrawalRequest {
  amount: bigint
  /** Sent once, never stored: four digits are kept and the rest is forgotten. */
  cardNumber: string
  cardHolderName: string
  iban?: string
  idempotencyKey: string
}

/** What the operator sees: the request, plus who asked. */
export interface StaffWithdrawalSummary extends WalletWithdrawalSummary {
  customerId: string
  customerMobileE164: string
}

export class WalletWithdrawalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

/** Posts a journal this service authored, inside a transaction it holds. */
export interface WithdrawalLedger {
  postWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: LedgerPostingCommand,
  ): Promise<void>
}

export function createPrismaWalletWithdrawalService(
  prisma: PrismaClient,
  options: { wallet: WalletService; ledger: WithdrawalLedger },
): WalletWithdrawalService {
  return {
    async request(tenantId, customerId, command, now, correlationId) {
      if (command.amount < MINIMUM_WITHDRAWAL) {
        return {
          ok: false as const,
          code: 'WITHDRAWAL_BELOW_MINIMUM',
          message: withdrawalRefusalMessage('BELOW_MINIMUM'),
        }
      }

      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: the customer id is the authenticated caller's
        // own, and the tenant is restated in the filter on top of RLS.
        const replay = await transaction.walletWithdrawal.findFirst({
          where: { tenantId, customerId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) return { ok: true as const, withdrawal: toSummary(replay) }

        const withdrawal = await transaction.walletWithdrawal.create({
          data: {
            tenantId,
            customerId,
            amount: command.amount,
            // Four digits and no more. The platform needs to know which card
            // the customer meant and has no business holding a full number, so
            // the rest is dropped here rather than anywhere it could be read
            // back — not in a log, not in an audit payload, not in a row.
            cardLastFour: command.cardNumber.slice(-4),
            cardHolderName: command.cardHolderName.trim(),
            ...(command.iban && { iban: command.iban }),
            idempotencyKey: command.idempotencyKey,
            correlationId,
            requestedAt: now,
          },
        })

        // The money leaves the balance now, with the posting that says the
        // platform has stopped owing it. Both or neither.
        const moved = await options.wallet.withdrawWithin(
          transaction,
          tenantId,
          { customerId, withdrawalId: withdrawal.id, amount: command.amount },
          now,
          correlationId,
        )
        if (!moved.ok) {
          // Rolls the row back with it: a request that could not be funded is
          // not a request, and leaving it would show the customer a withdrawal
          // that never took their money and will never arrive.
          throw new InsufficientBalance(moved.shortfall)
        }

        await options.ledger.postWithin(transaction, tenantId, {
          type: 'WALLET_WITHDRAWAL',
          amount: command.amount,
          lines: withdrawalJournal(command.amount),
          idempotencyKey: `withdrawal:${withdrawal.id}`,
          correlationId,
          occurredAt: now,
        })
        await assertDeferredConstraints(transaction)
        return { ok: true as const, withdrawal: toSummary(withdrawal) }
      }).catch((error: unknown) => {
        if (error instanceof InsufficientBalance) {
          return {
            ok: false as const,
            code: 'WITHDRAWAL_INSUFFICIENT_BALANCE',
            message: withdrawalRefusalMessage('INSUFFICIENT_BALANCE', error.shortfall),
          }
        }
        throw error
      })
    },

    async listForCustomer(tenantId, customerId, limit) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: the authenticated customer's own requests.
        const rows = await transaction.walletWithdrawal.findMany({
          where: { tenantId, customerId },
          orderBy: { requestedAt: 'desc' },
          take: limit,
        })
        return rows.map(toSummary)
      })
    },

    async listOpen(tenantId, limit) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const rows = await transaction.walletWithdrawal.findMany({
          where: { tenantId, state: 'REQUESTED' },
          orderBy: { requestedAt: 'asc' },
          take: limit,
          include: { customer: { select: { id: true, mobileE164: true } } },
        })
        return rows.map((row) => ({
          ...toSummary(row),
          customerId: row.customer.id,
          customerMobileE164: row.customer.mobileE164,
        }))
      })
    },

    async markPaid(tenantId, actorAccountId, command, now) {
      const reference = command.bankReference.trim()
      if (!reference || reference.length > 128) {
        throw new WalletWithdrawalError('INVALID_BANK_REFERENCE', 400)
      }
      return withTenant(prisma, tenantId, async (transaction) => {
        await assertMaySettle(transaction, tenantId, actorAccountId, now)
        const withdrawal = await lockOpen(transaction, tenantId, command.withdrawalId)
        // Already recorded is the same outcome, not a second transfer.
        if (withdrawal.state === 'PAID') return toSummary(withdrawal)
        // Anything else settled is a different answer already given. Falling
        // through would leave the database trigger as the only thing stopping
        // it, and a trigger's refusal reaches the operator as "temporarily
        // unavailable" — which invites the retry that must not happen.
        if (withdrawal.state !== 'REQUESTED') {
          throw new WalletWithdrawalError('WITHDRAWAL_ALREADY_SETTLED', 409)
        }

        const paid = await transaction.walletWithdrawal.update({
          where: { id: withdrawal.id },
          data: {
            state: 'PAID',
            bankReference: reference,
            settledAt: now,
            settledByAccountId: actorAccountId,
          },
        })
        return toSummary(paid)
      })
    },

    async reject(tenantId, actorAccountId, command, now, correlationId) {
      const reason = command.reason.trim()
      if (reason.length < 3 || reason.length > 500) {
        throw new WalletWithdrawalError('INVALID_REJECTION_REASON', 400)
      }
      return withTenant(prisma, tenantId, async (transaction) => {
        await assertMaySettle(transaction, tenantId, actorAccountId, now)
        const withdrawal = await lockOpen(transaction, tenantId, command.withdrawalId)
        if (withdrawal.state === 'REJECTED') return toSummary(withdrawal)
        // Rejecting a paid request would credit the balance a second time for
        // money that already left the bank. The trigger below refuses it, but
        // only after this transaction has built the reversal — refuse it here,
        // with an answer that says why.
        if (withdrawal.state !== 'REQUESTED') {
          throw new WalletWithdrawalError('WITHDRAWAL_ALREADY_SETTLED', 409)
        }

        const rejected = await transaction.walletWithdrawal.update({
          where: { id: withdrawal.id },
          data: {
            state: 'REJECTED',
            rejectionReason: reason,
            settledAt: now,
            settledByAccountId: actorAccountId,
          },
        })

        // The money goes back on the balance, and the posting that said the
        // platform had stopped owing it is reversed. Both, in this transaction,
        // or the customer is left with neither their money nor their credit.
        await options.wallet.reverseWithdrawalWithin(
          transaction,
          tenantId,
          {
            customerId: withdrawal.customerId,
            withdrawalId: withdrawal.id,
            amount: withdrawal.amount,
          },
          now,
          correlationId,
        )
        await options.ledger.postWithin(transaction, tenantId, {
          type: 'WALLET_WITHDRAWAL',
          amount: withdrawal.amount,
          // The same two accounts the other way round: the platform owes the
          // customer again, and the money never left the bank.
          lines: withdrawalJournal(withdrawal.amount).map((line) => ({
            ...line,
            side: line.side === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
          })),
          idempotencyKey: `withdrawal-reversal:${withdrawal.id}`,
          correlationId,
          occurredAt: now,
        })
        await assertDeferredConstraints(transaction)
        return toSummary(rejected)
      })
    },
  }
}

/**
 * Thrown to roll the request row back with the balance it could not take.
 *
 * A refusal has to unwind the row it already created, and the only thing that
 * unwinds a Prisma transaction is a throw. Caught at the call site and turned
 * back into the answer the customer sees.
 */
class InsufficientBalance extends Error {
  constructor(readonly shortfall: bigint) {
    super('WITHDRAWAL_INSUFFICIENT_BALANCE')
  }
}

/**
 * The authoritative permission check, inside the transaction that settles.
 *
 * The route already refused an unprivileged session from its own grants, which
 * can be a revocation behind. This reads the rows.
 */
async function assertMaySettle(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  now: Date,
): Promise<void> {
  const permitted = await holdsPermissionInTransaction(
    transaction,
    tenantId,
    accountId,
    ADMIN_PERMISSIONS.financeSettle,
    now,
  )
  if (!permitted) throw new WalletWithdrawalError('WITHDRAWAL_FORBIDDEN', 403)
}

type WithdrawalRow = {
  id: string
  customerId: string
  amount: bigint
  state: 'REQUESTED' | 'PAID' | 'REJECTED'
  cardLastFour: string
  cardHolderName: string
  iban: string | null
  bankReference: string | null
  rejectionReason: string | null
  requestedAt: Date
  settledAt: Date | null
}

/**
 * Loads the request for update.
 *
 * Locked rather than merely read: two operators working the same queue can
 * settle the same request at the same moment, and the second must see the
 * first's result rather than write over it — which here would mean a second
 * bank reference on money that was sent once, or a reversal crediting a balance
 * twice.
 */
async function lockOpen(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  withdrawalId: string,
): Promise<WithdrawalRow> {
  await transaction.$queryRaw`
    SELECT "id" FROM "WalletWithdrawal"
    WHERE "id" = ${withdrawalId}::uuid AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE`
  // ownership-established: a staff financial operation scoped to this tenant;
  // the id comes from a queue this tenant's own staff read.
  const withdrawal = await transaction.walletWithdrawal.findFirst({
    where: { id: withdrawalId, tenantId },
  })
  if (!withdrawal) throw new WalletWithdrawalError('WITHDRAWAL_NOT_FOUND', 404)
  return withdrawal
}

function toSummary(row: WithdrawalRow): WalletWithdrawalSummary {
  return {
    id: row.id,
    amount: { amount: row.amount.toString(), currency: 'IRR' },
    state: row.state,
    cardLastFour: row.cardLastFour,
    cardHolderName: row.cardHolderName,
    ...(row.iban && { iban: row.iban }),
    ...(row.bankReference && { bankReference: row.bankReference }),
    ...(row.rejectionReason && { rejectionReason: row.rejectionReason }),
    requestedAt: row.requestedAt.toISOString(),
    ...(row.settledAt && { settledAt: row.settledAt.toISOString() }),
  }
}

function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}
