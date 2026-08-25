import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@alo-noon/database'
import {
  ADMIN_PERMISSIONS,
  DomainError,
  DeliveryTaskState,
  courierCanBeOffered,
  deliveryTaskIsTerminal,
  orderDeliveryStateFor,
  transitionDeliveryAssignment,
  transitionDeliveryTask,
  TransitionActor,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'

/**
 * Dispatch, and the courier's side of it.
 *
 * The schema has carried delivery tasks and assignments since the beginning
 * with nothing driving them. What was missing was not tables but the split
 * between two jobs: a dispatcher decides who delivers, a courier reports what
 * happened, and neither may do the other's half. The domain refuses the crossing
 * cases; this service is what makes each side's half reach the database, along
 * with the one thing the domain cannot know — whether the person asking is the
 * courier the work was offered to.
 *
 * An order carries its own `deliveryState` so a customer never sees the
 * dispatcher's board. It is derived from the task on every write rather than set
 * by hand, because an order saying OUT_FOR_DELIVERY while its delivery says
 * DELIVERED is a support call nobody can answer.
 */
export interface DispatchActor {
  accountId: string
}

export interface CourierActor {
  courierId: string
}

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'DeliveryError'
  }
}

export interface DeliveryTaskView {
  taskId: string
  orderId: string
  orderPublicId: string
  state: string
  attemptCount: number
  recipientName: string
  address: string
  bakeryName: string
  totalAmount: string
  deliverBefore: string | null
  courier: { courierId: string; displayName: string; assignmentId: string; state: string } | null
  updatedAt: string
}

export interface CourierView {
  courierId: string
  displayName: string
  mobileE164: string
  status: string
  activeTasks: number
}

/** What a courier may assert about a task they hold. */
export const COURIER_REPORTS = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED'] as const
export type CourierReport = (typeof COURIER_REPORTS)[number]

export interface DeliveryService {
  listTasks(tenantId: string, openOnly: boolean): Promise<DeliveryTaskView[]>
  listCouriers(tenantId: string): Promise<CourierView[]>
  offer(
    tenantId: string,
    actor: DispatchActor,
    command: { taskId: string; courierId: string },
    now: Date,
    correlationId: string,
  ): Promise<DeliveryTaskView>
  release(
    tenantId: string,
    actor: DispatchActor,
    command: { taskId: string; reason?: string | undefined },
    now: Date,
    correlationId: string,
  ): Promise<DeliveryTaskView>

  findCourierForAccount(tenantId: string, accountId: string): Promise<CourierActor | null>
  listCourierTasks(tenantId: string, courier: CourierActor): Promise<DeliveryTaskView[]>
  respond(
    tenantId: string,
    courier: CourierActor,
    command: { taskId: string; accept: boolean },
    now: Date,
    correlationId: string,
  ): Promise<DeliveryTaskView>
  report(
    tenantId: string,
    courier: CourierActor,
    command: { taskId: string; to: CourierReport; reasonCode?: string | undefined },
    now: Date,
    correlationId: string,
  ): Promise<DeliveryTaskView>
}

const TASK_INCLUDE = Prisma.validator<Prisma.DeliveryTaskInclude>()({
  fulfillment: {
    include: {
      order: {
        select: {
          id: true,
          publicId: true,
          recipientNameSnapshot: true,
          deliveryAddressSnapshot: true,
          bakeryNameSnapshot: true,
          totalAmount: true,
        },
      },
    },
  },
  assignments: {
    where: { state: { in: ['OFFERED', 'ACCEPTED'] } },
    include: { courier: { select: { id: true, displayName: true } } },
    take: 1,
  },
})

type TaskRecord = Prisma.DeliveryTaskGetPayload<{ include: typeof TASK_INCLUDE }>

