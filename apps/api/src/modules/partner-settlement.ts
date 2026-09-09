import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  ADMIN_PERMISSIONS,
  journalTotal,
  payoutJournal,
  settleOrder,
  settlementJournal,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'
import { assertDeferredConstraints } from './deferred-constraints.js'
import type { LedgerPostingCommand } from './payment-ledger.js'

/**
 * Turning delivered bread into money somebody is owed.
 *
 * Two acts, at two different times. When an order completes, what the customer
 * paid stops being held and becomes a bakery's receivable, a courier partner's
 * receivable and the platform's revenue. Later — weekly, or whenever somebody
 * sits down to do it — a payout discharges those receivables against the bank.
 *
 * The split happens at delivery and not at payment, and that is the whole
 * shape of the thing. A platform that recognised revenue when a customer paid
 * would be booking earnings on bread that has not left the oven, and would owe
 * a bakery for an order it might yet refund.
 *
 * Neither act invents a number. `settleOrder` in the domain decides the shares
 * from the rates that applied on the day, and those rates are copied onto the
 * earning so that changing a bakery's commission in March cannot make
 * February's payout recompute itself.
 */
export interface PartnerSettlementService {
  /**
   * Divides one delivered order, inside the transaction that completed it.
   *
   * Idempotent on the order: an order completed twice — a retried request, a
   * duplicated event — credits a bakery once, enforced by a unique index rather
   * than by remembering to check.
   *
   * Silent when the order is not payable — a zero total, an order nobody paid
   * for — because those exist and are not faults; there is simply nothing to
   * divide.
   */
  settleCompletedOrderWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    now: Date,
    correlationId: string,
  ): Promise<void>

  /** What a partner has earned and not been paid, oldest first. */
  outstanding(
    tenantId: string,
    party: 'BAKERY' | 'COURIER',
    partnerId: string,
  ): Promise<PartnerBalance>

  /** Every partner with something owing, so a run can be planned. */
  listOutstanding(tenantId: string): Promise<PartnerBalance[]>

  /**
   * Prepares a payout covering everything a partner has earned and not been
   * paid, and posts it.
   *
   * The posting happens now, not when somebody presses "paid". The platform
   * stops owing the moment it decides to pay and claims the earnings; the bank
   * transfer that follows is evidence, recorded against a payout that already
   * exists. Doing it the other way round would mean a run that was prepared and
   * then forgotten leaves earnings claimed by a payout the ledger never saw.
   */
  preparePayout(
    tenantId: string,
    actorAccountId: string,
    command: { party: 'BAKERY' | 'COURIER'; partnerId: string; idempotencyKey: string },
    now: Date,
    correlationId: string,
  ): Promise<PayoutSummary | null>

  /** Records that somebody actually sent the money, and what the bank called it. */
  markPaid(
    tenantId: string,
    actorAccountId: string,
    command: { payoutId: string; bankReference: string },
    now: Date,
  ): Promise<PayoutSummary>

  listPayouts(tenantId: string, limit: number): Promise<PayoutSummary[]>
}

/**
 * Rial minor units as a decimal string, never a number.
 *
 * A month of one city's bakery payables passes what a JSON number holds
 * exactly, and the sums here are BigInt in the database and stay BigInt all the
 * way to the wire.
 */
interface Money {
  amount: string
  currency: 'IRR'
}

export interface PartnerBalance {
  party: 'BAKERY' | 'COURIER'
  partnerId: string
  partnerName: string
  amount: Money
  orderCount: number
  /** When the oldest unpaid order was delivered, or null when nothing is owing. */
  oldestAt: string | null
}

export interface PayoutSummary {
  id: string
  party: 'BAKERY' | 'COURIER'
  partnerId: string
  partnerName: string
  state: 'DRAFT' | 'PAID' | 'CANCELLED'
  amount: Money
  orderCount: number
  periodStart: string
  periodEnd: string
  bankReference?: string
  createdAt: string
  paidAt?: string
}

function money(amount: bigint): Money {
  return { amount: (amount < 0n ? 0n : amount).toString(), currency: 'IRR' }
}

export class PartnerSettlementError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

/** Posts a journal this service authored, inside a transaction it holds. */
export interface SettlementLedger {
  postWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: LedgerPostingCommand,
  ): Promise<void>
}

