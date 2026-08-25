import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  ADMIN_PERMISSIONS,
  DomainError,
  OrderState,
  TransitionActor,
  productionApplies,
  transitionOrder,
  transitionProduction,
  type ProductionState,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'
import { cancelDeliveryForOrder, openDeliveryForOrder } from './delivery.js'
import type { PaymentLedgerService } from './payment-ledger.js'

/**
 * What happens to an order after a customer has paid for it.
 *
 * Until now an order stopped at placement: it was created awaiting
 * confirmation, capture marked its payment PAID, and nothing ever moved it
 * again. Production sat at `UNSCHEDULED` forever, so a bakery had no queue and
 * a customer had nothing to follow.
 *
 * The state machines themselves live in the domain package and are shared with
 * nothing else here — this module's job is to load the row, ask the domain
 * whether the step is legal for this actor, write it, and leave the audit and
 * outbox records behind.
 *
 * Two rules are enforced here rather than in the domain, because both depend on
 * rows the domain never sees:
 *
 * - **An unpaid order is not accepted.** The domain allows
 *   PENDING_CONFIRMATION → CONFIRMED; whether the money arrived is a fact about
 *   the payment aggregate. Accepting an unpaid order commits a bakery to bake
 *   bread nobody has paid for.
 * - **Production only moves while the order is live.** Before acceptance there
 *   is nothing to bake; after cancellation or completion there is nothing left.
 */
export interface OrderOperationsActor {
  accountId: string
}

export class OrderOperationsError extends Error {
  constructor(
    readonly code: string,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'OrderOperationsError'
  }
}

export interface OrderTransitionCommand {
  orderId: string
  reason: string
}

export interface ProductionTransitionCommand {
  orderId: string
  to: ProductionState
  reason: string
}