export function createPrismaDeliveryService(prisma: PrismaClient): DeliveryService {
  return {
    async listTasks(tenantId, openOnly) {
      const tasks = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.deliveryTask.findMany({
          where: {
            tenantId,
            ...(openOnly && { state: { notIn: ['DELIVERED', 'CANCELLED'] } }),
          },
          include: TASK_INCLUDE,
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
      )
      return tasks.map(taskView)
    },

    async listCouriers(tenantId) {
      const couriers = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.courier.findMany({
          where: { tenantId, status: { not: 'OFFBOARDED' } },
          include: {
            _count: { select: { assignments: { where: { state: 'ACCEPTED' } } } },
          },
          orderBy: { displayName: 'asc' },
        }),
      )
      return couriers.map((courier) => ({
        courierId: courier.id,
        displayName: courier.displayName,
        mobileE164: courier.mobileE164,
        status: courier.status,
        // How loaded someone is, so a dispatcher does not hand five orders to
        // the first name in the list.
        activeTasks: courier._count.assignments,
      }))
    },

    async offer(tenantId, actor, command, now, correlationId) {
      return dispatchTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const task = await lockTask(transaction, tenantId, command.taskId)
        const courier = await transaction.courier.findFirst({
          where: { id: command.courierId, tenantId },
          select: { id: true, status: true, displayName: true },
        })
        if (!courier) throw new DeliveryError('COURIER_NOT_FOUND', 404)
        if (!courierCanBeOffered(courier.status)) {
          throw new DeliveryError('COURIER_UNAVAILABLE', 409)
        }

        const step = validated(() =>
          transitionDeliveryTask({
            from: task.state as DeliveryTaskState,
            to: DeliveryTaskState.ASSIGNMENT_PENDING,
            actor: TransitionActor.STAFF,
          }),
        )

        // An outstanding offer is withdrawn before a new one is made. Two live
        // offers for one order is two couriers driving to the same bakery.
        await cancelOpenAssignments(transaction, task.id, now)
        await transaction.deliveryAssignment.create({
          data: {
            tenantId,
            deliveryTaskId: task.id,
            courierId: courier.id,
            state: 'OFFERED',
            offeredAt: now,
          },
        })
        const updated = await applyTaskState(transaction, task, step.to, now, {})
        await recordDeliveryChange(transaction, tenantId, 'STAFF', actor.accountId, {
          action: 'delivery.offered',
          entityId: task.id,
          summary: `Delivery for order ${task.fulfillment.order.publicId} offered to ${courier.displayName}`,
          payload: { courierId: courier.id, toState: step.to },
          correlationId,
          now,
        })
        return updated
      })
    },

    async release(tenantId, actor, command, now, correlationId) {
      return dispatchTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const task = await lockTask(transaction, tenantId, command.taskId)
        const step = validated(() =>
          transitionDeliveryTask({
            from: task.state as DeliveryTaskState,
            to: DeliveryTaskState.UNASSIGNED,
            actor: TransitionActor.STAFF,
          }),
        )
        await cancelOpenAssignments(transaction, task.id, now)
        const updated = await applyTaskState(transaction, task, step.to, now, {})
        await recordDeliveryChange(transaction, tenantId, 'STAFF', actor.accountId, {
          action: 'delivery.released',
          entityId: task.id,
          summary: `Delivery for order ${task.fulfillment.order.publicId} returned to the pool`,
          payload: { fromState: step.from, reason: command.reason ?? null },
          correlationId,
          now,
        })
        return updated
      })
    },

    /**
     * Which courier a signed-in account is, if any.
     *
     * The link is the mobile number, not a foreign key. A courier is a person
     * an operator wrote down, and requiring them to be provisioned against an
     * identity account before they could sign in would mean nobody could sign
     * in until someone had signed in. The partial unique index on the courier
     * record is what keeps this lookup unambiguous.
     */
    async findCourierForAccount(tenantId, accountId) {
      const account = await prisma.identityAccount.findFirst({
        where: { id: accountId, status: 'ACTIVE' },
        select: { mobileE164: true },
      })
      if (!account) return null
      const courier = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.courier.findFirst({
          where: { tenantId, mobileE164: account.mobileE164, status: { not: 'OFFBOARDED' } },
          select: { id: true },
        }),
      )
      return courier ? { courierId: courier.id } : null
    },

    async listCourierTasks(tenantId, courier) {
      const tasks = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.deliveryTask.findMany({
          where: {
            tenantId,
            state: { notIn: ['DELIVERED', 'CANCELLED'] },
            assignments: {
              some: { courierId: courier.courierId, state: { in: ['OFFERED', 'ACCEPTED'] } },
            },
          },
          include: TASK_INCLUDE,
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
      )
      return tasks.map(taskView)
    },

    async respond(tenantId, courier, command, now, correlationId) {
      return courierTransaction(prisma, tenantId, async (transaction) => {
        const task = await lockTask(transaction, tenantId, command.taskId)
        const assignment = await openAssignmentFor(transaction, task.id, courier.courierId)
        if (!assignment || assignment.state !== 'OFFERED') {
          throw new DeliveryError('OFFER_NOT_OPEN', 409)
        }

        const answer = command.accept ? 'ACCEPTED' : 'REJECTED'
        validated(() =>
          transitionDeliveryAssignment({
            from: 'OFFERED',
            to: answer,
            actor: TransitionActor.COURIER,
          }),
        )
        const step = validated(() =>
          transitionDeliveryTask({
            from: task.state as DeliveryTaskState,
            // A refusal returns the task to the pool. That is a dispatcher-only
            // step, so the actor is the system carrying out the consequence of
            // the courier's answer rather than the courier reaching past it.
            to: command.accept ? DeliveryTaskState.ASSIGNED : DeliveryTaskState.UNASSIGNED,
            actor: command.accept ? TransitionActor.COURIER : TransitionActor.STAFF,
          }),
        )

        await transaction.deliveryAssignment.update({
          where: { id: assignment.id },
          data: { state: answer, respondedAt: now, ...(command.accept ? {} : { endedAt: now }) },
        })
        const updated = await applyTaskState(transaction, task, step.to, now, {})
        await recordDeliveryChange(transaction, tenantId, 'COURIER', courier.courierId, {
          action: command.accept ? 'delivery.accepted' : 'delivery.declined',
          entityId: task.id,
          summary: `Courier ${command.accept ? 'accepted' : 'declined'} order ${task.fulfillment.order.publicId}`,
          payload: { toState: step.to },
          correlationId,
          now,
        })
        return updated
      })
    },

    async report(tenantId, courier, command, now, correlationId) {
      return courierTransaction(prisma, tenantId, async (transaction) => {
        const task = await lockTask(transaction, tenantId, command.taskId)
        const assignment = await openAssignmentFor(transaction, task.id, courier.courierId)
        // The one check the domain cannot make: it knows a courier may report a
        // pickup, not that *this* courier holds *this* order.
        if (!assignment || assignment.state !== 'ACCEPTED') {
          throw new DeliveryError('DELIVERY_NOT_YOURS', 403)
        }
        if (command.to === 'FAILED' && !command.reasonCode) {
          throw new DeliveryError('FAILURE_REASON_REQUIRED', 422)
        }

        const step = validated(() =>
          transitionDeliveryTask({
            from: task.state as DeliveryTaskState,
            to: command.to,
            actor: TransitionActor.COURIER,
          }),
        )

        const finished = step.to === DeliveryTaskState.DELIVERED
        if (finished) {
          validated(() =>
            transitionDeliveryAssignment({
              from: 'ACCEPTED',
              to: 'COMPLETED',
              actor: TransitionActor.SYSTEM,
            }),
          )
          await transaction.deliveryAssignment.update({
            where: { id: assignment.id },
            data: { state: 'COMPLETED', endedAt: now },
          })
        }

        const updated = await applyTaskState(transaction, task, step.to, now, {
          ...(command.to === 'FAILED' &&
            command.reasonCode && {
              failureReasonCode: command.reasonCode,
              // Counted here rather than when the task returns to the pool, so a
              // dispatcher can see a third attempt coming before they make it.
              attemptCount: task.attemptCount + 1,
            }),
        })
        await recordDeliveryChange(transaction, tenantId, 'COURIER', courier.courierId, {
          action: `delivery.${step.to.toLowerCase()}`,
          entityId: task.id,
          summary: `Order ${task.fulfillment.order.publicId} delivery moved to ${step.to}`,
          payload: { toState: step.to, reasonCode: command.reasonCode ?? null },
          correlationId,
          now,
        })
        return updated
      })
    },
  }
}