export function createPrismaPartnerSettlementService(
  prisma: PrismaClient,
  options: { ledger: SettlementLedger },
): PartnerSettlementService {
  return {
    async settleCompletedOrderWithin(transaction, tenantId, orderId, now, correlationId) {
      // ownership-established: a system settlement of an order already resolved
      // and locked under this tenant by the caller that completed it.
      const order = await transaction.order.findFirst({
        where: { id: orderId, tenantId },
        select: {
          id: true,
          subtotalAmount: true,
          deliveryFeeAmount: true,
          discountAmount: true,
          totalAmount: true,
          paymentState: true,
          bakeryBranch: {
            select: { bakery: { select: { id: true, commissionBasisPoints: true } } },
          },
          fulfillment: {
            select: {
              deliveryTask: {
                select: {
                  assignments: {
                    where: { state: 'COMPLETED' },
                    select: { courier: { select: { courierPartner: true } } },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      })
      // Nothing to divide is not a fault. An unpaid order, or one that came to
      // nothing, has no money in clearing to move.
      if (!order || order.paymentState !== 'PAID' || order.totalAmount <= 0n) return

      const existing = await transaction.orderEarning.findFirst({
        where: { tenantId, orderId },
        select: { id: true },
      })
      if (existing) return

      // The partner who actually rode, not the one who was offered the job. An
      // order collected at the counter has none, and the bakery is still owed.
      const partner =
        order.fulfillment?.deliveryTask?.assignments[0]?.courier.courierPartner ?? null
      const bakery = order.bakeryBranch.bakery

      const settlement = settleOrder({
        subtotal: order.subtotalAmount,
        deliveryFee: order.deliveryFeeAmount,
        discount: order.discountAmount,
        total: order.totalAmount,
        commissionBasisPoints: bakery.commissionBasisPoints,
        courierBasisPoints: partner?.deliveryShareBasisPoints ?? 0,
      })

      await transaction.orderEarning.create({
        data: {
          tenantId,
          orderId,
          bakeryId: bakery.id,
          ...(partner && { courierPartnerId: partner.id }),
          subtotalAmount: order.subtotalAmount,
          deliveryFeeAmount: order.deliveryFeeAmount,
          discountAmount: order.discountAmount,
          totalAmount: order.totalAmount,
          commissionBasisPoints: bakery.commissionBasisPoints,
          courierBasisPoints: partner?.deliveryShareBasisPoints ?? 0,
          commissionAmount: settlement.commission,
          bakeryShareAmount: settlement.bakeryShare,
          courierShareAmount: settlement.courierShare,
          promotionCostAmount: settlement.promotionCost,
          correlationId,
          occurredAt: now,
        },
      })

      // The journal grosses up: the courier's ride is both a cost and a debt, so
      // the same Rial lands on both sides and the posting's amount is the
      // journal's own total rather than the order's.
      const lines = settlementJournal(settlement, order.totalAmount)
      await options.ledger.postWithin(transaction, tenantId, {
        orderId,
        type: 'ORDER_SETTLEMENT',
        amount: journalTotal(lines),
        lines,
        idempotencyKey: `settlement:${orderId}`,
        correlationId,
        occurredAt: now,
      })
    },

    async outstanding(tenantId, party, partnerId) {
      const balances = await readOutstanding(prisma, tenantId, { party, partnerId })
      return (
        balances[0] ?? {
          party,
          partnerId,
          partnerName: '',
          amount: money(0n),
          orderCount: 0,
          oldestAt: null,
        }
      )
    },

    async listOutstanding(tenantId) {
      return readOutstanding(prisma, tenantId, {})
    },

    async preparePayout(tenantId, actorAccountId, command, now, correlationId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        await assertMaySettle(transaction, tenantId, actorAccountId, now)
        const replay = await transaction.partnerPayout.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
          include: payoutInclude,
        })
        if (replay) return toPayoutSummary(replay)

        // Locked before they are read, so two runs prepared at the same instant
        // cannot both claim the same earnings and pay a partner twice.
        const claimable = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
          command.party === 'BAKERY'
            ? `SELECT "id" FROM "OrderEarning"
               WHERE "tenantId" = $1::uuid AND "bakeryId" = $2::uuid
                 AND "bakeryPayoutId" IS NULL AND "bakeryShareAmount" > 0
               ORDER BY "occurredAt" FOR UPDATE`
            : `SELECT "id" FROM "OrderEarning"
               WHERE "tenantId" = $1::uuid AND "courierPartnerId" = $2::uuid
                 AND "courierPayoutId" IS NULL AND "courierShareAmount" > 0
               ORDER BY "occurredAt" FOR UPDATE`,
          tenantId,
          command.partnerId,
        )
        // Nothing to claim can mean two different things, and they must not
        // look alike. The replay check above ran before the lock, so a request
        // that was genuinely concurrent with an identical one waited here and
        // now finds the earnings already claimed — by its own twin. Answering
        // "nothing owing" would tell an operator their payout had not happened
        // when it had. Asking again, now that the lock has been released, gets
        // the payout that was made.
        if (claimable.length === 0) {
          const settled = await transaction.partnerPayout.findFirst({
            where: { tenantId, idempotencyKey: command.idempotencyKey },
            include: payoutInclude,
          })
          return settled ? toPayoutSummary(settled) : null
        }

        const ids = claimable.map((row) => row.id)
        const earnings = await transaction.orderEarning.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, bakeryShareAmount: true, courierShareAmount: true, occurredAt: true },
          orderBy: { occurredAt: 'asc' },
        })
        const amount = earnings.reduce(
          (total, earning) =>
            total +
            (command.party === 'BAKERY' ? earning.bakeryShareAmount : earning.courierShareAmount),
          0n,
        )
        if (amount <= 0n) return null

        const periodStart = earnings[0]!.occurredAt
        const periodEnd = earnings[earnings.length - 1]!.occurredAt

        const payout = await transaction.partnerPayout.create({
          data: {
            tenantId,
            party: command.party,
            ...(command.party === 'BAKERY'
              ? { bakeryId: command.partnerId }
              : { courierPartnerId: command.partnerId }),
            amount,
            orderCount: earnings.length,
            periodStart,
            // A run whose earnings all landed in the same instant would have a
            // zero-length period, which the row refuses. One millisecond is the
            // smallest honest width for "this moment".
            periodEnd: periodEnd > periodStart ? periodEnd : new Date(periodStart.getTime() + 1),
            preparedByAccountId: actorAccountId,
            idempotencyKey: command.idempotencyKey,
            correlationId,
          },
          include: payoutInclude,
        })

        // ownership-established: the earnings were selected and locked under
        // this tenant and this partner a few lines above.
        await transaction.orderEarning.updateMany({
          where: { tenantId, id: { in: ids } },
          data:
            command.party === 'BAKERY'
              ? { bakeryPayoutId: payout.id }
              : { courierPayoutId: payout.id },
        })

        await options.ledger.postWithin(transaction, tenantId, {
          type: 'PARTNER_PAYOUT',
          amount,
          lines: payoutJournal({ party: command.party, amount }),
          idempotencyKey: `payout:${payout.id}`,
          correlationId,
          occurredAt: now,
        })
        await assertDeferredConstraints(transaction)
        return toPayoutSummary(payout)
      })
    },

    async markPaid(tenantId, actorAccountId, command, now) {
      const reference = command.bankReference.trim()
      if (!reference || reference.length > 128) {
        throw new PartnerSettlementError('INVALID_BANK_REFERENCE', 400)
      }
      return withTenant(prisma, tenantId, async (transaction) => {
        await assertMaySettle(transaction, tenantId, actorAccountId, now)
        // ownership-established: a staff financial operation scoped to this
        // tenant; the payout id comes from a list this tenant's own staff read.
        const payout = await transaction.partnerPayout.findFirst({
          where: { id: command.payoutId, tenantId },
          include: payoutInclude,
        })
        if (!payout) throw new PartnerSettlementError('PAYOUT_NOT_FOUND', 404)
        if (payout.state === 'PAID') return toPayoutSummary(payout)
        if (payout.state !== 'DRAFT') throw new PartnerSettlementError('PAYOUT_NOT_DRAFT', 409)

        const settled = await transaction.partnerPayout.update({
          where: { id: payout.id },
          data: {
            state: 'PAID',
            bankReference: reference,
            paidByAccountId: actorAccountId,
            paidAt: now,
          },
          include: payoutInclude,
        })
        return toPayoutSummary(settled)
      })
    },

    async listPayouts(tenantId, limit) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const payouts = await transaction.partnerPayout.findMany({
          where: { tenantId },
          include: payoutInclude,
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
        return payouts.map(toPayoutSummary)
      })
    },
  }
}

