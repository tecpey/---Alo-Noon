import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  assertTripIsDeliverable,
  ASSUMED_SPEED_METRES_PER_SECOND,
  DeliveryTaskState,
  DROP_SERVICE_TIME_MS,
  DeliveryTripState,
  DomainError,
  MAX_TRIP_DROPS,
  planTrip,
  transitionDeliveryTask,
  transitionDeliveryTrip,
  TransitionActor,
  type BatchCandidate,
  type DeliveryCoordinates,
  type TripPlan,
} from '@alo-noon/domain'

import type { RoutingService } from './routing.js'

/**
 * Building a courier's run out of several orders, and dispatching it as one.
 *
 * The saving is real: the ride out to a neighbourhood is paid once instead of
 * once per loaf. The cost is borne by whoever is last in the sequence, and that
 * is why almost all of the logic here is refusal — the domain decides what may
 * ride together, and this service's job is to gather honest inputs for that
 * decision and then write the answer down atomically.
 *
 * Two things are deliberately not done here.
 *
 * **Nothing is batched automatically.** A dispatcher asks for a plan and then
 * dispatches it. Batching orders behind an operator's back would mean a customer
 * waiting longer for a reason nobody chose, and the first time it went wrong
 * nobody would know it had happened at all.
 *
 * **A trip is never reshaped after dispatch.** The stop rows are frozen by a
 * database trigger the moment the run leaves PLANNED, because a rider already at
 * the second door cannot be given a better fourth stop.
 */
export interface TripStopView {
  taskId: string
  orderId: string
  orderCode: string
  sequence: number
  legMetres: number
  plannedArrivalAt: string
  recipientName: string
  address: string
}

export interface TripView {
  tripId: string
  branchId: string
  state: DeliveryTripState
  plannedDepartureAt: string
  plannedMetres: number
  savedMetres: number
  stops: TripStopView[]
}

export interface DeliveryTripService {
  /**
   * Proposes the best run that can be built around one unassigned delivery,
   * without committing anything. A dispatcher sees what it would be and what it
   * would save before agreeing to it.
   */
  proposeTrip(
    tenantId: string,
    command: { anchorTaskId: string; departAt?: Date },
    now: Date,
  ): Promise<TripView>
  /** Writes a proposed run down, claiming its deliveries so nothing else can. */
  createTrip(
    tenantId: string,
    actor: { accountId: string },
    command: { taskIds: readonly string[]; departAt?: Date },
    now: Date,
    correlationId: string,
  ): Promise<TripView>
  /** Offers the whole run to one courier, in one transaction. */
  dispatchTrip(
    tenantId: string,
    actor: { accountId: string },
    command: { tripId: string; courierId: string },
    now: Date,
    correlationId: string,
  ): Promise<TripView>
  listTrips(tenantId: string, openOnly: boolean): Promise<TripView[]>
}

export class DeliveryTripError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'DeliveryTripError'
  }
}

export interface DeliveryTripOptions {
  /**
   * Used to plan on real road distances rather than straight lines. Optional,
   * and the difference is not cosmetic: two doors fifty metres apart with a
   * river between them are a good batch on a map and a terrible one in life.
   */
  routingService?: RoutingService
  maxDrops?: number
}

