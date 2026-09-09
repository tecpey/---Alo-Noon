import type { Prisma, PrismaClient } from '@alo-noon/database'
import type { AssignmentProposalContract, CourierPositionSource } from '@alo-noon/contracts'
import {
  assignCouriers,
  DeliveryTaskState,
  DeliveryTripState,
  MAX_IDLE_MINUTES,
  type AssignableCourier,
  type AssignableRun,
  type DeliveryCoordinates,
} from '@alo-noon/domain'

/**
 * Proposing which courier takes which waiting run.
 *
 * A dispatcher working down a list gives each run to whoever is nearest it at
 * the moment they look. That is greedy, and greedy fails in a particular way:
 * the first run takes the only rider who was anywhere near the second, and two
 * couriers cross the city past each other. Solving the whole board at once
 * removes exactly that crossing, and the domain reports both totals so the
 * difference can be seen rather than asserted.
 *
 * Three honest limits, all of them visible in the response.
 *
 * **Nothing is assigned.** This proposes. A dispatcher then offers the work
 * through the ordinary routes. Assigning automatically would put a rider on a
 * run for a reason nobody chose, decided from a position estimate that is a
 * guess — and the first anyone would hear of a bad guess is a late delivery.
 *
 * **There is no location feed.** No app heartbeat, no GPS. A courier's position
 * is where they last delivered, which is where they are until they move. The
 * response says so per pair, because a dispatcher overruling the plan needs to
 * know whether they are overruling a measurement or an assumption.
 *
 * **A courier gets at most one run.** Putting two on a rider is not batching —
 * batching is a trip, planned as one, arriving in a sequence somebody checked.
 * Two separate runs on one courier is a promise to two customers that only one
 * of them can be kept.
 */
export interface CourierAssignmentService {
  proposeAssignments(
    tenantId: string,
    command: { branchId?: string },
    now: Date,
  ): Promise<AssignmentProposalContract>
}

export class CourierAssignmentError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'CourierAssignmentError'
  }
}

export interface CourierAssignmentOptions {
  /**
   * How many waiting runs to plan at once. The matching is O(n³), so this is a
   * real bound rather than a formality — and a board larger than this is a
   * staffing problem that no assignment can solve.
   */
  maxRuns?: number
  maxCouriers?: number
}

const DEFAULT_MAX_RUNS = 200
const DEFAULT_MAX_COURIERS = 200

/** Assignment states that mean a courier is already holding work. */
const HOLDING_WORK = ['OFFERED', 'ACCEPTED'] as const

interface WaitingRun extends AssignableRun {
  readonly runKind: 'TRIP' | 'DELIVERY'
  readonly branchId: string
  readonly dropCount: number
  readonly waitingSince: Date
}

interface PositionRow {
  courierId: string
  endedAt: Date | null
  latitude: string | null
  longitude: string | null
}