export interface OrderOperationsService {
  /** PENDING_CONFIRMATION → CONFIRMED. Refused unless the order is paid. */
  accept(
    tenantId: string,
    actor: OrderOperationsActor,
    command: OrderTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<OrderOperationOutcome>
  /** PENDING_CONFIRMATION → CANCELLED, when a bakery cannot take the order. */
  reject(
    tenantId: string,
    actor: OrderOperationsActor,
    command: OrderTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<OrderOperationOutcome>
  /** CONFIRMED → IN_FULFILLMENT, once the bread is out of the bakery's hands. */
  startFulfillment(
    tenantId: string,
    actor: OrderOperationsActor,
    command: OrderTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<OrderOperationOutcome>
  /** IN_FULFILLMENT → COMPLETED. */
  complete(
    tenantId: string,
    actor: OrderOperationsActor,
    command: OrderTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<OrderOperationOutcome>
  advanceProduction(
    tenantId: string,
    actor: OrderOperationsActor,
    command: ProductionTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<OrderOperationOutcome>
  /**
   * Cancels an order and gives the money back if any was taken.
   *
   * Refund first, then cancel. A crash between them leaves a refunded payment
   * on an order that still reads live — visible, wrong, and fixable. The
   * reverse order would leave a cancelled order the customer paid for, which
   * looks finished and is not.
   */
  cancelWithRefund(
    tenantId: string,
    actor: OrderOperationsActor,
    command: OrderTransitionCommand,
    now: Date,
    correlationId: string,
  ): Promise<CancellationOutcome>
}

export interface CancellationOutcome extends OrderOperationOutcome {
  /** What happened to the money: refunded, or nothing was ever taken. */
  refundDecision: string
  refundReasonCode: string
}

export interface OrderOperationOutcome {
  orderId: string
  publicId: string
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
  updatedAt: string
}

export interface OrderOperationsDependencies {
  /** Only used to give money back; the rest of an order's life never touches it. */
  ledgerService: PaymentLedgerService
}

export function createPrismaOrderOperationsService(
  prisma: PrismaClient,
  dependencies: OrderOperationsDependencies,
): OrderOperationsService {
  const move = (
    to: OrderState,
    /** Refuse the step unless the money is in. */
    requirePaid: boolean,
  ) =>
    async function transition(
      tenantId: string,
      actor: OrderOperationsActor,
      command: OrderTransitionCommand,
      now: Date,
      correlationId: string,
    ): Promise<OrderOperationOutcome> {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const order = await lockOrder(transaction, tenantId, command.orderId)
        if (requirePaid && order.paymentState !== 'PAID') {
          throw new OrderOperationsError('ORDER_NOT_PAID', 409)
        }

        // The domain owns which steps exist and who may take them; anything it
        // refuses is restated here with a status rather than reinterpreted.
        const step = validated(() =>
          transitionOrder({
            orderId: order.id as never,
            from: order.state as OrderState,
            to,
            actor: TransitionActor.STAFF,
            occurredAt: now,
            reason: command.reason,
            idempotencyKey: `${order.id}:${to}`,
            correlationId: correlationId as never,
          }),
        )

        // ownership-established: a staff surface gated on admin.orders.manage
        // at GLOBAL scope, and the row was already resolved and locked under
        // this tenant by `lockOrder`. Operating an order that is not the
        // operator's own is the entire job.
        const updated = await transaction.order.update({
          where: { id: order.id },
          data: { state: step.to, updatedAt: now },
        })
        await transaction.orderStateTransition.create({
          data: {
            tenantId,
            orderId: order.id,
            fromState: step.from,
            toState: step.to,
            actorType: 'STAFF',
            actorId: actor.accountId,
            notes: command.reason,
            // Derived from the order and its destination, so the same step
            // submitted twice collides rather than recording itself twice.
            idempotencyKey: `${order.id}:${to}`,
            correlationId,
            occurredAt: now,
          },
        })
        // Accepting an order *is* the commitment to deliver it, so the delivery
        // is opened here rather than when a dispatcher first looks at the board.
        // A board that only shows orders someone already thought about is a
        // board that hides the ones nobody has.
        if (step.to === OrderState.CONFIRMED) {
          await openDeliveryForOrder(transaction, tenantId, order)
        }
        if (step.to === OrderState.CANCELLED) {
          await cancelDeliveryForOrder(transaction, tenantId, order.id, now)
        }
        await recordOrderChange(transaction, tenantId, actor, {
          action: `order.${to.toLowerCase()}`,
          entityId: order.id,
          summary: `Order ${order.publicId} moved to ${to}`,
          payload: { fromState: step.from, toState: step.to, reason: command.reason },
          correlationId,
          now,
        })
        return outcome(updated)
      })
    }

  // Bound once and shared, rather than reached through `this`: the service is
  // handed around as a value, and a destructured method would lose its receiver.
  const cancel = move(OrderState.CANCELLED, false)

  return {
    accept: move(OrderState.CONFIRMED, true),
    // Rejecting an unpaid order is exactly the case that needs rejecting, so
    // this one does not require payment.
    reject: cancel,
    startFulfillment: move(OrderState.IN_FULFILLMENT, true),
    complete: move(OrderState.COMPLETED, true),

    async cancelWithRefund(tenantId, actor, command, now, correlationId) {
      // Read first, outside any write, so the refund runs against a payment
      // that already exists rather than one this call is creating.
      const target = await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          // ownership-established: a staff surface gated on admin.orders.manage
          // at GLOBAL scope; the tenant boundary holds through RLS and is
          // restated in the filter.
          return transaction.order.findFirst({
            where: { id: command.orderId, tenantId },
            select: { id: true, payment: { select: { id: true, amount: true } } },
          })
        },
        { isolationLevel: 'ReadCommitted' },
      )
      if (!target) throw new OrderOperationsError('ORDER_NOT_FOUND', 404)

      // Permission is checked here as well as inside the cancel below, because
      // the refund happens first and must not run for someone who could not
      // have cancelled.
      const permitted = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return holdsPermissionInTransaction(
          transaction,
          tenantId,
          actor.accountId,
          ADMIN_PERMISSIONS.ordersManage,
          now,
        )
      })
      if (!permitted) throw new OrderOperationsError('ORDER_OPERATION_FORBIDDEN', 403)

      let refundDecision = 'NOTHING_TO_REFUND'
      let refundReasonCode = 'NO_PAYMENT'
      if (target.payment) {
        const refunded = await dependencies.ledgerService.refund(
          tenantId,
          {
            paymentId: target.payment.id,
            requestedAmount: target.payment.amount,
            actorId: actor.accountId,
            // Derived from the order, so a retried cancellation replays onto
            // the same refund instead of posting a second one.
            idempotencyKey: `refund:${target.id}`,
          },
          now,
          correlationId,
        )
        refundDecision = refunded.decision
        refundReasonCode = refunded.reasonCode
        // A quarantined refund is a refusal to move money that nobody
        // understands yet. Cancelling on top of it would bury the problem
        // under a finished-looking order.
        if (refunded.decision === 'QUARANTINE') {
          throw new OrderOperationsError('REFUND_QUARANTINED', 409)
        }
      }

      const cancelled = await cancel(tenantId, actor, command, now, correlationId)
      return { ...cancelled, refundDecision, refundReasonCode }
    },