/**
 * Writes the task's new state and the order's view of it in one act.
 *
 * The fulfillment moves too: HANDED_OFF once a courier has the bag, COMPLETED
 * when it arrives. Keeping the three in step is the whole reason this is one
 * function rather than three calls at each site.
 */
async function applyTaskState(
  transaction: Prisma.TransactionClient,
  task: TaskRecord,
  to: DeliveryTaskState,
  now: Date,
  extra: Prisma.DeliveryTaskUpdateInput,
): Promise<DeliveryTaskView> {
  const updated = await transaction.deliveryTask.update({
    where: { id: task.id },
    data: { state: to, ...extra },
    include: TASK_INCLUDE,
  })

  // ownership-established: the order was reached through its own delivery task,
  // which was resolved and locked under this tenant. There is no caller-supplied
  // order id anywhere on this path.
  await transaction.order.update({
    where: { id: task.fulfillment.orderId },
    data: { deliveryState: orderDeliveryStateFor(to), updatedAt: now },
  })

  const fulfillmentState =
    to === DeliveryTaskState.PICKED_UP
      ? 'HANDED_OFF'
      : to === DeliveryTaskState.DELIVERED
        ? 'COMPLETED'
        : to === DeliveryTaskState.CANCELLED
          ? 'CANCELLED'
          : null
  if (fulfillmentState) {
    await transaction.fulfillment.update({
      where: { id: task.fulfillmentId },
      data: {
        state: fulfillmentState,
        ...(to === DeliveryTaskState.PICKED_UP && { handoffAt: now }),
      },
    })
  }

  return taskView(updated)
}

