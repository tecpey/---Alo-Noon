import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  FinancialTransactionType,
  PaymentAggregateState,
  cashCollectionJournal,
  cashRemittanceJournal,
  evaluateCashOnDelivery,
  postDoubleEntry,
  reconcileRemittance,
  type CashOnDeliveryDecision,
  type CashOnDeliveryPolicy,
} from '@alo-noon/domain'

import type { PaymentLedgerService } from './payment-ledger.js'

/**
 * Taking cash at the door, and getting it back off the road.
 *
 * Three acts, and they are separate on purpose. A *policy* decides whether this
 * order may be paid in cash at all, before anything is promised. A *collection*
 * records that a courier took the money — the order is paid from that moment,
 * and the platform is owed by the courier. A *remittance* records the courier
 * handing it in, which is the only act that turns the claim into money the
 * business can actually spend.
 *
 * Between collection and remittance sits the number a delivery business needs
 * on a whiteboard every evening: how much cash is out on the road tonight, and
 * with whom. Nothing else in this system can answer that, which is why the
 * receivable is its own account rather than a note on an order.
 */

export class CashOnDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'CashOnDeliveryError'
  }
}

export interface CourierCashPosition {
  readonly courierId: string
  readonly courierName: string
  readonly orderCount: number
  readonly outstandingAmount: bigint
}

export interface RemittanceCommand {
  readonly courierId: string
  /** The orders this courier is settling. Never "everything they have". */
  readonly orderIds: readonly string[]
  /** What was counted onto the desk, in Rial. */
  readonly declaredAmount: bigint
  readonly countedById: string
  readonly idempotencyKey: string
}

export interface RemittanceResult {
  readonly remittanceId: string
  readonly courierId: string
  readonly orderCount: number
  readonly expectedAmount: bigint
  readonly declaredAmount: bigint
}

export interface CashOnDeliveryService {
  /**
   * Whether this order may be paid in cash, for this customer, in this city.
   */
  decideForOrder(
    tenantId: string,
    input: { cityId: string; customerId: string; orderTotal: bigint },
  ): Promise<CashOnDeliveryDecision>
  /**
   * Records that a courier took the cash for a delivered order.
   *
   * Idempotent and safe to call again: the ledger refuses a second capture for
   * the same payment, so a retried delivery report cannot post the money twice.
   */
  collectForOrder(
    tenantId: string,
    orderId: string,
    now: Date,
    correlationId: string,
  ): Promise<{ collected: boolean; reasonCode: string }>
  /**
   * Collects for every delivered cash order that has not been collected yet.
   *
   * The recovery path. Collection happens after the delivery transaction
   * commits, so a crash in between leaves an order delivered and unpaid; this
   * finds those and finishes them rather than leaving money uncounted because
   * a process died at the wrong moment.
   */
  sweep(tenantId: string, now: Date, correlationId: string): Promise<{ collected: number }>
  /** How much cash each courier is currently carrying. */
  outstandingByCourier(tenantId: string): Promise<readonly CourierCashPosition[]>
  /** Records a courier handing cash in, and posts it to the bank. */
  recordRemittance(
    tenantId: string,
    command: RemittanceCommand,
    now: Date,
    correlationId: string,
  ): Promise<RemittanceResult>
}

export interface CashOnDeliveryDependencies {
  ledger: PaymentLedgerService
  maxSerializationAttempts?: number
}