    async advanceProduction(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const order = await lockOrder(transaction, tenantId, command.orderId)
        if (!productionApplies(order.state as OrderState)) {
          throw new OrderOperationsError('PRODUCTION_NOT_APPLICABLE', 409)
        }

        validated(() =>
          transitionProduction({
            from: order.productionState as ProductionState,
            to: command.to,
            actor: TransitionActor.STAFF,
          }),
        )

        // ownership-established: same staff surface and the same locked row —
        // see `lockOrder`, which resolved it under this tenant.
        const updated = await transaction.order.update({
          where: { id: order.id },
          data: { productionState: command.to, updatedAt: now },
        })
        await recordOrderChange(transaction, tenantId, actor, {
          action: 'order.production_advanced',
          entityId: order.id,
          summary: `Order ${order.publicId} production moved to ${command.to}`,
          payload: {
            fromProductionState: order.productionState,
            toProductionState: command.to,
            reason: command.reason,
          },
          correlationId,
          now,
        })
        return outcome(updated)
      })
    },
  }
}

/**
 * Loads the order for update.
 *
 * Locked rather than merely read: two operators looking at the same queue can
 * accept the same order at the same moment, and the second must see the first's
 * result rather than write over it.
 */
async function lockOrder(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
): Promise<{
  id: string
  publicId: string
  state: string
  paymentState: string
  productionState: string
  bakeryBranchId: string
  requestedDeliveryAt: Date | null
}> {
  await transaction.$queryRaw`
    SELECT "id" FROM "Order"
    WHERE "id" = ${orderId}::uuid AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE`
  // ownership-established: this is a staff surface, gated on
  // admin.orders.manage at GLOBAL scope. Operating an order that is not the
  // operator's own is the entire job; the tenant boundary still holds through
  // RLS and is restated in the filter.
  const order = await transaction.order.findFirst({
    where: { id: orderId, tenantId },
    select: {
      id: true,
      publicId: true,
      state: true,
      paymentState: true,
      productionState: true,
      // Only used when acceptance opens the delivery: which branch the courier
      // collects from, and when the customer asked for it.
      bakeryBranchId: true,
      requestedDeliveryAt: true,
    },
  })
  if (!order) throw new OrderOperationsError('ORDER_NOT_FOUND', 404)
  return order
}

/** Runs a domain rule, restating its refusal with a status. */
function validated<T>(rule: () => T): T {
  try {
    return rule()
  } catch (error) {
    if (error instanceof DomainError) {
      throw new OrderOperationsError(
        error.code === 'UNAUTHORIZED_ORDER_TRANSITION' ||
          error.code === 'UNAUTHORIZED_PRODUCTION_TRANSITION'
          ? 'TRANSITION_NOT_PERMITTED'
          : 'TRANSITION_NOT_ALLOWED',
        error.code.startsWith('UNAUTHORIZED') ? 403 : 409,
      )
    }
    throw error
  }
}

function outcome(order: {
  id: string
  publicId: string
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
  updatedAt: Date
}): OrderOperationOutcome {
  return {
    orderId: order.id,
    publicId: order.publicId,
    state: order.state,
    paymentState: order.paymentState,
    productionState: order.productionState,
    deliveryState: order.deliveryState,
    updatedAt: order.updatedAt.toISOString(),
  }
}

interface OrderChange {
  action: string
  entityId: string
  summary: string
  payload: Prisma.InputJsonObject
  correlationId: string
  now: Date
}

async function recordOrderChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: OrderOperationsActor,
  change: OrderChange,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      action: change.action,
      entityType: 'order',
      entityId: change.entityId,
      summary: change.summary,
      correlationId: change.correlationId,
      metadata: change.payload,
      occurredAt: change.now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: change.action,
      aggregateType: 'order',
      aggregateId: change.entityId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      correlationId: change.correlationId,
      // An order's progress is what the customer transacted for, so notifying
      // them about it needs no separate consent.
      consentBasis: 'TRANSACTIONAL',
      payload: change.payload,
      occurredAt: change.now,
    },
  })
}

async function writeTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  actor: OrderOperationsActor,
  now: Date,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        const permitted = await holdsPermissionInTransaction(
          transaction,
          tenantId,
          actor.accountId,
          ADMIN_PERMISSIONS.ordersManage,
          now,
        )
        if (!permitted) throw new OrderOperationsError('ORDER_OPERATION_FORBIDDEN', 403)
        return operation(transaction)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object') {
      const code = Reflect.get(error, 'code')
      // A duplicate transition key is the same step arriving twice, which is a
      // conflict rather than a fault: someone else already took it.
      if (code === 'P2002' || code === 'P2034') {
        throw new OrderOperationsError('ORDER_WRITE_CONFLICT', 409)
      }
    }
    throw error
  }
}