const tripInclude = {
  stops: {
    orderBy: { sequence: 'asc' },
    include: {
      deliveryTask: {
        include: {
          fulfillment: {
            include: {
              order: {
                select: {
                  id: true,
                  publicId: true,
                  recipientNameSnapshot: true,
                  deliveryAddressSnapshot: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.DeliveryTripInclude

type TripRecord = Prisma.DeliveryTripGetPayload<{ include: typeof tripInclude }>

export function createPrismaDeliveryTripService(
  prisma: PrismaClient,
  options: DeliveryTripOptions = {},
): DeliveryTripService {
  const maxDrops = options.maxDrops ?? MAX_TRIP_DROPS

  /**
   * Every unassigned delivery from one branch that is not already on a run.
   *
   * "Not already on a run" is enforced twice on purpose: filtered here so a
   * dispatcher is never shown an order that cannot join, and enforced by a
   * unique index at write time so two dispatchers planning at once cannot both
   * claim the same loaf.
   */
  async function candidatesFor(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<{ candidates: BatchCandidate[]; branch: DeliveryCoordinates }> {
    const branch = await transaction.bakeryBranch.findFirstOrThrow({
      where: { id: branchId, tenantId },
      select: { latitude: true, longitude: true },
    })
    const tasks = await transaction.deliveryTask.findMany({
      where: {
        tenantId,
        state: DeliveryTaskState.UNASSIGNED,
        tripStop: null,
        fulfillment: { bakeryBranchId: branchId },
      },
      include: {
        fulfillment: {
          select: {
            bakeryBranchId: true,
            order: {
              select: { deliveryLatitudeSnapshot: true, deliveryLongitudeSnapshot: true },
            },
          },
        },
      },
      // Oldest first: an order that has been waiting is the one a batch should
      // be built around, not the one displaced by a newer neighbour.
      orderBy: { createdAt: 'asc' },
      take: 200,
    })

    return {
      branch: { latitude: Number(branch.latitude), longitude: Number(branch.longitude) },
      candidates: tasks.flatMap((task) => {
        const order = task.fulfillment.order
        const taskBranchId = task.fulfillment.bakeryBranchId
        // A delivery with no branch or no coordinates cannot be planned against
        // anything. Dropping it here rather than failing the whole proposal is
        // deliberate: one unplannable order must not stop a dispatcher batching
        // the others.
        if (!taskBranchId || !order.deliveryLatitudeSnapshot || !order.deliveryLongitudeSnapshot) {
          return []
        }
        return [
          {
            taskId: task.id,
            branchId: taskBranchId,
            destination: {
              latitude: Number(order.deliveryLatitudeSnapshot),
              longitude: Number(order.deliveryLongitudeSnapshot),
            },
            deliverBefore: task.deliverBefore,
            readyAt: task.pickupAfter,
          },
        ]
      }),
    }
  }

  /**
   * A distance function backed by the routing engine where one is configured.
   *
   * Distances are resolved before planning rather than during it, because the
   * planner is a pure synchronous function and the engine is a network call —
   * and because resolving them up front means a plan costs a bounded number of
   * lookups instead of one per comparison the search happens to make.
   */
  async function distanceTable(
    tenantId: string,
    branchId: string,
    branch: DeliveryCoordinates,
    points: readonly DeliveryCoordinates[],
    now: Date,
  ): Promise<Map<string, number>> {
    const table = new Map<string, number>()
    if (!options.routingService) return table
    for (const point of points) {
      const distance = await options.routingService.distanceFor(
        tenantId,
        { branchId, origin: branch, destination: point },
        now,
      )
      // Only measured distances go in. Substituting the engine's own fallback
      // here would be planning on the straight line while believing otherwise,
      // and the straight line is already what the planner defaults to.
      if (distance.source === 'ROUTED') table.set(pointKey(point), distance.distanceMetres)
    }
    return table
  }

  return {
    async proposeTrip(tenantId, command, now) {
      const departAt = command.departAt ?? now
      const proposal = await readTransaction(prisma, tenantId, async (transaction) => {
        const anchor = await loadTask(transaction, tenantId, command.anchorTaskId)
        const { branch, candidates } = await candidatesFor(transaction, tenantId, anchor.branchId)
        return { branch, candidates, anchor, branchId: anchor.branchId }
      })

      const anchorCandidate = proposal.candidates.find(
        (candidate) => candidate.taskId === command.anchorTaskId,
      )
      if (!anchorCandidate) throw new DeliveryTripError('DELIVERY_NOT_BATCHABLE', 409)

      const table = await distanceTable(
        tenantId,
        proposal.branchId,
        proposal.branch,
        proposal.candidates.map((candidate) => candidate.destination),
        now,
      )
      const plan = planTrip(proposal.branch, anchorCandidate, proposal.candidates, departAt, {
        maxDrops,
        ...(table.size > 0 && { distanceBetween: routedDistance(proposal.branch, table) }),
      })

      // Nothing is written: this is a proposal a dispatcher may decline.
      return previewOf(tenantId, plan, departAt, prisma)
    },

    async createTrip(tenantId, actor, command, now, correlationId) {
      if (command.taskIds.length === 0) throw new DeliveryTripError('TRIP_EMPTY', 422)
      if (command.taskIds.length > maxDrops) throw new DeliveryTripError('TRIP_TOO_LARGE', 422)
      const departAt = command.departAt ?? now

      const trip = await serializable(prisma, tenantId, async (transaction) => {
        const tasks = await Promise.all(
          command.taskIds.map((taskId) => loadTask(transaction, tenantId, taskId)),
        )
        const branchId = tasks[0]!.branchId
        const branchRow = await transaction.bakeryBranch.findFirstOrThrow({
          where: { id: branchId, tenantId },
          select: { latitude: true, longitude: true },
        })
        const branch = {
          latitude: Number(branchRow.latitude),
          longitude: Number(branchRow.longitude),
        }
        const candidates = tasks.map((task) => task.candidate)

        // The domain has the final word, and it is checked against the sequence
        // given rather than a better one nobody will ride.
        try {
          assertTripIsDeliverable(branch, candidates, departAt, { maxDrops })
        } catch (error) {
          throw asTripError(error)
        }

        // A dispatcher who chose a sequence gets the sequence they chose. The
        // planner answers "what is the best run?"; silently improving someone's
        // order would mean the run they saw is not the run that happens.
        const sequenced = sequenceAsGiven(branch, candidates, departAt)

        const created = await transaction.deliveryTrip.create({
          data: {
            tenantId,
            bakeryBranchId: branchId,
            state: DeliveryTripState.PLANNED,
            plannedDepartureAt: departAt,
            plannedMetres: sequenced.totalMetres,
            savedMetres: sequenced.savedMetres,
            correlationId,
            updatedAt: now,
            stops: {
              create: sequenced.stops.map((stop) => ({
                tenantId,
                deliveryTaskId: stop.taskId,
                sequence: stop.sequence,
                legMetres: stop.legMetres,
                plannedArrivalAt: stop.plannedArrival,
              })),
            },
          },
          include: tripInclude,
        })

        await recordTripChange(transaction, tenantId, actor.accountId, {
          action: 'delivery.trip.planned',
          entityId: created.id,
          summary: `A run of ${sequenced.stops.length} deliveries was planned, saving ${sequenced.savedMetres} metres`,
          payload: {
            branchId,
            taskIds: [...command.taskIds],
            plannedMetres: sequenced.totalMetres,
            savedMetres: sequenced.savedMetres,
          },
          correlationId,
          now,
        })
        return created
      })

      return mapTrip(trip)
    },

    async dispatchTrip(tenantId, actor, command, now, correlationId) {
      const trip = await serializable(prisma, tenantId, async (transaction) => {
        await transaction.$queryRaw`
          SELECT "id" FROM "DeliveryTrip"
          WHERE "id" = ${command.tripId}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE`
        const existing = await transaction.deliveryTrip.findFirst({
          where: { id: command.tripId, tenantId },
          include: tripInclude,
        })
        if (!existing) throw new DeliveryTripError('TRIP_NOT_FOUND', 404)
        try {
          transitionDeliveryTrip(existing.state as DeliveryTripState, DeliveryTripState.DISPATCHED)
        } catch (error) {
          throw asTripError(error)
        }

        const courier = await transaction.courier.findFirst({
          where: { id: command.courierId, tenantId },
          select: { id: true, status: true, displayName: true },
        })
        if (!courier) throw new DeliveryTripError('COURIER_NOT_FOUND', 404)
        if (courier.status !== 'AVAILABLE') throw new DeliveryTripError('COURIER_UNAVAILABLE', 409)

        // Every drop is offered together or none is. A run half-offered is a
        // courier holding three orders and a dispatcher believing they hold
        // four, which is exactly the confusion batching is supposed to remove.
        for (const stop of existing.stops) {
          const task = stop.deliveryTask
          try {
            transitionDeliveryTask({
              from: task.state as DeliveryTaskState,
              to: DeliveryTaskState.ASSIGNMENT_PENDING,
              actor: TransitionActor.STAFF,
            })
          } catch (error) {
            throw asTripError(error)
          }
          await transaction.deliveryAssignment.updateMany({
            where: { deliveryTaskId: task.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
            data: { state: 'CANCELLED', endedAt: now },
          })
          await transaction.deliveryAssignment.create({
            data: {
              tenantId,
              deliveryTaskId: task.id,
              courierId: courier.id,
              state: 'OFFERED',
              offeredAt: now,
            },
          })
          await transaction.deliveryTask.update({
            where: { id: task.id },
            data: { state: DeliveryTaskState.ASSIGNMENT_PENDING, updatedAt: now },
          })
        }

        const dispatched = await transaction.deliveryTrip.update({
          where: { id: existing.id },
          data: {
            state: DeliveryTripState.DISPATCHED,
            dispatchedAt: now,
            version: existing.version + 1,
            updatedAt: now,
          },
          include: tripInclude,
        })

        await recordTripChange(transaction, tenantId, actor.accountId, {
          action: 'delivery.trip.dispatched',
          entityId: existing.id,
          summary: `A run of ${existing.stops.length} deliveries was offered to ${courier.displayName}`,
          payload: {
            courierId: courier.id,
            taskIds: existing.stops.map((stop) => stop.deliveryTaskId),
          },
          correlationId,
          now,
        })
        return dispatched
      })

      return mapTrip(trip)
    },

    async listTrips(tenantId, openOnly) {
      const trips = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.deliveryTrip.findMany({
          where: {
            tenantId,
            ...(openOnly && {
              state: { in: [DeliveryTripState.PLANNED, DeliveryTripState.DISPATCHED] },
            }),
          },
          include: tripInclude,
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      )
      return trips.map(mapTrip)
    },
  }
}

/**
 * Times a sequence exactly as it was given, without re-ordering it.
 *
 * Deliberately a separate calculation from `planTrip` rather than a reuse of it:
 * the planner searches for a better order, and here there is nothing to search
 * for. Mixing the two would risk showing a dispatcher one sequence and riding
 * another.
 *
 * The arithmetic mirrors the domain's — same speed, same service time — because
 * the domain has already accepted this sequence against those assumptions, and
 * two different clocks would eventually disagree about the same run.
 */
function sequenceAsGiven(
  branch: DeliveryCoordinates,
  candidates: readonly BatchCandidate[],
  departAt: Date,
): TripPlan {
  let position = branch
  let clock = departAt.getTime()
  let totalMetres = 0
  let soloMetres = 0
  const stops = candidates.map((candidate, index) => {
    const legMetres = straightLine(position, candidate.destination)
    clock += Math.ceil((legMetres / ASSUMED_SPEED_METRES_PER_SECOND) * 1_000) + DROP_SERVICE_TIME_MS
    totalMetres += legMetres
    soloMetres += 2 * straightLine(branch, candidate.destination)
    position = candidate.destination
    return {
      taskId: candidate.taskId,
      sequence: index + 1,
      legMetres,
      plannedArrival: new Date(clock),
    }
  })
  // Both sides include the ride home, so a single-drop run correctly saves
  // nothing rather than appearing to save the return leg.
  const loopMetres = totalMetres + straightLine(position, branch)
  return {
    branchId: candidates[0]!.branchId,
    stops,
    totalMetres,
    savedMetres: Math.max(0, soloMetres - loopMetres),
  }
}

function pointKey(point: DeliveryCoordinates): string {
  return `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`
}

/**
 * Road distances where both ends are known, and the straight line where they are
 * not.
 *
 * The engine measures branch-to-door, so a leg between two doors has no measured
 * value. Estimating it as the difference of two measured radii would be worse
 * than the straight line, not better — so the straight line is used, and the
 * pessimistic riding speed in the planner is what keeps the resulting plan from
 * promising too much.
 */
function routedDistance(
  branch: DeliveryCoordinates,
  table: ReadonlyMap<string, number>,
): (origin: DeliveryCoordinates, destination: DeliveryCoordinates) => number {
  const branchKey = pointKey(branch)
  return (origin, destination) => {
    if (pointKey(origin) === branchKey) {
      const measured = table.get(pointKey(destination))
      if (measured !== undefined) return measured
    }
    if (pointKey(destination) === branchKey) {
      const measured = table.get(pointKey(origin))
      if (measured !== undefined) return measured
    }
    return straightLine(origin, destination)
  }
}

const EARTH_RADIUS_METRES = 6_371_000

function straightLine(origin: DeliveryCoordinates, destination: DeliveryCoordinates): number {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const latitudeDelta = toRadians(destination.latitude - origin.latitude)
  const longitudeDelta = toRadians(destination.longitude - origin.longitude)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(origin.latitude)) *
      Math.cos(toRadians(destination.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2
  return Math.ceil(
    2 * EARTH_RADIUS_METRES * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)),
  )
}

interface LoadedTask {
  id: string
  branchId: string
  candidate: BatchCandidate
}

async function loadTask(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
): Promise<LoadedTask> {
  const task = await transaction.deliveryTask.findFirst({
    where: { id: taskId, tenantId },
    include: {
      tripStop: { select: { id: true } },
      fulfillment: {
        select: {
          bakeryBranchId: true,
          order: {
            select: { deliveryLatitudeSnapshot: true, deliveryLongitudeSnapshot: true },
          },
        },
      },
    },
  })
  if (!task) throw new DeliveryTripError('DELIVERY_NOT_FOUND', 404)
  if (task.state !== DeliveryTaskState.UNASSIGNED) {
    throw new DeliveryTripError('DELIVERY_NOT_BATCHABLE', 409)
  }
  if (task.tripStop) throw new DeliveryTripError('DELIVERY_ALREADY_ON_A_TRIP', 409)
  const order = task.fulfillment.order
  const branchId = task.fulfillment.bakeryBranchId
  if (!branchId || !order.deliveryLatitudeSnapshot || !order.deliveryLongitudeSnapshot) {
    throw new DeliveryTripError('DELIVERY_HAS_NO_LOCATION', 422)
  }
  return {
    id: task.id,
    branchId,
    candidate: {
      taskId: task.id,
      branchId,
      destination: {
        latitude: Number(order.deliveryLatitudeSnapshot),
        longitude: Number(order.deliveryLongitudeSnapshot),
      },
      deliverBefore: task.deliverBefore,
      readyAt: task.pickupAfter,
    },
  }
}

/** Renders a plan that has not been written down, for a dispatcher to judge. */
async function previewOf(
  tenantId: string,
  plan: TripPlan,
  departAt: Date,
  prisma: PrismaClient,
): Promise<TripView> {
  const orders = await readTransaction(prisma, tenantId, (transaction) =>
    transaction.deliveryTask.findMany({
      where: { tenantId, id: { in: plan.stops.map((stop) => stop.taskId) } },
      include: {
        fulfillment: {
          select: {
            order: {
              select: {
                id: true,
                publicId: true,
                recipientNameSnapshot: true,
                deliveryAddressSnapshot: true,
              },
            },
          },
        },
      },
    }),
  )
  const byTask = new Map(orders.map((task) => [task.id, task.fulfillment.order]))

  return {
    tripId: '',
    branchId: plan.branchId,
    state: DeliveryTripState.PLANNED,
    plannedDepartureAt: departAt.toISOString(),
    plannedMetres: plan.totalMetres,
    savedMetres: plan.savedMetres,
    stops: plan.stops.flatMap((stop) => {
      const order = byTask.get(stop.taskId)
      if (!order) return []
      return [
        {
          taskId: stop.taskId,
          orderId: order.id,
          orderCode: order.publicId,
          sequence: stop.sequence,
          legMetres: stop.legMetres,
          plannedArrivalAt: stop.plannedArrival.toISOString(),
          recipientName: order.recipientNameSnapshot ?? '',
          address: order.deliveryAddressSnapshot ?? '',
        },
      ]
    }),
  }
}

function mapTrip(trip: TripRecord): TripView {
  return {
    tripId: trip.id,
    branchId: trip.bakeryBranchId,
    state: trip.state as DeliveryTripState,
    plannedDepartureAt: trip.plannedDepartureAt.toISOString(),
    plannedMetres: trip.plannedMetres,
    savedMetres: trip.savedMetres,
    stops: trip.stops.map((stop) => ({
      taskId: stop.deliveryTaskId,
      orderId: stop.deliveryTask.fulfillment.order.id,
      orderCode: stop.deliveryTask.fulfillment.order.publicId,
      sequence: stop.sequence,
      legMetres: stop.legMetres,
      plannedArrivalAt: stop.plannedArrivalAt.toISOString(),
      recipientName: stop.deliveryTask.fulfillment.order.recipientNameSnapshot ?? '',
      address: stop.deliveryTask.fulfillment.order.deliveryAddressSnapshot ?? '',
    })),
  }
}

/**
 * Turns a domain refusal into an HTTP-shaped one, keeping its code.
 *
 * The domain's reason is the useful part — "this drop would arrive late" is
 * something a dispatcher can act on, where "422" is not — so it is carried
 * through rather than replaced.
 */
function asTripError(error: unknown): unknown {
  if (error instanceof DomainError) {
    return new DeliveryTripError(error.code, error.code === 'TRIP_TOO_LARGE' ? 422 : 409)
  }
  return error
}

interface TripChange {
  action: string
  entityId: string
  summary: string
  payload: Prisma.InputJsonObject
  correlationId: string
  now: Date
}

async function recordTripChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  change: TripChange,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType: 'STAFF',
      actorId: accountId,
      action: change.action,
      entityType: 'delivery_trip',
      entityId: change.entityId,
      summary: change.summary,
      metadata: change.payload,
      correlationId: change.correlationId,
      occurredAt: change.now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: change.action,
      aggregateType: 'delivery_trip',
      aggregateId: change.entityId,
      actorType: 'STAFF',
      actorId: accountId,
      correlationId: change.correlationId,
      consentBasis: 'TRANSACTIONAL',
      payload: change.payload,
      occurredAt: change.now,
    },
  })
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

async function serializable<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'Serializable' },
  )
}