export function createPrismaCourierAssignmentService(
  prisma: PrismaClient,
  options: CourierAssignmentOptions = {},
): CourierAssignmentService {
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
  const maxCouriers = options.maxCouriers ?? DEFAULT_MAX_COURIERS

  return {
    async proposeAssignments(tenantId, command, now) {
      return tenantTransaction(prisma, tenantId, async (transaction) => {
        if (command.branchId) {
          const branch = await transaction.bakeryBranch.findFirst({
            where: { id: command.branchId, tenantId },
            select: { id: true },
          })
          if (!branch) throw new CourierAssignmentError('BRANCH_NOT_FOUND', 404)
        }

        const [runs, couriers] = await Promise.all([
          waitingRuns(transaction, tenantId, command.branchId, maxRuns),
          freeCouriers(transaction, tenantId, maxCouriers),
        ])

        const plan = assignCouriers(runs, couriers, now)
        const runById = new Map(runs.map((run) => [run.runId, run]))
        const courierById = new Map(couriers.map((courier) => [courier.courierId, courier]))

        const pairs = plan.pairs.flatMap((pair) => {
          const run = runById.get(pair.runId)
          const courier = courierById.get(pair.courierId)
          if (!run || !courier) return []
          return [
            {
              runId: run.runId,
              runKind: run.runKind,
              branchId: run.branchId,
              dropCount: run.dropCount,
              waitingSinceAt: run.waitingSince.toISOString(),
              courierId: courier.courierId,
              courierName: courier.displayName,
              positionSource: (courier.lastKnownPosition
                ? 'LAST_DELIVERY'
                : 'UNKNOWN') satisfies CourierPositionSource as CourierPositionSource,
              approachMetres: Math.round(pair.approachMetres),
              idleMinutes: idleMinutesOf(courier.idleSince, now),
            },
          ]
        })

        return {
          proposedAt: now.toISOString(),
          pairs,
          unassigned: plan.unassignedRunIds.flatMap((runId) => {
            const run = runById.get(runId)
            if (!run) return []
            return [
              {
                runId: run.runId,
                runKind: run.runKind,
                branchId: run.branchId,
                dropCount: run.dropCount,
                waitingSinceAt: run.waitingSince.toISOString(),
              },
            ]
          }),
          idleCourierCount: Math.max(0, couriers.length - plan.pairs.length),
          totalApproachMetres: Math.round(plan.totalApproachMetres),
          greedyApproachMetres: Math.round(plan.greedyApproachMetres),
        }
      })
    },
  }
}

/**
 * Everything waiting for a rider, as runs rather than as orders.
 *
 * A planned trip is one run however many drops it carries — that is the whole
 * point of having planned it — and a delivery that is not on a trip is a run of
 * one. Counting the trip's drops separately here would offer the same bread to
 * several couriers.
 *
 * Both are collected from their branch, so the branch is the pickup the courier
 * must ride to. Oldest first, because when there are more runs than riders the
 * ones left over should be the ones that have waited least.
 */