/**
 * The authoritative half of the permission check, inside the transaction that
 * moves the money.
 *
 * The route already refused an unprivileged session before reaching here. That
 * check reads the grants the session was issued with, which can be a revocation
 * behind. This one reads the rows, in the same transaction as the payout, so a
 * grant withdrawn while an operator sat on the page cannot still authorise a
 * transfer out of the platform's bank.
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
  if (!permitted) throw new PartnerSettlementError('SETTLEMENT_FORBIDDEN', 403)
}

const payoutInclude = {
  bakery: { select: { displayNameFa: true } },
  courierPartner: { select: { displayName: true } },
} satisfies Prisma.PartnerPayoutInclude

type PayoutRecord = Prisma.PartnerPayoutGetPayload<{ include: typeof payoutInclude }>

function toPayoutSummary(payout: PayoutRecord): PayoutSummary {
  return {
    id: payout.id,
    party: payout.party,
    partnerId: payout.bakeryId ?? payout.courierPartnerId ?? '',
    partnerName: payout.bakery?.displayNameFa ?? payout.courierPartner?.displayName ?? '',
    state: payout.state,
    amount: money(payout.amount),
    orderCount: payout.orderCount,
    periodStart: payout.periodStart.toISOString(),
    periodEnd: payout.periodEnd.toISOString(),
    ...(payout.bankReference && { bankReference: payout.bankReference }),
    createdAt: payout.createdAt.toISOString(),
    ...(payout.paidAt && { paidAt: payout.paidAt.toISOString() }),
  }
}

/**
 * What each partner is owed, summed in the database.
 *
 * Grouped in SQL rather than read and added here: a month of orders is a lot of
 * rows to move across a socket to produce one number per partner, and the sum
 * has to be exact — which `SUM` of a bigint is and a JavaScript reduce over
 * paginated pages quietly is not.
 */
