import type { Prisma, PrismaClient } from '@alo-noon/database'

/**
 * What a bakery partner's own staff can see, and nothing beyond it.
 *
 * Every read here takes the branches the session's grants name and filters on
 * them in SQL. That filter is the whole security boundary of this surface: RLS
 * keeps one tenant out of another's rows, but two bakeries in the same city are
 * the same tenant, and nothing in the database stops one partner's counter from
 * reading the other's queue except the `bakeryBranchId IN (…)` in these queries.
 *
 * So the branch list is never taken from the request. It is resolved from the
 * session's grants by `authenticatedBranchStaff` and passed down; a route that
 * accepted a branch id from a client would let any partner name any branch.
 */
export interface BranchOperationsService {
  /** Which counters this session is signed in for. */
  context(tenantId: string, branchIds: readonly string[]): Promise<BranchContext[]>

  /**
   * The queue, newest first.
   *
   * Live orders by default. A counter opening the page wants what it has to act
   * on, and history behind it — an eighty-order backlog with yesterday's
   * delivered orders mixed in is a queue nobody reads.
   */
  queue(
    tenantId: string,
    branchIds: readonly string[],
    query: { scope: 'LIVE' | 'ALL'; limit: number },
  ): Promise<BranchOrderSummary[]>

  /** What these branches' delivered orders earned the bakery, and what is unpaid. */
  earnings(tenantId: string, branchIds: readonly string[]): Promise<BranchEarnings>
}

export interface BranchContext {
  branchId: string
  branchNameFa: string
  bakeryId: string
  bakeryNameFa: string
  cityNameFa: string
  operationalStatus: string
  /**
   * The bakery's commission, as a rate a person would say out loud. Shown on
   * purpose: a partner reading what they earned should be able to see the number
   * it was computed from without asking anyone.
   */
  commissionBasisPoints: number
}

export interface BranchOrderSummary {
  id: string
  publicId: string
  branchId: string
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
  recipientNameSnapshot: string
  itemCount: number
  /** What the branch itself gets: the bread, before delivery and before commission. */
  subtotalAmount: Money
  totalAmount: Money
  requestedDeliveryAt: string | null
  createdAt: string
  items: Array<{ productNameFa: string; variantNameFa: string; quantity: number }>
}

export interface BranchEarnings {
  /** Earned on delivered orders and not yet covered by a payout. */
  unpaid: Money
  unpaidOrderCount: number
  /** Earned and already paid out, over the life of the branch. */
  paid: Money
  paidOrderCount: number
  /** Commission the platform took, over the same delivered orders. */
  commission: Money
  /** When the oldest unpaid delivered order was completed, or null. */
  oldestUnpaidAt: string | null
  /** The most recent delivered orders and what each one earned. */
  recent: Array<{
    orderId: string
    publicId: string
    occurredAt: string
    total: Money
    commission: Money
    share: Money
    paid: boolean
  }>
}

interface Money {
  amount: string
  currency: 'IRR'
}

/** Live means "something is still going to happen to it". */
const LIVE_STATES = ['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_FULFILLMENT'] as const

const RECENT_EARNINGS_LIMIT = 20