async function waitingRuns(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  branchId: string | undefined,
  limit: number,
): Promise<WaitingRun[]> {
  const [trips, loose] = await Promise.all([
    transaction.deliveryTrip.findMany({
      where: {
        tenantId,
        state: DeliveryTripState.PLANNED,
        ...(branchId && { bakeryBranchId: branchId }),
      },
      select: {
        id: true,
        bakeryBranchId: true,
        createdAt: true,
        bakeryBranch: { select: { latitude: true, longitude: true } },
        _count: { select: { stops: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
    transaction.deliveryTask.findMany({
      where: {
        tenantId,
        state: DeliveryTaskState.UNASSIGNED,
        tripStop: null,
        ...(branchId && { fulfillment: { bakeryBranchId: branchId } }),
      },
      select: {
        id: true,
        createdAt: true,
        fulfillment: {
          select: {
            bakeryBranchId: true,
            bakeryBranch: { select: { latitude: true, longitude: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
  ])

  const runs: WaitingRun[] = [
    ...trips.map((trip) => ({
      runId: trip.id,
      runKind: 'TRIP' as const,
      branchId: trip.bakeryBranchId,
      dropCount: Math.max(1, trip._count.stops),
      waitingSince: trip.createdAt,
      origin: coordinatesOf(trip.bakeryBranch),
    })),
    // A delivery with no branch has no pickup to ride to, so it is dropped
    // rather than planned against a coordinate nobody chose. It stays waiting
    // and stays visible in the delivery queue, which is where it belongs.
    ...loose.flatMap((task) => {
      const branch = task.fulfillment.bakeryBranch
      if (!task.fulfillment.bakeryBranchId || !branch) return []
      return [
        {
          runId: task.id,
          runKind: 'DELIVERY' as const,
          branchId: task.fulfillment.bakeryBranchId,
          dropCount: 1,
          waitingSince: task.createdAt,
          origin: coordinatesOf(branch),
        },
      ]
    }),
  ]

  // Oldest first, then cut: when there is more work than the board holds, the
  // runs dropped from it are the ones that have waited least. Which of the
  // remaining runs keeps a courier is the domain's decision, not this order's.
  runs.sort((left, right) => left.waitingSince.getTime() - right.waitingSince.getTime())
  return runs.slice(0, limit)
}

interface FreeCourier extends AssignableCourier {
  readonly displayName: string
}

/**
 * Couriers who could take a run right now.
 *
 * Available, and holding nothing: a rider with an offer outstanding is not free,
 * because they are about to accept it. Their position is where they last
 * delivered and their idle time is how long ago that was, both read in one pass
 * so a board of fifty riders is one query rather than fifty.
 */
async function freeCouriers(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  limit: number,
): Promise<FreeCourier[]> {
  const couriers = await transaction.courier.findMany({
    where: {
      tenantId,
      status: 'AVAILABLE',
      assignments: { none: { state: { in: [...HOLDING_WORK] } } },
    },
    select: { id: true, displayName: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  if (couriers.length === 0) return []

  const positions = await lastKnownPositions(
    transaction,
    tenantId,
    couriers.map((courier) => courier.id),
  )

  return couriers.map((courier) => {
    const position = positions.get(courier.id)
    const known =
      position && position.latitude !== null && position.longitude !== null
        ? { latitude: Number(position.latitude), longitude: Number(position.longitude) }
        : null
    return {
      courierId: courier.id,
      displayName: courier.displayName,
      lastKnownPosition: known,
      // A courier whose last assignment has no end time recorded is treated as
      // having just finished rather than as having waited forever: an idle
      // credit awarded for a missing timestamp is a bug that hands that rider
      // every run on the board.
      idleSince: position?.endedAt ?? null,
    }
  })
}

/**
 * Where each courier last delivered, and when.
 *
 * DISTINCT ON rather than a correlated subquery per rider, and joined all the
 * way to the order because the destination snapshot is the only record of where
 * a delivery physically went. Only completed assignments count: a cancelled one
 * says where the rider was sent, not where they ended up.
 */
async function lastKnownPositions(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  courierIds: readonly string[],
): Promise<Map<string, PositionRow>> {
  const rows = await transaction.$queryRaw<PositionRow[]>`
    SELECT DISTINCT ON (a."courierId")
      a."courierId"                    AS "courierId",
      a."endedAt"                      AS "endedAt",
      o."deliveryLatitudeSnapshot"     AS latitude,
      o."deliveryLongitudeSnapshot"    AS longitude
    FROM "DeliveryAssignment" a
    JOIN "DeliveryTask" t ON t."id" = a."deliveryTaskId" AND t."tenantId" = a."tenantId"
    JOIN "Fulfillment" f ON f."id" = t."fulfillmentId" AND f."tenantId" = t."tenantId"
    JOIN "Order" o ON o."id" = f."orderId" AND o."tenantId" = f."tenantId"
    WHERE a."tenantId" = ${tenantId}::uuid
      AND a."state" = 'COMPLETED'
      AND a."courierId" = ANY(${[...courierIds]}::uuid[])
    ORDER BY a."courierId", a."endedAt" DESC NULLS LAST, a."offeredAt" DESC`
  return new Map(rows.map((row) => [row.courierId, row]))
}

/** The idle time the cost function actually used, capped where the credit stops. */
function idleMinutesOf(idleSince: Date | null, now: Date): number {
  if (!idleSince) return 0
  const minutes = (now.getTime() - idleSince.getTime()) / 60_000
  return Math.round(Math.min(MAX_IDLE_MINUTES, Math.max(0, minutes)))
}

function coordinatesOf(branch: {
  latitude: Prisma.Decimal
  longitude: Prisma.Decimal
}): DeliveryCoordinates {
  return { latitude: Number(branch.latitude), longitude: Number(branch.longitude) }
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
    // Nothing is written, so a read-consistent snapshot is enough. A dispatcher
    // reading a proposal must never be able to block one writing an offer.
    { isolationLevel: 'ReadCommitted' },
  )
}
