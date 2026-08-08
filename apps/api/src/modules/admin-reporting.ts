import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  adminOrderListQuerySchema,
  reportRangeQuerySchema,
  type AdminOrderDetail,
  type AdminOrderListQuery,
  type AdminOrderSummary,
  type ReportRangeQuery,
  type SalesReport,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import {
  AdminFinancialReportingError,
  type AdminFinancialReportingService,
} from './admin-financial-reporting.js'

/**
 * Read-only reporting over the tenant's own orders.
 *
 * Everything runs inside a tenant-scoped transaction so row-level security
 * applies to reporting exactly as it does to the customer-facing paths. A report
 * that bypassed RLS would be the one place in the system where one tenant could
 * see another's revenue.
 *
 * Aggregates are computed in SQL rather than by loading orders into memory: a
 * month of a working city is tens of thousands of rows, and the totals are
 * bigint Rial that must not pass through a JavaScript number on the way.
 */
export interface AdminReportingService {
  salesReport(tenantId: string, range: ReportRangeQuery): Promise<SalesReport>
  listOrders(
    tenantId: string,
    query: AdminOrderListQuery,
  ): Promise<{ orders: AdminOrderSummary[]; totalItems: number }>
  findOrder(tenantId: string, orderId: string): Promise<AdminOrderDetail | null>
}

export class AdminReportingError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AdminReportingError'
  }
}

export interface AdminReportingOptions {
  /**
   * Calendar days are a reporting concept, not a UTC one: a Tehran operator
   * asking for "yesterday" means their yesterday. Postgres does the bucketing so
   * the boundary is applied once, in the same place the rows are counted.
   */
  reportingTimeZone?: string
  maxTopProducts?: number
}

const DEFAULT_TIME_ZONE = 'Asia/Tehran'
const DEFAULT_TOP_PRODUCTS = 10
// A range wide enough to be a mistake, and wide enough to hurt: a year of
// unbounded scanning on the way to a number nobody asked for.
const MAX_RANGE_DAYS = 400

export function createPrismaAdminReportingService(
  prisma: PrismaClient,
  options: AdminReportingOptions = {},
): AdminReportingService {
  const timeZone = options.reportingTimeZone ?? DEFAULT_TIME_ZONE
  const topProductLimit = options.maxTopProducts ?? DEFAULT_TOP_PRODUCTS

  return {
    async salesReport(tenantId, range) {
      const from = new Date(range.from)
      const to = new Date(range.to)
      assertRange(from, to)

      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const [totals, byState, byPaymentState, daily, topProducts, conversion] = await Promise.all(
          [
            queryTotals(transaction, tenantId, from, to),
            queryOrderCounts(transaction, tenantId, from, to, 'state'),
            queryOrderCounts(transaction, tenantId, from, to, 'paymentState'),
            queryDaily(transaction, tenantId, from, to, timeZone),
            queryTopProducts(transaction, tenantId, from, to, topProductLimit),
            queryConversion(transaction, tenantId, from, to),
          ],
        )

        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          totals,
          ordersByState: byState,
          ordersByPaymentState: byPaymentState,
          daily,
          topProducts,
          conversion,
        }
      })
    },

    async listOrders(tenantId, query) {
      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const where = orderFilter(tenantId, query)
        // ownership-established: this is a staff surface, and reading across
        // customers is the whole point of it. The caller was already checked for
        // admin.orders.read at GLOBAL scope, the tenant boundary still holds
        // through RLS, and no customer id from the request reaches this filter.
        const [rows, totalItems] = await Promise.all([
          transaction.order.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            select: {
              id: true,
              publicId: true,
              state: true,
              paymentState: true,
              productionState: true,
              deliveryState: true,
              customerId: true,
              recipientNameSnapshot: true,
              bakeryNameSnapshot: true,
              totalAmount: true,
              requestedDeliveryAt: true,
              createdAt: true,
              _count: { select: { items: true } },
            },
          }),
          transaction.order.count({ where }),
        ])

        return {
          orders: rows.map((row) => ({
            id: row.id,
            publicId: row.publicId,
            state: row.state,
            paymentState: row.paymentState,
            productionState: row.productionState,
            deliveryState: row.deliveryState,
            customerId: row.customerId,
            recipientNameSnapshot: row.recipientNameSnapshot,
            bakeryNameSnapshot: row.bakeryNameSnapshot,
            totalAmount: money(row.totalAmount),
            itemCount: row._count.items,
            requestedDeliveryAt: row.requestedDeliveryAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          })),
          totalItems,
        }
      })
    },

    async findOrder(tenantId, orderId) {
      return tenantTransaction(prisma, tenantId, async (transaction) => {
        // ownership-established: staff order inspection, gated on
        // admin.orders.read at GLOBAL scope. An operator handling a delivery
        // failure must be able to open an order that is not theirs; the tenant
        // boundary is still enforced by RLS and restated in the filter.
        const order = await transaction.order.findFirst({
          where: { id: orderId, tenantId },
          include: {
            items: true,
            transitions: { orderBy: { occurredAt: 'asc' }, take: 50 },
            _count: { select: { items: true } },
          },
        })
        if (!order) return null

        return {
          id: order.id,
          publicId: order.publicId,
          state: order.state,
          paymentState: order.paymentState,
          productionState: order.productionState,
          deliveryState: order.deliveryState,
          customerId: order.customerId,
          recipientNameSnapshot: order.recipientNameSnapshot,
          recipientPhoneSnapshot: order.recipientPhoneSnapshot,
          bakeryNameSnapshot: order.bakeryNameSnapshot,
          deliveryAddressSnapshot: order.deliveryAddressSnapshot,
          deliveryInstructionsSnapshot: order.deliveryInstructionsSnapshot,
          customerNotes: order.customerNotes,
          cancellationReasonCode: order.cancellationReasonCode,
          subtotalAmount: money(order.subtotalAmount),
          deliveryFeeAmount: money(order.deliveryFeeAmount),
          discountAmount: money(order.discountAmount),
          totalAmount: money(order.totalAmount),
          itemCount: order._count.items,
          items: order.items.map((item) => ({
            sku: item.skuSnapshot,
            productNameFa: item.productNameFaSnapshot,
            variantNameFa: item.variantNameFaSnapshot,
            quantity: item.quantity,
            unitPrice: money(item.unitPriceAmount),
            lineTotal: money(item.lineTotalAmount),
          })),
          transitions: order.transitions.map((transition) => ({
            fromState: transition.fromState,
            toState: transition.toState,
            reasonCode: transition.reasonCode,
            occurredAt: transition.occurredAt.toISOString(),
          })),
          requestedDeliveryAt: order.requestedDeliveryAt?.toISOString() ?? null,
          createdAt: order.createdAt.toISOString(),
          updatedAt: order.updatedAt.toISOString(),
        }
      })
    },
  }
}

function assertRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AdminReportingError('REPORT_RANGE_INVALID')
  }
  const days = (to.getTime() - from.getTime()) / 86_400_000
  if (days > MAX_RANGE_DAYS) throw new AdminReportingError('REPORT_RANGE_TOO_WIDE')
}

/**
 * DRAFT orders are excluded everywhere in this module. A draft is an order the
 * customer never placed — counting it as demand would overstate every figure
 * here, and it is the state an abandoned checkout leaves behind.
 */
const PLACED_ORDER_FILTER = { state: { not: 'DRAFT' } } as const

function orderFilter(tenantId: string, query: AdminOrderListQuery): Prisma.OrderWhereInput {
  return {
    tenantId,
    ...PLACED_ORDER_FILTER,
    ...(query.state && { state: query.state }),
    ...(query.paymentState && { paymentState: query.paymentState }),
    ...((query.from ?? query.to) && {
      createdAt: {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lt: new Date(query.to) }),
      },
    }),
    // Exact match only. A prefix or contains search over a phone column invites
    // an operator to enumerate customers one digit at a time.
    ...(query.search && {
      OR: [{ publicId: query.search }, { recipientPhoneSnapshot: query.search }],
    }),
  }
}

interface TotalsRow {
  placed_orders: bigint
  placed_value: bigint | null
  paid_orders: bigint
  paid_value: bigint | null
  cancelled_orders: bigint
  cancelled_value: bigint | null
  delivery_fees: bigint | null
  discounts: bigint | null
}

