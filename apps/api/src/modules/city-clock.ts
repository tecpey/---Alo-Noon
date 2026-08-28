import type { LocalNow } from '@alo-noon/domain'

/**
 * Reading and writing a city's wall clock.
 *
 * A delivery window is agreed in local time — "seven to nine tomorrow morning"
 * — but stored and acted on as an instant, because a courier's deadline and a
 * customer's notification must mean one unambiguous moment. This module is the
 * single place those two representations meet.
 *
 * It is deliberately the *only* place. Iran has not observed daylight saving
 * since 2022, so on today's map every one of these conversions is a fixed three
 * and a half hours — which is exactly why doing it by hand is tempting and why
 * it must not be done by hand. The day the platform serves a city that does
 * shift its clocks, a hard-coded offset is wrong twice a year for one hour, and
 * the symptom is a courier arriving for a delivery nobody expects.
 */

const CLOCK_PART_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, ...CLOCK_PART_OPTIONS }).formatToParts(
    instant,
  )
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

/**
 * How far ahead of UTC the zone is at a given instant, in milliseconds.
 *
 * Derived by asking what the zone calls that instant and reading the answer
 * back as though it were UTC. The difference is the offset — including whatever
 * daylight saving was in force at that moment, which is the part a constant
 * cannot express.
 */
function offsetMillisecondsAt(instant: Date, timeZone: string): number {
  const clock = wallClockAt(instant, timeZone)
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  )
  return asUtc - instant.getTime()
}

/** The city's calendar day, minute of day, and weekday at this instant. */
export function localNowIn(instant: Date, timeZone: string): LocalNow {
  const clock = wallClockAt(instant, timeZone)
  const serviceDate = `${String(clock.year).padStart(4, '0')}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
  return {
    serviceDate,
    minuteOfDay: clock.hour * 60 + clock.minute,
    // Computed from the local calendar day rather than from the instant: at
    // half past eleven at night in Tehran it is already tomorrow locally but
    // still today in UTC, and a weekday read off the instant would look up the
    // wrong day's opening hours.
    dayOfWeek: new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay(),
  }
}

/**
 * The instant at which a city's clock reads this date and minute.
 *
 * Solved rather than computed: guess that local time is UTC, correct by the
 * offset in force at that guess, then check the offset again at the corrected
 * instant. The second look is what handles a clock change falling between the
 * two — without it, an hour either side of a daylight saving boundary lands on
 * the wrong instant.
 */
export function zonedTimeToUtc(serviceDate: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, day] = serviceDate.split('-').map(Number)
  const naive = Date.UTC(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  )
  const firstPass = naive - offsetMillisecondsAt(new Date(naive), timeZone)
  const secondPass = naive - offsetMillisecondsAt(new Date(firstPass), timeZone)
  return new Date(secondPass)
}

/**
 * A service date as the database stores it: midnight UTC on that calendar day.
 *
 * `@db.Date` columns carry no time, and every existing capacity row was written
 * this way. Matching it exactly is what keeps a window's service date joinable
 * against the day's capacity slot.
 */
export function serviceDateValue(serviceDate: string): Date {
  return new Date(`${serviceDate}T00:00:00.000Z`)
}
