import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  addServiceDays,
  enumerateDeliveryWindows,
  isOfferedWindow,
  type LocalNow,
  type OperatingDay,
  type WindowPolicy,
} from './delivery-window'

/** Open every day from six in the morning until eight at night. */
function openAllWeek(overrides: Partial<OperatingDay> = {}): OperatingDay[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    opensAtMinute: 6 * 60,
    closesAtMinute: 20 * 60,
    isClosed: false,
    ...overrides,
  }))
}

function policy(overrides: Partial<WindowPolicy> = {}): WindowPolicy {
  return { windowMinutes: 120, leadTimeMinutes: 90, horizonDays: 1, ...overrides }
}

function localNow(overrides: Partial<LocalNow> = {}): LocalNow {
  // Wednesday 2026-06-03, four in the morning — early enough that the lead time
  // has not yet eaten into the day, so a test that says nothing about timing
  // sees the branch's whole schedule.
  return { serviceDate: '2026-06-03', minuteOfDay: 4 * 60, dayOfWeek: 3, ...overrides }
}

describe('enumerateDeliveryWindows', () => {
  it('lays windows on a grid inside the opening hours', () => {
    const windows = enumerateDeliveryWindows(openAllWeek(), policy({ horizonDays: 0 }), localNow())
    expect(windows.map((window) => [window.startMinute, window.endMinute])).toEqual([
      [360, 480], // 06:00–08:00
      [480, 600],
      [600, 720],
      [720, 840],
      [840, 960],
      [960, 1080],
      [1080, 1200], // 18:00–20:00
    ])
    expect(new Set(windows.map((window) => window.serviceDate))).toEqual(new Set(['2026-06-03']))
  })

  /**
   * The lead time is the dough, not the drive. A bakery that needs ninety
   * minutes cannot honour a window opening in twenty, and taking the order
   * anyway turns a customer into a refund.
   */
  it('will not offer a window the ovens cannot reach', () => {
    // 07:30 with a 90 minute lead time: 08:00 is too soon, 10:00 is not.
    const windows = enumerateDeliveryWindows(
      openAllWeek(),
      policy({ horizonDays: 0 }),
      localNow({ minuteOfDay: 7 * 60 + 30 }),
    )
    expect(windows[0]?.startMinute).toBe(10 * 60)
  })

  it('offers a window that starts exactly at the lead time', () => {
    const windows = enumerateDeliveryWindows(
      openAllWeek(),
      policy({ horizonDays: 0 }),
      localNow({ minuteOfDay: 6 * 60 + 30 }),
    )
    expect(windows[0]?.startMinute).toBe(8 * 60)
  })

  it('reaches into tomorrow once today is spent', () => {
    const windows = enumerateDeliveryWindows(
      openAllWeek(),
      policy(),
      localNow({ minuteOfDay: 19 * 60 }),
    )
    expect(windows).toHaveLength(7)
    expect(windows.every((window) => window.serviceDate === '2026-06-04')).toBe(true)
    expect(windows[0]?.dayOfWeek).toBe(4)
  })

  /**
   * A lead time that runs past midnight has to eat into tomorrow. Counting from
   * local midnight rather than resetting at each day boundary is what makes
   * that fall out rather than needing a special case — and getting it wrong
   * would promise bread at half past midnight that nobody has started baking.
   */
  it('carries a lead time across midnight', () => {
    const nearlyMidnight = enumerateDeliveryWindows(
      [
        ...openAllWeek().filter((day) => day.dayOfWeek !== 4),
        { dayOfWeek: 4, opensAtMinute: 0, closesAtMinute: 20 * 60, isClosed: false },
      ],
      policy({ leadTimeMinutes: 180 }),
      localNow({ minuteOfDay: 23 * 60 + 30 }),
    )
    // 23:30 plus three hours is 02:30 tomorrow, so tomorrow's 00:00 and 02:00
    // windows are gone and 04:00 is the first one left.
    expect(nearlyMidnight[0]).toEqual({
      serviceDate: '2026-06-04',
      dayOfWeek: 4,
      startMinute: 4 * 60,
      endMinute: 6 * 60,
    })
  })

  it('skips a day the branch is closed', () => {
    const schedule = openAllWeek().map((day) =>
      day.dayOfWeek === 4 ? { ...day, isClosed: true } : day,
    )
    const windows = enumerateDeliveryWindows(schedule, policy(), localNow({ minuteOfDay: 19 * 60 }))
    expect(windows).toEqual([])
  })

  it('skips a day with no hours recorded at all', () => {
    const schedule = openAllWeek().filter((day) => day.dayOfWeek !== 4)
    const windows = enumerateDeliveryWindows(schedule, policy(), localNow({ minuteOfDay: 19 * 60 }))
    expect(windows).toEqual([])
  })

  /** A window that would run past closing is not offered — the door is locked. */
  it('never offers a window that outlasts the opening hours', () => {
    const schedule = openAllWeek({ opensAtMinute: 6 * 60, closesAtMinute: 6 * 60 + 150 })
    const windows = enumerateDeliveryWindows(schedule, policy({ horizonDays: 0 }), localNow())
    expect(windows).toEqual([
      { serviceDate: '2026-06-03', dayOfWeek: 3, startMinute: 360, endMinute: 480 },
    ])
  })

  it('offers nothing when the opening hours are shorter than one window', () => {
    const schedule = openAllWeek({ opensAtMinute: 6 * 60, closesAtMinute: 7 * 60 })
    expect(enumerateDeliveryWindows(schedule, policy(), localNow())).toEqual([])
  })

  it('walks the week around from Saturday to Sunday', () => {
    const schedule = openAllWeek().map((day) =>
      day.dayOfWeek === 6 ? { ...day, isClosed: true } : day,
    )
    const windows = enumerateDeliveryWindows(
      schedule,
      policy({ horizonDays: 1 }),
      // Saturday the sixth, late.
      localNow({ serviceDate: '2026-06-06', dayOfWeek: 6, minuteOfDay: 19 * 60 }),
    )
    expect(windows.every((window) => window.serviceDate === '2026-06-07')).toBe(true)
    expect(windows[0]?.dayOfWeek).toBe(0)
  })

  it('crosses a month boundary without inventing a date', () => {
    const windows = enumerateDeliveryWindows(
      openAllWeek(),
      policy(),
      localNow({ serviceDate: '2026-06-30', dayOfWeek: 2, minuteOfDay: 19 * 60 }),
    )
    expect(windows[0]?.serviceDate).toBe('2026-07-01')
  })

  it('returns nothing rather than failing when the day is over', () => {
    expect(
      enumerateDeliveryWindows(
        openAllWeek(),
        policy({ horizonDays: 0 }),
        localNow({ minuteOfDay: 19 * 60 }),
      ),
    ).toEqual([])
  })

  it('refuses a policy that could never produce a window', () => {
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy({ windowMinutes: 0 }), localNow()),
    ).toThrow(DomainError)
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy({ leadTimeMinutes: -1 }), localNow()),
    ).toThrow(DomainError)
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy({ horizonDays: 15 }), localNow()),
    ).toThrow(DomainError)
  })

  it('refuses a local clock that is not a clock', () => {
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy(), localNow({ serviceDate: '03/06/2026' })),
    ).toThrow(DomainError)
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy(), localNow({ minuteOfDay: 1_440 })),
    ).toThrow(DomainError)
    expect(() =>
      enumerateDeliveryWindows(openAllWeek(), policy(), localNow({ dayOfWeek: 7 })),
    ).toThrow(DomainError)
  })
})

