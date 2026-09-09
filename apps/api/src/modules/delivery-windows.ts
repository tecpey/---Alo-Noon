import { enumerateDeliveryWindows, isOfferedWindow } from '@alo-noon/domain'
import type { Prisma } from '@alo-noon/database'

import { localNowIn, serviceDateValue, zonedTimeToUtc } from './city-clock.js'

/**
 * Offering delivery windows, and holding a place in one.
 *
 * Two things happen here and they are deliberately separate. Enumerating what
 * a branch *could* honour is pure arithmetic on its opening hours — no rows are
 * written, so a customer browsing windows costs nothing and cannot fill a
 * table. Claiming a place in one writes, and only ever inside the transaction
 * that accepts an order.
 *
 * Windows are materialised on demand rather than generated ahead by a job. A
 * table pre-filled two weeks out for every branch in every city is a table that
 * is wrong the moment an operator edits the hours, and it grows with the
 * platform rather than with its orders.
 */

type TransactionClient = Prisma.TransactionClient

/** A window as a customer sees it: when, and whether there is room. */
export interface OfferedDeliveryWindow {
  readonly serviceDate: string
  readonly startsAt: Date
  readonly endsAt: Date
  /** Places left, capped at what one window may hold. */
  readonly remaining: number
  readonly available: boolean
}

interface BranchWindowPolicy {
  readonly id: string
  readonly timezone: string
  readonly deliveryWindowMinutes: number
  readonly deliveryLeadTimeMinutes: number
  readonly deliveryWindowHorizonDays: number
  readonly deliveryWindowMaxOrders: number
}

async function loadBranchPolicy(
  transaction: TransactionClient,
  tenantId: string,
  bakeryBranchId: string,
): Promise<BranchWindowPolicy | null> {
  const branch = await transaction.bakeryBranch.findFirst({
    where: { id: bakeryBranchId, tenantId },
    select: {
      id: true,
      deliveryWindowMinutes: true,
      deliveryLeadTimeMinutes: true,
      deliveryWindowHorizonDays: true,
      deliveryWindowMaxOrders: true,
      city: { select: { timezone: true } },
    },
  })
  if (!branch) return null
  return {
    id: branch.id,
    timezone: branch.city.timezone,
    deliveryWindowMinutes: branch.deliveryWindowMinutes,
    deliveryLeadTimeMinutes: branch.deliveryLeadTimeMinutes,
    deliveryWindowHorizonDays: branch.deliveryWindowHorizonDays,
    deliveryWindowMaxOrders: branch.deliveryWindowMaxOrders,
  }
}

/**
 * Every window this branch is still offering, soonest first.
 *
 * A branch with no opening hours recorded offers nothing rather than
 * everything. That direction matters: the alternative is a bakery that never
 * configured its hours quietly promising deliveries at four in the morning.
 */
export async function listDeliveryWindows(
  transaction: TransactionClient,
  tenantId: string,
  bakeryBranchId: string,
  now: Date,
): Promise<readonly OfferedDeliveryWindow[]> {
  const branch = await loadBranchPolicy(transaction, tenantId, bakeryBranchId)
  if (!branch) return []

  const schedule = await transaction.bakeryOperatingHours.findMany({
    where: { tenantId, bakeryBranchId },
    select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
  })
  if (schedule.length === 0) return []

  const offered = enumerateDeliveryWindows(
    schedule,
    {
      windowMinutes: branch.deliveryWindowMinutes,
      leadTimeMinutes: branch.deliveryLeadTimeMinutes,
      horizonDays: branch.deliveryWindowHorizonDays,
    },
    localNowIn(now, branch.timezone),
  )
  if (offered.length === 0) return []

  const starts = offered.map((window) =>
    zonedTimeToUtc(window.serviceDate, window.startMinute, branch.timezone),
  )
  // One query for the whole list. The alternative — a lookup per window — is
  // fourteen round trips to render a dropdown.
  const materialised = await transaction.bakeryDeliveryWindow.findMany({
    where: { tenantId, bakeryBranchId, startsAt: { in: starts } },
    select: { startsAt: true, maxOrders: true, reservedOrders: true, suspended: true },
  })
  const byStart = new Map(materialised.map((row) => [row.startsAt.getTime(), row]))

  return offered.map((window, index) => {
    // `starts` is built from `offered` in one pass, so the index is always
    // present; the fallback exists only to satisfy a checked index read.
    const startsAt = starts[index] ?? new Date(0)
    const endsAt = zonedTimeToUtc(window.serviceDate, window.endMinute, branch.timezone)
    const existing = byStart.get(startsAt.getTime())
    const remaining = existing
      ? Math.max(existing.maxOrders - existing.reservedOrders, 0)
      : branch.deliveryWindowMaxOrders
    return {
      serviceDate: window.serviceDate,
      startsAt,
      endsAt,
      remaining,
      available: remaining > 0 && !existing?.suspended,
    }
  })
}