/**
 * Creates the delivery for an order that was just accepted.
 *
 * Called from order acceptance rather than lazily when a dispatcher looks,
 * because accepting an order *is* the commitment to deliver it: a board that
 * only shows orders someone has already thought about is a board that hides the
 * ones nobody has.
 */
export async function openDeliveryForOrder(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  order: { id: string; bakeryBranchId: string; requestedDeliveryAt: Date | null },
): Promise<void> {
  const existing = await transaction.fulfillment.findFirst({
    where: { orderId: order.id, tenantId },
    select: { id: true, deliveryTask: { select: { id: true } } },
  })
  const fulfillmentId =
    existing?.id ??
    (
      await transaction.fulfillment.create({
        data: {
          tenantId,
          orderId: order.id,
          bakeryBranchId: order.bakeryBranchId,
          type: 'BAKERY_PICKUP_DELIVERY',
          state: 'PLANNED',
        },
        select: { id: true },
      })
    ).id
  if (existing?.deliveryTask) return

  await transaction.deliveryTask.create({
    data: {
      tenantId,
      fulfillmentId,
      state: 'UNASSIGNED',
      ...(order.requestedDeliveryAt && { deliverBefore: order.requestedDeliveryAt }),
    },
  })
}

/**
 * Ends a delivery because its order ended.
 *
 * Silent when there is nothing to cancel: an order rejected before it was ever
 * accepted has no delivery, and refusing the cancellation for that reason would
 * block the refund behind a task that never existed.
 */