describe('isOfferedWindow', () => {
  const offered = enumerateDeliveryWindows(openAllWeek(), policy(), localNow())

  it('recognises a window the branch offered', () => {
    expect(isOfferedWindow(offered, { serviceDate: '2026-06-03', startMinute: 8 * 60 })).toBe(true)
  })

  /**
   * The chosen window arrives from a browser, so it is a claim, not a fact.
   * Without this an order could be accepted for three in the morning.
   */
  it('refuses a window nobody offered', () => {
    expect(isOfferedWindow(offered, { serviceDate: '2026-06-03', startMinute: 3 * 60 })).toBe(false)
    expect(isOfferedWindow(offered, { serviceDate: '2026-06-03', startMinute: 8 * 60 + 1 })).toBe(
      false,
    )
  })

  it('refuses a date past the horizon the bakery agreed to', () => {
    expect(isOfferedWindow(offered, { serviceDate: '2026-06-09', startMinute: 8 * 60 })).toBe(false)
  })
})

describe('addServiceDays', () => {
  it('walks forward across months and years', () => {
    expect(addServiceDays('2026-06-03', 1)).toBe('2026-06-04')
    expect(addServiceDays('2026-06-30', 1)).toBe('2026-07-01')
    expect(addServiceDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(addServiceDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addServiceDays('2028-02-29', 1)).toBe('2028-03-01')
  })

  it('refuses a date it cannot read', () => {
    expect(() => addServiceDays('not-a-date', 1)).toThrow(DomainError)
  })
})