/**
 * Turns a window a customer chose into the row that can hold their place.
 *
 * The chosen start arrives from a browser, so it is a claim rather than a
 * fact — it is re-derived from the branch's own schedule and looked up in the
 * result. Without that, an order could be accepted for three in the morning, or
 * for a date beyond the horizon the bakery agreed to plan for.
 *
 * Returns null when the window is not on offer, which the caller reports rather
 * than throwing: a customer whose chosen window sold out while they were typing
 * their address needs to pick another one, not to see an error page.
 */
export async function resolveDeliveryWindow(
  transaction: TransactionClient,
  tenantId: string,
  bakeryBranchId: string,
  startsAt: Date,
  now: Date,
): Promise<{ id: string; startsAt: Date; endsAt: Date; serviceDate: string } | null> {
  const branch = await loadBranchPolicy(transaction, tenantId, bakeryBranchId)
  if (!branch) return null

  const schedule = await transaction.bakeryOperatingHours.findMany({
    where: { tenantId, bakeryBranchId },
    select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
  })
  if (schedule.length === 0) return null

  const local = localNowIn(startsAt, branch.timezone)
  const offered = enumerateDeliveryWindows(
    schedule,
    {
      windowMinutes: branch.deliveryWindowMinutes,
      leadTimeMinutes: branch.deliveryLeadTimeMinutes,
      horizonDays: branch.deliveryWindowHorizonDays,
    },
    localNowIn(now, branch.timezone),
  )
  if (
    !isOfferedWindow(offered, { serviceDate: local.serviceDate, startMinute: local.minuteOfDay })
  ) {
    return null
  }

  const endsAt = zonedTimeToUtc(
    local.serviceDate,
    local.minuteOfDay + branch.deliveryWindowMinutes,
    branch.timezone,
  )

  // Two customers asking for seven o'clock at the same moment both arrive here
  // with nothing in the table. The unique key on (branch, start) is what makes
  // exactly one of them create the row; the upsert turns the other's collision
  // into a read.
  const window = await transaction.bakeryDeliveryWindow.upsert({
    where: { bakeryBranchId_startsAt: { bakeryBranchId, startsAt } },
    create: {
      tenantId,
      bakeryBranchId,
      serviceDate: serviceDateValue(local.serviceDate),
      startsAt,
      endsAt,
      maxOrders: branch.deliveryWindowMaxOrders,
    },
    // Nothing to change on a window that already exists. Its capacity is the
    // capacity it was created with: raising it here would silently re-open a
    // window an operator had filled, and lowering it could take a place from
    // an order that already holds one.
    update: {},
    select: { id: true, startsAt: true, endsAt: true },
  })
  // The row's own end is returned rather than the freshly computed one. If an
  // operator shortened the branch's windows after this one was materialised,
  // the row is what was promised to whoever already booked it, and two orders
  // in the same window must not disagree about when it ends.
  return { ...window, serviceDate: local.serviceDate }
}

/**
 * Holds a place in a window for an order.
 *
 * A conditional update rather than a read-then-write: the read that says a
 * window has room is stale the moment it returns, and two customers racing the
 * last place in the seven o'clock batch would both be told yes. Returns false
 * when the window filled, which the caller turns into a refusal the customer
 * can act on.
 */
export async function claimDeliveryWindow(
  transaction: TransactionClient,
  tenantId: string,
  deliveryWindowId: string,
  now: Date,
): Promise<boolean> {
  const claimed = await transaction.$executeRaw`
    UPDATE "BakeryDeliveryWindow"
    SET "reservedOrders" = "reservedOrders" + 1, "updatedAt" = ${now}
    WHERE "id" = ${deliveryWindowId}::uuid
      AND "tenantId" = ${tenantId}::uuid
      AND NOT "suspended"
      AND "reservedOrders" < "maxOrders"
  `
  return claimed === 1
}

/**
 * Gives a place back, because the order that held it was cancelled.
 *
 * `GREATEST(…, 0)` because a counter that went negative would silently hand out
 * capacity the oven does not have — a worse failure than one that under-counts.
 */
export async function releaseDeliveryWindow(
  transaction: TransactionClient,
  tenantId: string,
  deliveryWindowId: string,
  now: Date,
): Promise<void> {
  await transaction.$executeRaw`
    UPDATE "BakeryDeliveryWindow"
    SET "reservedOrders" = GREATEST("reservedOrders" - 1, 0), "updatedAt" = ${now}
    WHERE "id" = ${deliveryWindowId}::uuid AND "tenantId" = ${tenantId}::uuid
  `
}