export async function cancelDeliveryForOrder(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  now: Date,
): Promise<void> {
  const task = await transaction.deliveryTask.findFirst({
    where: { tenantId, fulfillment: { orderId } },
    select: { id: true, state: true },
  })
  if (!task || deliveryTaskIsTerminal(task.state as DeliveryTaskState)) return

  transitionDeliveryTask({
    from: task.state as DeliveryTaskState,
    to: DeliveryTaskState.CANCELLED,
    actor: TransitionActor.SYSTEM,
  })
  await transaction.deliveryAssignment.updateMany({
    where: { deliveryTaskId: task.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
    data: { state: 'CANCELLED', endedAt: now },
  })
  await transaction.deliveryTask.update({ where: { id: task.id }, data: { state: 'CANCELLED' } })
}

async function cancelOpenAssignments(
  transaction: Prisma.TransactionClient,
  taskId: string,
  now: Date,
): Promise<void> {
  await transaction.deliveryAssignment.updateMany({
    where: { deliveryTaskId: taskId, state: { in: ['OFFERED', 'ACCEPTED'] } },
    data: { state: 'CANCELLED', endedAt: now },
  })
}

async function openAssignmentFor(
  transaction: Prisma.TransactionClient,
  taskId: string,
  courierId: string,
): Promise<{ id: string; state: string } | null> {
  return transaction.deliveryAssignment.findFirst({
    where: { deliveryTaskId: taskId, courierId, state: { in: ['OFFERED', 'ACCEPTED'] } },
    select: { id: true, state: true },
    orderBy: { offeredAt: 'desc' },
  })
}

async function lockTask(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
): Promise<TaskRecord> {
  const task = await transaction.deliveryTask.findFirst({
    where: { id: taskId, tenantId },
    include: TASK_INCLUDE,
  })
  if (!task) throw new DeliveryError('DELIVERY_NOT_FOUND', 404)
  return task
}

function taskView(task: TaskRecord): DeliveryTaskView {
  const order = task.fulfillment.order
  const assignment = task.assignments[0]
  return {
    taskId: task.id,
    orderId: order.id,
    orderPublicId: order.publicId,
    state: task.state,
    attemptCount: task.attemptCount,
    recipientName: order.recipientNameSnapshot,
    address: order.deliveryAddressSnapshot,
    bakeryName: order.bakeryNameSnapshot,
    totalAmount: order.totalAmount.toString(),
    deliverBefore: task.deliverBefore?.toISOString() ?? null,
    courier: assignment
      ? {
          courierId: assignment.courierId,
          displayName: assignment.courier.displayName,
          assignmentId: assignment.id,
          state: assignment.state,
        }
      : null,
    updatedAt: task.updatedAt.toISOString(),
  }
}

interface DeliveryChange {
  action: string
  entityId: string
  summary: string
  payload: Prisma.InputJsonObject
  correlationId: string
  now: Date
}

async function recordDeliveryChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actorType: 'STAFF' | 'COURIER',
  actorId: string,
  change: DeliveryChange,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType,
      // A courier is not an identity account, so the courier's own id is the
      // actor. Recording nothing would leave "who said it arrived" unanswered.
      actorId: actorType === 'STAFF' ? actorId : null,
      action: change.action,
      entityType: 'delivery_task',
      entityId: change.entityId,
      summary: change.summary,
      metadata: { ...change.payload, ...(actorType === 'COURIER' && { courierId: actorId }) },
      correlationId: change.correlationId,
      occurredAt: change.now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: change.action,
      aggregateType: 'delivery_task',
      aggregateId: change.entityId,
      actorType,
      ...(actorType === 'STAFF' && { actorId }),
      correlationId: change.correlationId,
      // Where a customer's order is counts as part of the transaction they
      // entered into, not marketing.
      consentBasis: 'TRANSACTIONAL',
      payload: change.payload,
      occurredAt: change.now,
    },
  })
}

function validated<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DeliveryError(
        error.code === 'UNAUTHORIZED_DELIVERY_TRANSITION'
          ? 'DELIVERY_STEP_NOT_PERMITTED'
          : 'DELIVERY_STEP_NOT_ALLOWED',
        409,
      )
    }
    throw error
  }
}

async function readTransaction<T>(
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

/** A dispatch write, with the acting account's permission re-checked live. */
async function dispatchTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  actor: DispatchActor,
  now: Date,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return serialized(prisma, tenantId, async (transaction) => {
    const permitted = await holdsPermissionInTransaction(
      transaction,
      tenantId,
      actor.accountId,
      ADMIN_PERMISSIONS.ordersManage,
      now,
    )
    if (!permitted) throw new DeliveryError('DISPATCH_FORBIDDEN', 403)
    return operation(transaction)
  })
}

/**
 * A courier write. There is no permission to check — a courier's authority is
 * the assignment itself, which each operation verifies against the row.
 */
async function courierTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return serialized(prisma, tenantId, operation)
}

async function serialized<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return operation(transaction)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object') {
      // Two people working the same queue. Neither is an outage — one of them
      // got there first, and the second should reload and look again.
      const code = Reflect.get(error, 'code')
      if (code === 'P2002' || code === 'P2034') {
        throw new DeliveryError('DELIVERY_WRITE_CONFLICT', 409)
      }
    }
    throw error
  }
}
