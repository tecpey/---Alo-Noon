import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  reportRangeQuerySchema,
  type LogisticsReport,
  type ReportRangeQuery,
} from '@alo-noon/contracts'
import {
  ADMIN_PERMISSIONS,
  batchDensity,
  deliveryEconomics,
  deliveryFailureRate,
  measuredDetourFactor,
  routedShare,
  URBAN_DETOUR_FACTOR,
} from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'

/**
 * What deliveries actually did, measured before anything is optimised.
 *
 * Batching orders into shared runs and assigning couriers by cost are the two
 * largest levers left, and both are optimisations — which means both need a
 * baseline they can be judged against. A number first observed on the day it
 * improves proves nothing. So this publishes the awkward version now: density
 * pinned at 1.00 because nothing batches yet, and a detour factor that is still
 * an assumption rather than a measurement.
 *
 * Every figure is computed in SQL inside a tenant-scoped transaction. Money
 * stays bigint the whole way — a year of a working city exceeds what a
 * JavaScript number holds exactly, and an average that quietly lost precision
 * would still be believed.
 */
export interface AdminLogisticsService {
  logisticsReport(tenantId: string, range: ReportRangeQuery): Promise<LogisticsReport>
}

export class AdminLogisticsError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AdminLogisticsError'
  }
}

export interface AdminLogisticsOptions {
  /** Bounded so one impatient operator cannot scan a decade. */
  maxRangeDays?: number
  /** How many distinct reason codes to name before the tail is dropped. */
  maxReasons?: number
  /**
   * How many routed deliveries to sample when measuring the real detour factor.
   * Bounded because the arithmetic happens in memory: the factor is an average
   * over per-delivery ratios, which SQL cannot compute without loading them.
   */
  maxDetourSamples?: number
}

const DEFAULT_MAX_RANGE_DAYS = 400
const DEFAULT_MAX_REASONS = 10
const DEFAULT_MAX_DETOUR_SAMPLES = 5_000

/**
 * A delivery task's outcome, as the report groups them.
 *
 * PICKED_UP and OUT_FOR_DELIVERY are in flight rather than pending: the bread
 * has left the bakery, so a report that called them "not started" would be
 * wrong about where the loaves are.
 */
const IN_FLIGHT_STATES = ['ASSIGNMENT_PENDING', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY']

interface OutcomeRow {
  state: string
  tasks: bigint
}

interface EconomicsRow {
  deliveries: bigint
  fees: bigint
  distance: bigint
}

interface CoverageRow {
  routed: bigint
  estimated: bigint
  unattributed: bigint
}

interface ReasonRow {
  reason_code: string | null
  count: bigint
}

interface DetourRow {
  routed_metres: number
  origin_latitude: string
  origin_longitude: string
  destination_latitude: string
  destination_longitude: string
}

interface RunRow {
  runs: bigint
  deliveries: bigint
}

export function createPrismaAdminLogisticsService(
  prisma: PrismaClient,
  options: AdminLogisticsOptions = {},
): AdminLogisticsService {
  const maxRangeDays = options.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS
  const maxReasons = options.maxReasons ?? DEFAULT_MAX_REASONS
  const maxDetourSamples = options.maxDetourSamples ?? DEFAULT_MAX_DETOUR_SAMPLES

  return {
    async logisticsReport(tenantId, range) {
      const from = new Date(range.from)
      const to = new Date(range.to)
      assertRange(from, to, maxRangeDays)

      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const [outcomes, economicsRow, runs, coverage, fallbackReasons, failureReasons, detour] =
          await Promise.all([
            queryOutcomes(transaction, tenantId, from, to),
            queryEconomics(transaction, tenantId, from, to),
            queryRuns(transaction, tenantId, from, to),
            queryCoverage(transaction, tenantId, from, to),
            queryFallbackReasons(transaction, tenantId, from, to, maxReasons),
            queryFailureReasons(transaction, tenantId, from, to, maxReasons),
            queryDetourSamples(transaction, tenantId, from, to, maxDetourSamples),
          ])

        const counts = {
          delivered: Number(outcomes.get('DELIVERED') ?? 0n),
          failed: Number(outcomes.get('FAILED') ?? 0n),
          cancelled: Number(outcomes.get('CANCELLED') ?? 0n),
          inFlight: IN_FLIGHT_STATES.reduce(
            (total, state) => total + Number(outcomes.get(state) ?? 0n),
            0,
          ),
        }

        const deliveries = Number(economicsRow.deliveries)
        const distanceMetres = Number(economicsRow.distance)
        const economics = deliveryEconomics({
          feeAmount: economicsRow.fees,
          distanceMetres,
          deliveries,
        })

        const coverageCounts = {
          routed: Number(coverage.routed),
          estimated: Number(coverage.estimated),
          unattributed: Number(coverage.unattributed),
        }

        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          outcomes: { ...counts, failureRate: deliveryFailureRate(counts) },
          economics: {
            deliveries,
            feesCharged: money(economicsRow.fees),
            distanceMetres,
            feePerDelivery:
              economics.feePerDelivery === null ? null : money(economics.feePerDelivery),
            feePerKilometre:
              economics.feePerKilometre === null ? null : money(economics.feePerKilometre),
            metresPerDelivery: economics.metresPerDelivery,
          },
          batching: {
            runs: Number(runs.runs),
            deliveries: Number(runs.deliveries),
            density: batchDensity({
              runs: Number(runs.runs),
              deliveries: Number(runs.deliveries),
            }),
          },
          routing: {
            ...coverageCounts,
            routedShare: routedShare(coverageCounts),
            fallbackReasons,
          },
          detour: {
            samples: detour.length,
            assumedFactor: URBAN_DETOUR_FACTOR,
            measuredFactor: measuredDetourFactor(detour),
          },
          failureReasons,
        }
      })
    },
  }
}