async function queryTotals(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<SalesReport['totals']> {
  const [row] = await transaction.$queryRaw<TotalsRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE "state" <> 'DRAFT')                       AS placed_orders,
      COALESCE(SUM("totalAmount")  FILTER (WHERE "state" <> 'DRAFT'), 0)::bigint     AS placed_value,
      COUNT(*) FILTER (WHERE "paymentState" = 'PAID')                  AS paid_orders,
      COALESCE(SUM("totalAmount")  FILTER (WHERE "paymentState" = 'PAID'), 0)::bigint AS paid_value,
      COUNT(*) FILTER (WHERE "state" = 'CANCELLED')                    AS cancelled_orders,
      COALESCE(SUM("totalAmount")  FILTER (WHERE "state" = 'CANCELLED'), 0)::bigint  AS cancelled_value,
      COALESCE(SUM("deliveryFeeAmount") FILTER (WHERE "state" <> 'DRAFT'), 0)::bigint AS delivery_fees,
      COALESCE(SUM("discountAmount")    FILTER (WHERE "state" <> 'DRAFT'), 0)::bigint AS discounts
    FROM "Order"
    WHERE "tenantId" = ${tenantId}::uuid
      AND "createdAt" >= ${from} AND "createdAt" < ${to}`

  const placedOrders = Number(row?.placed_orders ?? 0n)
  const placedValue = row?.placed_value ?? 0n
  return {
    placedOrders,
    placedValue: money(placedValue),
    paidOrders: Number(row?.paid_orders ?? 0n),
    paidValue: money(row?.paid_value ?? 0n),
    cancelledOrders: Number(row?.cancelled_orders ?? 0n),
    cancelledValue: money(row?.cancelled_value ?? 0n),
    // Integer division truncates, which is the right call for a currency with no
    // subunit in circulation: a reported average is never more precise than the
    // smallest amount that can actually change hands.
    averageOrderValue: money(placedOrders > 0 ? placedValue / BigInt(placedOrders) : 0n),
    deliveryFees: money(row?.delivery_fees ?? 0n),
    discounts: money(row?.discounts ?? 0n),
  }
}

async function queryOrderCounts(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  column: 'state' | 'paymentState',
): Promise<Record<string, number>> {
  const rows =
    column === 'state'
      ? await transaction.$queryRaw<Array<{ bucket: string; total: bigint }>>`
          SELECT "state"::text AS bucket, COUNT(*) AS total FROM "Order"
          WHERE "tenantId" = ${tenantId}::uuid AND "state" <> 'DRAFT'
            AND "createdAt" >= ${from} AND "createdAt" < ${to}
          GROUP BY "state"`
      : await transaction.$queryRaw<Array<{ bucket: string; total: bigint }>>`
          SELECT "paymentState"::text AS bucket, COUNT(*) AS total FROM "Order"
          WHERE "tenantId" = ${tenantId}::uuid AND "state" <> 'DRAFT'
            AND "createdAt" >= ${from} AND "createdAt" < ${to}
          GROUP BY "paymentState"`

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.bucket] = Number(row.total)
  return counts
}

async function queryDaily(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  timeZone: string,
): Promise<SalesReport['daily']> {
  const rows = await transaction.$queryRaw<
    Array<{ day: string; total: bigint; value: bigint | null }>
  >`
    SELECT
      to_char(date_trunc('day', "createdAt" AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS day,
      COUNT(*) AS total,
      COALESCE(SUM("totalAmount"), 0)::bigint AS value
    FROM "Order"
    WHERE "tenantId" = ${tenantId}::uuid AND "state" <> 'DRAFT'
      AND "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY 1
    ORDER BY 1`

  return rows.map((row) => ({
    date: row.day,
    placedOrders: Number(row.total),
    placedValue: money(row.value ?? 0n),
  }))
}

async function queryTopProducts(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<SalesReport['topProducts']> {
  const rows = await transaction.$queryRaw<
    Array<{
      sku: string
      product_name: string
      variant_name: string
      quantity: bigint
      revenue: bigint | null
    }>
  >`
    SELECT
      i."skuSnapshot" AS sku,
      MIN(i."productNameFaSnapshot") AS product_name,
      MIN(i."variantNameFaSnapshot") AS variant_name,
      SUM(i."quantity")::bigint AS quantity,
      COALESCE(SUM(i."lineTotalAmount"), 0)::bigint AS revenue
    FROM "OrderItem" i
    JOIN "Order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
    WHERE i."tenantId" = ${tenantId}::uuid AND o."state" <> 'DRAFT'
      AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY i."skuSnapshot"
    ORDER BY quantity DESC, sku ASC
    LIMIT ${limit}`

  // Names come from the snapshot on the line item, not from the live catalog, so
  // a renamed product still reports under the name it actually sold as.
  return rows.map((row) => ({
    sku: row.sku,
    productNameFa: row.product_name,
    variantNameFa: row.variant_name,
    quantity: Number(row.quantity),
    revenue: money(row.revenue ?? 0n),
  }))
}

async function queryConversion(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<SalesReport['conversion']> {
  const window = { gte: from, lt: to }
  const [carts, quotes, orders] = await Promise.all([
    transaction.cart.count({ where: { tenantId, createdAt: window } }),
    transaction.quote.count({ where: { tenantId, createdAt: window } }),
    transaction.order.count({ where: { tenantId, ...PLACED_ORDER_FILTER, createdAt: window } }),
  ])
  return {
    carts,
    quotes,
    orders,
    // Orders can exceed quotes near a boundary — a quote from just before `from`
    // accepted inside it — so the rate is clamped rather than allowed past 1.
    quoteToOrderRate:
      quotes > 0 ? Math.min(1, Math.round((orders / quotes) * 10_000) / 10_000) : null,
  }
}

function money(amount: bigint): { amount: string; currency: 'IRR' } {
  // Negative money has no meaning in this schema and the contract forbids it;
  // clamping here turns a data anomaly into a visible zero rather than a 500.
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

export interface AdminReportingDependencies extends AdminAuthDependencies {
  service: AdminReportingService
  /**
   * Optional so a deployment can serve sales reporting without the financial
   * one; when absent the route is simply not registered rather than answering
   * with an empty ledger, which would read as "the books are empty".
   */
  financialService?: AdminFinancialReportingService
}

// Reports scan; a tight budget keeps one impatient operator from becoming a
// load test against the database that also serves checkout.
const REPORT_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

export function registerAdminReportingRoutes(
  app: FastifyInstance,
  dependencies: AdminReportingDependencies,
): void {
  app.get('/api/v1/admin/reports/sales', REPORT_RATE_LIMIT, async (request, reply) => {
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
      const report = await dependencies.service.salesReport(actor.tenantId, parsed.data)
      return reply.send({ success: true, data: report, meta: adminResponseMeta() })
    } catch (error) {
      return reportingFailure(request, reply, error)
    }
  })

  app.get('/api/v1/admin/orders', REPORT_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      ADMIN_PERMISSIONS.ordersRead,
    )
    if (!actor) return reply
    const parsed = adminOrderListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_ORDER_QUERY', 'The order query is invalid.'))
    }

    try {
      const { orders, totalItems } = await dependencies.service.listOrders(
        actor.tenantId,
        parsed.data,
      )
      const totalPages = Math.ceil(totalItems / parsed.data.pageSize)
      return reply.send({
        success: true,
        data: orders,
        meta: {
          ...adminResponseMeta(),
          pagination: {
            page: parsed.data.page,
            pageSize: parsed.data.pageSize,
            totalItems,
            totalPages,
            hasNextPage: parsed.data.page < totalPages,
            hasPreviousPage: parsed.data.page > 1,
          },
        },
      })
    } catch (error) {
      return reportingFailure(request, reply, error)
    }
  })

  if (dependencies.financialService) {
    const financialService = dependencies.financialService
    app.get('/api/v1/admin/reports/financial', REPORT_RATE_LIMIT, async (request, reply) => {
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
        const report = await financialService.financialReport(actor.tenantId, parsed.data)
        return reply.send({ success: true, data: report, meta: adminResponseMeta() })
      } catch (error) {
        return reportingFailure(request, reply, error)
      }
    })
  }

  app.get<{ Params: { orderId: string } }>(
    '/api/v1/admin/orders/:orderId',
    REPORT_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        ADMIN_PERMISSIONS.ordersRead,
      )
      if (!actor) return reply

      try {
        const order = await dependencies.service.findOrder(actor.tenantId, request.params.orderId)
        if (!order) {
          return reply.code(404).send(errorEnvelope('ORDER_NOT_FOUND', 'No such order.'))
        }
        return reply.send({ success: true, data: order, meta: adminResponseMeta() })
      } catch (error) {
        return reportingFailure(request, reply, error)
      }
    },
  )
}

const REPORTING_STATUS: Readonly<Record<string, 400 | 422>> = {
  REPORT_RANGE_INVALID: 400,
  REPORT_RANGE_TOO_WIDE: 422,
}

function reportingFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AdminReportingError || error instanceof AdminFinancialReportingError) {
    const status = REPORTING_STATUS[error.code]
    if (status) {
      return reply
        .code(status)
        .send(
          errorEnvelope(
            error.code,
            status === 422
              ? 'The reporting range covers too long a period.'
              : 'The reporting range is invalid.',
          ),
        )
    }
  }
  // An id that is not a UUID reaches Postgres as a cast error rather than an
  // empty result, so it must not be reported as an outage.
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('ORDER_NOT_FOUND', 'No such order.'))
  }
  request.log.error({ err: error }, 'Admin reporting query failed')
  return reply
    .code(503)
    .send(errorEnvelope('REPORTING_UNAVAILABLE', 'Reporting is temporarily unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  // 22P02 is Postgres' invalid_text_representation, which is what a malformed
  // UUID produces; Prisma surfaces its own P2023 for the same shape of mistake.
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
