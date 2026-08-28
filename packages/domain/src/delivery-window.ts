import { DomainError } from './errors'

/**
 * Which delivery windows a branch is offering, and whether the one a customer
 * asked for is among them.
 *
 * Bread is the one product where *when* matters more than *how fast*. Nobody
 * wants barbari at eleven at night; they want it on the table at seven in the
 * morning, warm, before anyone leaves the house. A platform that can only say
 * "as soon as possible" is competing on speed against every other courier in
 * the city. One that can promise a window is selling the thing the customer
 * actually wants, and it is also the only way a bakery can plan its ovens.
 *
 * Everything here is arithmetic on whole minutes of a local day. There is no
 * timezone handling in this module on purpose: converting a local wall-clock
 * minute into an instant is the caller's job, done once at the edge where the
 * city's timezone is known. Mixing the two is how a schedule ends up an hour
 * out twice a year, and the failure would be invisible until a courier arrived
 * for a delivery nobody was expecting.
 */

/** Minutes in a day. Windows are laid out on a grid of these. */
const MINUTES_PER_DAY = 1_440

/** The furthest ahead any branch may take orders. Two weeks of bread is a guess, not a plan. */
export const MAX_WINDOW_HORIZON_DAYS = 14

/** When a branch is open, for one day of the week. */
export interface OperatingDay {
  /** 0 is Sunday, matching `Date.prototype.getUTCDay`. */
  readonly dayOfWeek: number
  readonly opensAtMinute: number
  readonly closesAtMinute: number
  readonly isClosed: boolean
}

/** How a branch cuts its opening hours into bookable windows. */
export interface WindowPolicy {
  /** How long each window is. Two hours is a promise a courier can keep; ten minutes is not. */
  readonly windowMinutes: number
  /**
   * How long before a window opens the shop stops accepting orders for it.
   *
   * This is the dough, not the drive. A bakery that needs ninety minutes to
   * bake cannot honour a window starting in twenty, and taking the order
   * anyway converts a happy customer into a refund.
   */
  readonly leadTimeMinutes: number
  /** How many days ahead may be booked. Zero means today only. */
  readonly horizonDays: number
}

/** The customer's local clock, as the branch's city reads it. */
export interface LocalNow {
  /** `YYYY-MM-DD` in the city's timezone. */
  readonly serviceDate: string
  /** Minutes since local midnight. */
  readonly minuteOfDay: number
  /** 0 is Sunday. */
  readonly dayOfWeek: number
}

export interface DeliveryWindow {
  readonly serviceDate: string
  readonly dayOfWeek: number
  readonly startMinute: number
  readonly endMinute: number
}

const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Every window this branch can still honour, soonest first.
 *
 * Returns an empty list rather than throwing when nothing is bookable — a
 * branch that is closed all week, or one whose last window of the day has
 * passed, is an ordinary Tuesday evening, not a fault.
 */
export function enumerateDeliveryWindows(
  schedule: readonly OperatingDay[],
  policy: WindowPolicy,
  now: LocalNow,
): readonly DeliveryWindow[] {
  assertPolicy(policy)
  assertLocalNow(now)

  const byDayOfWeek = new Map(schedule.map((day) => [day.dayOfWeek, day]))
  const windows: DeliveryWindow[] = []
  // Absolute minutes from local midnight today, so a lead time that crosses
  // midnight excludes tomorrow's earliest windows without any special case.
  const earliest = now.minuteOfDay + policy.leadTimeMinutes

  for (let offset = 0; offset <= policy.horizonDays; offset += 1) {
    const dayOfWeek = (now.dayOfWeek + offset) % 7
    const day = byDayOfWeek.get(dayOfWeek)
    if (!day || day.isClosed) continue
    if (day.closesAtMinute - day.opensAtMinute < policy.windowMinutes) continue

    const serviceDate = addServiceDays(now.serviceDate, offset)
    for (
      let startMinute = day.opensAtMinute;
      startMinute + policy.windowMinutes <= day.closesAtMinute;
      startMinute += policy.windowMinutes
    ) {
      if (offset * MINUTES_PER_DAY + startMinute < earliest) continue
      windows.push({
        serviceDate,
        dayOfWeek,
        startMinute,
        endMinute: startMinute + policy.windowMinutes,
      })
    }
  }

  return windows
}

/**
 * Whether a window a customer chose is one this branch actually offered.
 *
 * The chosen window arrives from a browser, so it is a claim rather than a
 * fact. Re-deriving the offer and looking the claim up in it is what stops an
 * order being accepted for three in the morning, or for a date past the horizon
 * the bakery agreed to plan for.
 */
export function isOfferedWindow(
  offered: readonly DeliveryWindow[],
  chosen: { serviceDate: string; startMinute: number },
): boolean {
  return offered.some(
    (window) =>
      window.serviceDate === chosen.serviceDate && window.startMinute === chosen.startMinute,
  )
}

/**
 * The next day on the calendar, as a `YYYY-MM-DD` string.
 *
 * Done in UTC deliberately. These strings name a service date, not an instant,
 * and UTC is the one arithmetic that has no daylight saving in it — adding a
 * day to a local date across a clock change would otherwise land on the same
 * day twice or skip one entirely.
 */
export function addServiceDays(serviceDate: string, days: number): string {
  const [year, month, day] = serviceDate.split('-').map(Number)
  if (
    !SERVICE_DATE_PATTERN.test(serviceDate) ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isSafeInteger(days)
  ) {
    throw new DomainError('INVALID_DELIVERY_WINDOW', 'A service date must be YYYY-MM-DD', {
      serviceDate,
      days,
    })
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function assertPolicy(policy: WindowPolicy): void {
  const issues: string[] = []
  if (!Number.isSafeInteger(policy.windowMinutes) || policy.windowMinutes <= 0) {
    issues.push('A delivery window must be a whole number of minutes above zero')
  } else if (policy.windowMinutes > MINUTES_PER_DAY) {
    issues.push('A delivery window cannot be longer than a day')
  }
  if (!Number.isSafeInteger(policy.leadTimeMinutes) || policy.leadTimeMinutes < 0) {
    issues.push('A lead time cannot be negative')
  }
  if (
    !Number.isSafeInteger(policy.horizonDays) ||
    policy.horizonDays < 0 ||
    policy.horizonDays > MAX_WINDOW_HORIZON_DAYS
  ) {
    issues.push(`A booking horizon must be between zero and ${MAX_WINDOW_HORIZON_DAYS} days`)
  }
  if (issues.length > 0) {
    throw new DomainError('INVALID_DELIVERY_WINDOW', 'Delivery window policy is not usable', {
      issues,
    })
  }
}

function assertLocalNow(now: LocalNow): void {
  const issues: string[] = []
  if (!SERVICE_DATE_PATTERN.test(now.serviceDate)) {
    issues.push('A service date must be YYYY-MM-DD')
  }
  if (
    !Number.isSafeInteger(now.minuteOfDay) ||
    now.minuteOfDay < 0 ||
    now.minuteOfDay >= MINUTES_PER_DAY
  ) {
    issues.push('The local minute of day must fall inside a day')
  }
  if (!Number.isSafeInteger(now.dayOfWeek) || now.dayOfWeek < 0 || now.dayOfWeek > 6) {
    issues.push('The local day of week must be between zero and six')
  }
  if (issues.length > 0) {
    throw new DomainError('INVALID_DELIVERY_WINDOW', 'The local clock is not usable', { issues })
  }
}