/**
 * Delivery tasks by outcome.
 *
 * Joined through Fulfillment to Order so the range means "orders placed in this
 * period", the same window every other report uses. Bucketing on the task's own
 * timestamps would put an order placed on Friday and delivered on Saturday in a
 * different week from its own revenue.
 */
async function queryOutcomes(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Map<string, bigint>> {
  const rows = await transaction.$queryRaw<OutcomeRow[]>`
    SELECT task."state"::text AS state, COUNT(*)::bigint AS tasks
    FROM "DeliveryTask" task
    JOIN "Fulfillment" f ON f."id" = task."fulfillmentId" AND f."tenantId" = task."tenantId"
    JOIN "Order" o ON o."id" = f."orderId" AND o."tenantId" = f."tenantId"
    WHERE task."tenantId" = ${tenantId}::uuid
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY task."state"`
  return new Map(rows.map((row) => [row.state, row.tasks]))
}

/**
 * Fees charged and metres travelled, over deliveries that actually completed.
 *
 * Only DELIVERED tasks count. A fee charged on an order the courier never
 * delivered is money that will be refunded, and including it would flatter both
 * the revenue and the distance.
 */
async function queryEconomics(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<EconomicsRow> {
  const [row] = await transaction.$queryRaw<EconomicsRow[]>`
    SELECT
      COUNT(*)::bigint                                        AS deliveries,
      COALESCE(SUM(o."deliveryFeeAmount"), 0)::bigint         AS fees,
      COALESCE(SUM(q."deliveryDistanceMeters"), 0)::bigint    AS distance
    FROM "DeliveryTask" task
    JOIN "Fulfillment" f ON f."id" = task."fulfillmentId" AND f."tenantId" = task."tenantId"
    JOIN "Order" o ON o."id" = f."orderId" AND o."tenantId" = f."tenantId"
    LEFT JOIN "Quote" q ON q."id" = o."quoteId" AND q."tenantId" = o."tenantId"
    WHERE task."tenantId" = ${tenantId}::uuid
      AND task."state" = 'DELIVERED'
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}`
  return row ?? { deliveries: 0n, fees: 0n, distance: 0n }
}

/**
 * Courier runs and the deliveries they carried.
 *
 * A run is one courier's journey, so it is counted as a distinct courier per
 * calendar day rather than as an assignment: two orders a rider takes an hour
 * apart are two runs today and would be one after batching, and counting
 * assignments would make that improvement invisible.
 *
 * The day is bucketed in the tenant's own timezone. A Tehran courier's evening
 * shift crosses midnight UTC, and splitting it in two would report a rider who
 * worked one evening as having made two runs.
 */
async function queryRuns(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RunRow> {
  const [row] = await transaction.$queryRaw<RunRow[]>`
    SELECT
      COUNT(DISTINCT (a."courierId", (a."offeredAt" AT TIME ZONE 'Asia/Tehran')::date))::bigint
        AS runs,
      COUNT(*)::bigint AS deliveries
    FROM "DeliveryAssignment" a
    JOIN "DeliveryTask" task ON task."id" = a."deliveryTaskId" AND task."tenantId" = a."tenantId"
    JOIN "Fulfillment" f ON f."id" = task."fulfillmentId" AND f."tenantId" = task."tenantId"
    JOIN "Order" o ON o."id" = f."orderId" AND o."tenantId" = f."tenantId"
    WHERE a."tenantId" = ${tenantId}::uuid
      AND task."state" = 'DELIVERED'
      AND a."state" = 'COMPLETED'
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}`
  return row ?? { runs: 0n, deliveries: 0n }
}

/** How many fares were measured, estimated, or predate routing entirely. */
async function queryCoverage(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CoverageRow> {
  const [row] = await transaction.$queryRaw<CoverageRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE q."deliveryDistanceSource" = 'ROUTED')::bigint    AS routed,
      COUNT(*) FILTER (WHERE q."deliveryDistanceSource" = 'ESTIMATED')::bigint AS estimated,
      COUNT(*) FILTER (WHERE q."deliveryDistanceSource" IS NULL)::bigint       AS unattributed
    FROM "Order" o
    JOIN "Quote" q ON q."id" = o."quoteId" AND q."tenantId" = o."tenantId"
    WHERE o."tenantId" = ${tenantId}::uuid
      AND o."state" <> 'DRAFT'
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}`
  return row ?? { routed: 0n, estimated: 0n, unattributed: 0n }
}

/**
 * Why fares fell back to an estimate.
 *
 * This is where a wrong API key or an exhausted quota stops being an
 * unread log line and becomes a count of fares that could not be defended.
 */
async function queryFallbackReasons(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<{ reasonCode: string; quotes: number }[]> {
  const rows = await transaction.$queryRaw<ReasonRow[]>`
    SELECT q."deliveryDistanceReasonCode" AS reason_code, COUNT(*)::bigint AS count
    FROM "Order" o
    JOIN "Quote" q ON q."id" = o."quoteId" AND q."tenantId" = o."tenantId"
    WHERE o."tenantId" = ${tenantId}::uuid
      AND o."state" <> 'DRAFT'
      AND q."deliveryDistanceSource" = 'ESTIMATED'
      AND q."deliveryDistanceReasonCode" IS NOT NULL
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY q."deliveryDistanceReasonCode"
    ORDER BY count DESC, reason_code ASC
    LIMIT ${limit}`
  return rows.flatMap((row) =>
    row.reason_code ? [{ reasonCode: row.reason_code, quotes: Number(row.count) }] : [],
  )
}

async function queryFailureReasons(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<{ reasonCode: string; deliveries: number }[]> {
  const rows = await transaction.$queryRaw<ReasonRow[]>`
    SELECT task."failureReasonCode" AS reason_code, COUNT(*)::bigint AS count
    FROM "DeliveryTask" task
    JOIN "Fulfillment" f ON f."id" = task."fulfillmentId" AND f."tenantId" = task."tenantId"
    JOIN "Order" o ON o."id" = f."orderId" AND o."tenantId" = f."tenantId"
    WHERE task."tenantId" = ${tenantId}::uuid
      AND task."state" = 'FAILED'
      AND task."failureReasonCode" IS NOT NULL
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY task."failureReasonCode"
    ORDER BY count DESC, reason_code ASC
    LIMIT ${limit}`
  return rows.flatMap((row) =>
    row.reason_code ? [{ reasonCode: row.reason_code, deliveries: Number(row.count) }] : [],
  )
}

/**
 * Routed deliveries paired with the straight line they could have been priced
 * on, which is what turns the assumed detour factor into a measured one.
 *
 * The straight line is recomputed here from the stored coordinates rather than
 * being read from a column, because no column holds it: the quote records the
 * distance it was priced on, and for a routed quote that is the road. The
 * branch and the delivery address are both snapshotted on the order, so the
 * pair is reconstructable long after either moved.
 */
async function queryDetourSamples(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<{ routedMetres: number; straightLineMetres: number }[]> {
  const rows = await transaction.$queryRaw<DetourRow[]>`
    SELECT
      q."deliveryDistanceMeters"        AS routed_metres,
      b."latitude"::text                AS origin_latitude,
      b."longitude"::text               AS origin_longitude,
      q."deliveryLatitudeSnapshot"::text  AS destination_latitude,
      q."deliveryLongitudeSnapshot"::text AS destination_longitude
    FROM "Order" o
    JOIN "Quote" q ON q."id" = o."quoteId" AND q."tenantId" = o."tenantId"
    JOIN "BakeryBranch" b ON b."id" = o."bakeryBranchId" AND b."tenantId" = o."tenantId"
    WHERE o."tenantId" = ${tenantId}::uuid
      AND o."state" <> 'DRAFT'
      AND q."deliveryDistanceSource" = 'ROUTED'
      AND q."deliveryDistanceMeters" IS NOT NULL
      AND q."deliveryLatitudeSnapshot" IS NOT NULL
      AND q."deliveryLongitudeSnapshot" IS NOT NULL
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    ORDER BY o."createdAt" DESC
    LIMIT ${limit}`

  return rows.flatMap((row) => {
    const origin = {
      latitude: Number(row.origin_latitude),
      longitude: Number(row.origin_longitude),
    }
    const destination = {
      latitude: Number(row.destination_latitude),
      longitude: Number(row.destination_longitude),
    }
    if (
      !Number.isFinite(origin.latitude) ||
      !Number.isFinite(origin.longitude) ||
      !Number.isFinite(destination.latitude) ||
      !Number.isFinite(destination.longitude)
    ) {
      return []
    }
    return [
      {
        routedMetres: row.routed_metres,
        straightLineMetres: straightLineMetres(origin, destination),
      },
    ]
  })
}

const EARTH_RADIUS_METRES = 6_371_000

/**
 * Haversine, duplicated from the domain's delivery-pricing rather than imported,
 * because that one throws on an out-of-range coordinate and this one reads
 * historical rows. A single bad row from years ago must not take down a report.
 */
function straightLineMetres(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const latitudeDelta = toRadians(destination.latitude - origin.latitude)
  const longitudeDelta = toRadians(destination.longitude - origin.longitude)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(origin.latitude)) *
      Math.cos(toRadians(destination.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2
  return Math.round(
    2 * EARTH_RADIUS_METRES * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)),
  )
}

function assertRange(from: Date, to: Date, maxRangeDays: number): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AdminLogisticsError('REPORT_RANGE_INVALID')
  }
  if ((to.getTime() - from.getTime()) / 86_400_000 > maxRangeDays) {
    throw new AdminLogisticsError('REPORT_RANGE_TOO_WIDE')
  }
}

function money(amount: bigint): { amount: string; currency: 'IRR' } {
  return { amount: (amount < 0n ? 0n : amount).toString(), currency: 'IRR' }
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
    // Reporting reads a lot and must never block a customer placing an order.
    { isolationLevel: 'ReadCommitted' },
  )
}

export interface AdminLogisticsDependencies extends AdminAuthDependencies {
  service: AdminLogisticsService
}

const REPORT_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

export function registerAdminLogisticsRoutes(
  app: FastifyInstance,
  dependencies: AdminLogisticsDependencies,
): void {
  app.get('/api/v1/admin/reports/logistics', REPORT_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      ADMIN_PERMISSIONS.reportsRead,
    )
    if (!actor) return reply
    const parsed = reportRangeQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_REPORT_RANGE', 'The reporting range is invalid.'))
    }

    try {
      const report = await dependencies.service.logisticsReport(actor.tenantId, parsed.data)
      return reply.send({ success: true, data: report, meta: adminResponseMeta() })
    } catch (error) {
      return logisticsFailure(request, reply, error)
    }
  })
}

const FAILURE_STATUS: Readonly<Record<string, 400 | 422>> = {
  REPORT_RANGE_INVALID: 400,
  REPORT_RANGE_TOO_WIDE: 422,
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  REPORT_RANGE_INVALID: 'The reporting range is invalid.',
  REPORT_RANGE_TOO_WIDE: 'The reporting range is too wide.',
}

function logisticsFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof AdminLogisticsError) {
    const status = FAILURE_STATUS[error.code]
    if (status) {
      return reply
        .code(status)
        .send(errorEnvelope(error.code, FAILURE_MESSAGES[error.code] ?? 'The request was refused.'))
    }
  }
  request.log.error({ err: error }, 'Logistics report failed')
  return reply
    .code(503)
    .send(errorEnvelope('LOGISTICS_REPORT_UNAVAILABLE', 'Reporting is temporarily unavailable.'))
}