export function createPrismaCashOnDeliveryService(
  prisma: PrismaClient,
  dependencies: CashOnDeliveryDependencies,
): CashOnDeliveryService {
  const maxAttempts = dependencies.maxSerializationAttempts ?? 3

  return {
    async decideForOrder(tenantId, input) {
      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const city = await transaction.city.findFirst({
          where: { id: input.cityId, tenantId },
          select: {
            cashOnDeliveryEnabled: true,
            cashOnDeliveryCeiling: true,
            cashOnDeliveryMinimumOrders: true,
          },
        })
        // A city that does not exist offers nothing. Failing open here would let
        // a bad city identifier turn into an uncollectable order.
        if (!city) return { allowed: false, reason: 'CASH_ON_DELIVERY_DISABLED' as const }

        const policy: CashOnDeliveryPolicy = {
          enabled: city.cashOnDeliveryEnabled,
          ...(city.cashOnDeliveryCeiling !== null && {
            ceilingAmount: city.cashOnDeliveryCeiling,
          }),
          minimumCompletedOrders: city.cashOnDeliveryMinimumOrders,
        }
        const completed = await transaction.order.count({
          where: { tenantId, customerId: input.customerId, state: 'COMPLETED' },
        })
        return evaluateCashOnDelivery(policy, {
          orderTotal: input.orderTotal,
          customerCompletedOrders: completed,
        })
      })
    },

    async collectForOrder(tenantId, orderId, now, correlationId) {
      const order = await tenantTransaction(prisma, tenantId, async (transaction) => {
        // ownership-established: a system collection keyed on an order this
        // tenant's courier has just delivered; the tenant filter is the boundary.
        return transaction.order.findFirst({
          where: { id: orderId, tenantId },
          select: {
            id: true,
            paymentMethod: true,
            paymentState: true,
            totalAmount: true,
            payment: { select: { id: true, state: true, amount: true } },
          },
        })
      })
      if (!order) throw new CashOnDeliveryError('ORDER_NOT_FOUND', 404)
      if (order.paymentMethod !== 'CASH_ON_DELIVERY') {
        return { collected: false, reasonCode: 'NOT_A_CASH_ORDER' }
      }
      // The payment is created when the order is placed, while it is still
      // payable. If it is missing, something skipped checkout and the money has
      // no aggregate to land on — a refusal an operator can chase, not a
      // silent success.
      if (!order.payment) throw new CashOnDeliveryError('CASH_PAYMENT_MISSING', 409)
      if (order.payment.state === PaymentAggregateState.CAPTURED) {
        return { collected: false, reasonCode: 'ALREADY_COLLECTED' }
      }

      const key = (step: string) => `cash-collect:${order.id}:${step}`
      // The same walk a gateway settlement makes. Cash skips no states: the
      // aggregate's history should read the same whether the money arrived
      // through a bank or through a courier's hand.
      for (const target of [PaymentAggregateState.PENDING, PaymentAggregateState.AUTHORIZED]) {
        await dependencies.ledger.transition(
          tenantId,
          {
            paymentId: order.payment.id,
            to: target,
            actor: 'SYSTEM',
            idempotencyKey: key(target.toLowerCase()),
          },
          now,
          correlationId,
        )
      }
      await dependencies.ledger.capture(
        tenantId,
        {
          paymentId: order.payment.id,
          idempotencyKey: key('capture'),
          // The debit is the whole point: a claim on a courier, not a balance
          // at a bank.
          entries: cashCollectionJournal(order.payment.amount),
        },
        now,
        correlationId,
      )
      return { collected: true, reasonCode: 'CASH_COLLECTED' }
    },

    async sweep(tenantId, now, correlationId) {
      const pending = await tenantTransaction(prisma, tenantId, async (transaction) => {
        // ownership-established: a system sweep over this tenant's own delivered
        // cash orders; there is no customer to scope to.
        return transaction.order.findMany({
          where: {
            tenantId,
            paymentMethod: 'CASH_ON_DELIVERY',
            paymentState: { not: 'PAID' },
            fulfillment: { deliveryTask: { state: 'DELIVERED' } },
          },
          select: { id: true },
          take: 200,
        })
      })
      let collected = 0
      for (const order of pending) {
        const result = await this.collectForOrder(tenantId, order.id, now, correlationId)
        if (result.collected) collected += 1
      }
      return { collected }
    },

    async outstandingByCourier(tenantId) {
      const rows = await tenantTransaction(
        prisma,
        tenantId,
        async (transaction) =>
          transaction.$queryRaw<
            Array<{
              courierId: string
              courierName: string
              orderCount: bigint
              outstanding: bigint
            }>
          >`
          SELECT courier."id" AS "courierId",
                 courier."displayName" AS "courierName",
                 COUNT(*) AS "orderCount",
                 COALESCE(SUM(payment."amount"), 0) AS "outstanding"
          FROM "Payment" payment
          JOIN "Order" o ON o."id" = payment."orderId"
          JOIN "Fulfillment" f ON f."orderId" = o."id"
          JOIN "DeliveryTask" task ON task."fulfillmentId" = f."id"
          JOIN "DeliveryAssignment" assignment ON assignment."deliveryTaskId" = task."id"
          JOIN "Courier" courier ON courier."id" = assignment."courierId"
          WHERE payment."tenantId" = ${tenantId}::uuid
            AND payment."method" = 'CASH_ON_DELIVERY'
            AND payment."state" = 'CAPTURED'
            AND assignment."state" = 'COMPLETED'
            -- Not yet handed in. The item row is written in the same
            -- transaction as the remittance posting, so its absence is the
            -- authoritative "still carrying it".
            AND NOT EXISTS (
              SELECT 1 FROM "CourierCashRemittanceItem" item
              WHERE item."paymentId" = payment."id" AND item."tenantId" = payment."tenantId"
            )
          GROUP BY courier."id", courier."displayName"
          ORDER BY "outstanding" DESC
        `,
      )
      return rows.map((row) => ({
        courierId: row.courierId,
        courierName: row.courierName,
        orderCount: Number(row.orderCount),
        outstandingAmount: BigInt(row.outstanding),
      }))
    },

    async recordRemittance(tenantId, command, now, correlationId) {
      if (command.orderIds.length === 0) {
        throw new CashOnDeliveryError('REMITTANCE_EMPTY', 422)
      }
      if (command.idempotencyKey.trim().length < 16 || command.idempotencyKey.length > 128) {
        throw new CashOnDeliveryError('INVALID_IDEMPOTENCY_KEY', 422)
      }

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.courierCashRemittance.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
          include: { items: { select: { id: true } } },
        })
        if (replay) {
          if (replay.courierId !== command.courierId) {
            throw new CashOnDeliveryError('IDEMPOTENCY_KEY_CONFLICT', 409)
          }
          return {
            remittanceId: replay.id,
            courierId: replay.courierId,
            orderCount: replay.items.length,
            expectedAmount: replay.expectedAmount,
            declaredAmount: replay.declaredAmount,
          }
        }

        // ownership-established: a staff cash desk gated on admin.orders.manage.
        // There is no single customer to scope to — a courier's bag holds many
        // customers' orders — and every payment is re-read here rather than
        // trusted from the request, then checked below against the courier who
        // actually carried it.
        const payments = await transaction.payment.findMany({
          where: {
            tenantId,
            orderId: { in: [...command.orderIds] },
            method: 'CASH_ON_DELIVERY',
            state: 'CAPTURED',
          },
          select: {
            id: true,
            orderId: true,
            amount: true,
            order: {
              select: {
                fulfillment: {
                  select: {
                    deliveryTask: {
                      select: {
                        state: true,
                        assignments: {
                          where: { state: 'COMPLETED' },
                          select: { courierId: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        })
        if (payments.length !== command.orderIds.length) {
          throw new CashOnDeliveryError('REMITTANCE_ORDER_NOT_COLLECTIBLE', 422)
        }
        for (const payment of payments) {
          const carriedByThisCourier =
            payment.order.fulfillment?.deliveryTask?.assignments.some(
              (assignment) => assignment.courierId === command.courierId,
            ) ?? false
          if (!carriedByThisCourier) {
            throw new CashOnDeliveryError('REMITTANCE_COURIER_MISMATCH', 422)
          }
        }

        const reconciliation = reconcileRemittance({
          orderAmounts: payments.map((payment) => payment.amount),
          declaredAmount: command.declaredAmount,
        })
        // A courier who is short has a dispute, and a dispute is a decision a
        // person makes and records. Nothing is posted until the count matches,
        // because absorbing a shortfall silently would let cash leak out of the
        // business through a hole that balances perfectly.
        if (!reconciliation.balanced) {
          throw new CashOnDeliveryError('REMITTANCE_DOES_NOT_BALANCE', 422)
        }

        const remittance = await transaction.courierCashRemittance.create({
          data: {
            tenantId,
            courierId: command.courierId,
            expectedAmount: reconciliation.expectedAmount,
            declaredAmount: command.declaredAmount,
            countedById: command.countedById,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
            items: {
              create: payments.map((payment) => ({
                tenantId,
                orderId: payment.orderId,
                paymentId: payment.id,
                amount: payment.amount,
              })),
            },
          },
          select: { id: true },
        })

        // One posting per order, not one for the bag. The unique posting per
        // payment is what makes an order's cash remittable exactly once — which
        // is the invariant that matters when somebody is standing at a desk
        // with a handful of notes and a retry button.
        for (const payment of payments) {
          const entries = cashRemittanceJournal(payment.amount)
          const accounts = await loadPostableAccounts(
            transaction,
            tenantId,
            entries.map((entry) => entry.accountCode),
          )
          postDoubleEntry({
            paymentId: payment.id,
            orderId: payment.orderId,
            type: FinancialTransactionType.CASH_REMITTANCE,
            amount: payment.amount,
            currency: 'IRR',
            idempotencyKey: `cash-remittance:${remittance.id}:${payment.id}`,
            correlationId,
            occurredAt: now,
            lines: entries.map((entry) => ({
              accountId: accounts.get(entry.accountCode)!.id,
              side: entry.side,
              amount: entry.amount,
              currency: 'IRR' as const,
            })),
          })
          await transaction.financialTransaction.create({
            data: {
              tenantId,
              paymentId: payment.id,
              orderId: payment.orderId,
              type: 'CASH_REMITTANCE',
              amount: payment.amount,
              currency: 'IRR',
              idempotencyKey: `cash-remittance:${remittance.id}:${payment.id}`,
              correlationId,
              occurredAt: now,
              postedAt: now,
              entries: {
                create: entries.map((entry, index) => ({
                  tenantId,
                  ledgerAccountId: accounts.get(entry.accountCode)!.id,
                  sequence: index + 1,
                  side: entry.side,
                  amount: entry.amount,
                  currency: 'IRR',
                })),
              },
            },
          })
        }

        await transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'STAFF',
            actorId: command.countedById,
            action: 'cash.remittance.recorded',
            entityType: 'courierCashRemittance',
            entityId: remittance.id,
            summary: `Courier cash remittance of ${reconciliation.expectedAmount} IRR`,
            correlationId,
            metadata: {
              courierId: command.courierId,
              orderCount: payments.length,
              expectedAmount: reconciliation.expectedAmount.toString(),
            },
            occurredAt: now,
          },
        })

        return {
          remittanceId: remittance.id,
          courierId: command.courierId,
          orderCount: payments.length,
          expectedAmount: reconciliation.expectedAmount,
          declaredAmount: command.declaredAmount,
        }
      })
    },
  }
}

async function loadPostableAccounts(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, { id: string }>> {
  const wanted = [...new Set(codes)]
  const accounts = await transaction.ledgerAccount.findMany({
    where: { tenantId, code: { in: wanted }, isActive: true, isPostable: true, currency: 'IRR' },
    select: { id: true, code: true },
  })
  if (accounts.length !== wanted.length) {
    // Almost always the courier receivable account, on a tenant whose chart was
    // provisioned before it existed. Refusing is right: posting cash into an
    // account that is not there would either fail deep inside the write or,
    // worse, land somewhere it was never meant to.
    throw new CashOnDeliveryError('LEDGER_ACCOUNT_NOT_FOUND', 409)
  }
  return new Map(accounts.map((account) => [account.code, { id: account.id }]))
}

async function tenantTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

async function serializableWithRetry<T>(
  prisma: PrismaClient,
  tenantId: string,
  maxAttempts: number,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          const result = await operation(transaction)
          // Prisma 5 can resolve an interactive transaction callback even when a
          // deferred constraint subsequently rejects COMMIT. Every financial
          // guard has to have spoken before a caller is told this worked.
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
          return result
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (error instanceof CashOnDeliveryError) throw error
      if (!isRetryableConflict(error) || attempt === maxAttempts) throw error
    }
  }
  throw new CashOnDeliveryError('CASH_CONCURRENCY_CONFLICT', 409)
}

function isRetryableConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  // 40001 serialization failure, 40P01 deadlock. Both mean "try again", and
  // both are ordinary under the concurrency a busy evening produces.
  return code === 'P2034' || code === '40001' || code === '40P01'
}

/** A correlation id for a collection nobody supplied one for. */
export function cashCorrelationId(): string {
  return randomUUID()
}