export function createPrismaBranchOperationsService(prisma: PrismaClient): BranchOperationsService {
  return {
    async context(tenantId, branchIds) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: the branch ids come from the session's own
        // grants, never from the request, and the tenant is restated in the
        // filter on top of RLS.
        const branches = await transaction.bakeryBranch.findMany({
          where: { tenantId, id: { in: [...branchIds] } },
          select: {
            id: true,
            nameFa: true,
            operationalStatus: true,
            city: { select: { nameFa: true } },
            bakery: {
              select: { id: true, displayNameFa: true, commissionBasisPoints: true },
            },
          },
          orderBy: { nameFa: 'asc' },
        })
        return branches.map((branch) => ({
          branchId: branch.id,
          branchNameFa: branch.nameFa,
          bakeryId: branch.bakery.id,
          bakeryNameFa: branch.bakery.displayNameFa,
          cityNameFa: branch.city.nameFa,
          operationalStatus: branch.operationalStatus,
          commissionBasisPoints: branch.bakery.commissionBasisPoints,
        }))
      })
    },

    async queue(tenantId, branchIds, query) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: a partner's own counter reading its own
        // branches, named by the session's grants. Reading across the branch's
        // customers is the job; no customer id from the request reaches here.
        const orders = await transaction.order.findMany({
          where: {
            tenantId,
            bakeryBranchId: { in: [...branchIds] },
            ...(query.scope === 'LIVE' && { state: { in: [...LIVE_STATES] } }),
          },
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          select: {
            id: true,
            publicId: true,
            bakeryBranchId: true,
            state: true,
            paymentState: true,
            productionState: true,
            deliveryState: true,
            recipientNameSnapshot: true,
            subtotalAmount: true,
            totalAmount: true,
            requestedDeliveryAt: true,
            createdAt: true,
            items: {
              select: {
                productNameFaSnapshot: true,
                variantNameFaSnapshot: true,
                quantity: true,
              },
              orderBy: { skuSnapshot: 'asc' },
            },
          },
        })

        return orders.map((order) => ({
          id: order.id,
          publicId: order.publicId,
          branchId: order.bakeryBranchId,
          state: order.state,
          paymentState: order.paymentState,
          productionState: order.productionState,
          deliveryState: order.deliveryState,
          recipientNameSnapshot: order.recipientNameSnapshot,
          itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
          subtotalAmount: money(order.subtotalAmount),
          totalAmount: money(order.totalAmount),
          requestedDeliveryAt: order.requestedDeliveryAt?.toISOString() ?? null,
          createdAt: order.createdAt.toISOString(),
          items: order.items.map((item) => ({
            productNameFa: item.productNameFaSnapshot,
            variantNameFa: item.variantNameFaSnapshot,
            quantity: item.quantity,
          })),
        }))
      })
    },

    async earnings(tenantId, branchIds) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // Summed in SQL rather than read and added here. A season of one
        // branch's orders is a lot of rows to move across a socket to produce
        // four numbers, and `SUM` of a bigint is exact where a paginated reduce
        // quietly is not.
        //
        // Scoped by the *order's* branch, not by the bakery: a bakery with three
        // branches has one payable, and a branch owner reading it as their own
        // would be reading their neighbours' takings.
        const [totals] = await transaction.$queryRaw<
          Array<{
            unpaid: bigint | null
            unpaidCount: bigint
            paid: bigint | null
            paidCount: bigint
            commission: bigint | null
            oldestUnpaidAt: Date | null
          }>
        >`
          SELECT
            COALESCE(SUM(earning."bakeryShareAmount")
              FILTER (WHERE earning."bakeryPayoutId" IS NULL), 0) AS "unpaid",
            COUNT(*) FILTER (WHERE earning."bakeryPayoutId" IS NULL) AS "unpaidCount",
            COALESCE(SUM(earning."bakeryShareAmount")
              FILTER (WHERE earning."bakeryPayoutId" IS NOT NULL), 0) AS "paid",
            COUNT(*) FILTER (WHERE earning."bakeryPayoutId" IS NOT NULL) AS "paidCount",
            COALESCE(SUM(earning."commissionAmount"), 0) AS "commission",
            MIN(earning."occurredAt") FILTER (WHERE earning."bakeryPayoutId" IS NULL)
              AS "oldestUnpaidAt"
          FROM "OrderEarning" earning
          JOIN "Order" o ON o."id" = earning."orderId"
          WHERE earning."tenantId" = ${tenantId}::uuid
            AND o."bakeryBranchId" = ANY(${[...branchIds]}::uuid[])
        `

        const recent = await transaction.$queryRaw<
          Array<{
            orderId: string
            publicId: string
            occurredAt: Date
            total: bigint
            commission: bigint
            share: bigint
            paid: boolean
          }>
        >`
          SELECT earning."orderId", o."publicId", earning."occurredAt",
                 earning."totalAmount" AS "total", earning."commissionAmount" AS "commission",
                 earning."bakeryShareAmount" AS "share",
                 earning."bakeryPayoutId" IS NOT NULL AS "paid"
          FROM "OrderEarning" earning
          JOIN "Order" o ON o."id" = earning."orderId"
          WHERE earning."tenantId" = ${tenantId}::uuid
            AND o."bakeryBranchId" = ANY(${[...branchIds]}::uuid[])
          ORDER BY earning."occurredAt" DESC
          LIMIT ${RECENT_EARNINGS_LIMIT}
        `

        return {
          unpaid: money(totals?.unpaid ?? 0n),
          unpaidOrderCount: Number(totals?.unpaidCount ?? 0n),
          paid: money(totals?.paid ?? 0n),
          paidOrderCount: Number(totals?.paidCount ?? 0n),
          commission: money(totals?.commission ?? 0n),
          oldestUnpaidAt: totals?.oldestUnpaidAt?.toISOString() ?? null,
          recent: recent.map((row) => ({
            orderId: row.orderId,
            publicId: row.publicId,
            occurredAt: row.occurredAt.toISOString(),
            total: money(row.total),
            commission: money(row.commission),
            share: money(row.share),
            paid: row.paid,
          })),
        }
      })
    },
  }
}

function money(amount: bigint): Money {
  return { amount: (amount < 0n ? 0n : amount).toString(), currency: 'IRR' }
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