async function readOutstanding(
  prisma: PrismaClient,
  tenantId: string,
  filter: { party?: 'BAKERY' | 'COURIER'; partnerId?: string },
): Promise<PartnerBalance[]> {
  return withTenant(prisma, tenantId, async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{
        party: 'BAKERY' | 'COURIER'
        partnerId: string
        partnerName: string
        amount: bigint
        orderCount: bigint
        oldestAt: Date
      }>
    >`
      SELECT 'BAKERY' AS "party", earning."bakeryId" AS "partnerId",
             bakery."displayNameFa" AS "partnerName",
             SUM(earning."bakeryShareAmount") AS "amount",
             COUNT(*) AS "orderCount", MIN(earning."occurredAt") AS "oldestAt"
      FROM "OrderEarning" earning
      JOIN "Bakery" bakery ON bakery."id" = earning."bakeryId"
      WHERE earning."tenantId" = ${tenantId}::uuid
        AND earning."bakeryPayoutId" IS NULL
        AND earning."bakeryShareAmount" > 0
        AND (${filter.party ?? null}::text IS NULL OR ${filter.party ?? null}::text = 'BAKERY')
        AND (${filter.partnerId ?? null}::uuid IS NULL
             OR earning."bakeryId" = ${filter.partnerId ?? null}::uuid)
      GROUP BY earning."bakeryId", bakery."displayNameFa"

      UNION ALL

      SELECT 'COURIER' AS "party", earning."courierPartnerId" AS "partnerId",
             partner."displayName" AS "partnerName",
             SUM(earning."courierShareAmount") AS "amount",
             COUNT(*) AS "orderCount", MIN(earning."occurredAt") AS "oldestAt"
      FROM "OrderEarning" earning
      JOIN "CourierPartner" partner ON partner."id" = earning."courierPartnerId"
      WHERE earning."tenantId" = ${tenantId}::uuid
        AND earning."courierPayoutId" IS NULL
        AND earning."courierShareAmount" > 0
        AND (${filter.party ?? null}::text IS NULL OR ${filter.party ?? null}::text = 'COURIER')
        AND (${filter.partnerId ?? null}::uuid IS NULL
             OR earning."courierPartnerId" = ${filter.partnerId ?? null}::uuid)
      GROUP BY earning."courierPartnerId", partner."displayName"

      ORDER BY "amount" DESC
    `
    return rows.map((row) => ({
      party: row.party,
      partnerId: row.partnerId,
      partnerName: row.partnerName,
      amount: money(row.amount),
      orderCount: Number(row.orderCount),
      oldestAt: row.oldestAt.toISOString(),
    }))
  })
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
