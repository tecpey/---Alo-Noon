import { describe, expect, it } from 'vitest'

import {
  courierErrorMessage,
  courierStepFor,
  FAILURE_REASONS,
  formatDeadline,
  courierLegFor,
  formatMoney,
  navigationUrls,
  TASK_STATE_LABELS,
  telHref,
} from './presentation'

/** Every state the delivery API can put on a task. */
const ALL_STATES = [
  'UNASSIGNED',
  'ASSIGNMENT_PENDING',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const

describe('what the courier should do next', () => {
  it('offers exactly one forward step at each point of a route', () => {
    // One obvious action, not a menu: the person reading this is holding the
    // phone in one hand on a motorbike.
    expect(courierStepFor('ASSIGNED').primary?.to).toBe('PICKED_UP')
    expect(courierStepFor('PICKED_UP').primary?.to).toBe('OUT_FOR_DELIVERY')
    expect(courierStepFor('OUT_FOR_DELIVERY').primary?.to).toBe('DELIVERED')
  })

  it('treats an outstanding offer as a question, not a step', () => {
    const step = courierStepFor('ASSIGNMENT_PENDING')
    expect(step.isOffer).toBe(true)
    // The two answers lead to different places, and one of them gives the order
    // back to the dispatcher.
    expect(step.primary).toBeNull()
  })

  it('lets a courier report a failure only once they are holding the bread', () => {
    // Before pickup there is nothing to fail at; the dispatcher takes the order
    // back instead.
    expect(courierStepFor('ASSIGNMENT_PENDING').canFail).toBe(false)
    expect(courierStepFor('ASSIGNED').canFail).toBe(false)
    // After pickup a courier who cannot deliver must be able to say so without
    // first pretending to have set off.
    expect(courierStepFor('PICKED_UP').canFail).toBe(true)
    expect(courierStepFor('OUT_FOR_DELIVERY').canFail).toBe(true)
  })

  it('shows nothing to do on an order that is finished or not theirs yet', () => {
    for (const state of ['UNASSIGNED', 'DELIVERED', 'FAILED', 'CANCELLED'] as const) {
      expect(courierStepFor(state)).toEqual({ primary: null, isOffer: false, canFail: false })
    }
  })

  it('never leaves a state without a label or a decision', () => {
    // A state the API can return but this screen has no words for would render
    // a blank card with no way forward.
    for (const state of ALL_STATES) {
      expect(TASK_STATE_LABELS[state]).toBeTruthy()
      expect(courierStepFor(state)).toBeTruthy()
    }
  })

  it('does not invent a step for a state it has never heard of', () => {
    expect(courierStepFor('SOMETHING_NEW').primary).toBeNull()
  })
})

describe('failure reasons', () => {
  it('offers a fixed list, because nobody types at a stranger door', () => {
    expect(FAILURE_REASONS.length).toBeGreaterThan(2)
    // The API refuses a failure with no reason, so every option must carry one.
    expect(FAILURE_REASONS.every((reason) => reason.code && reason.label)).toBe(true)
    expect(new Set(FAILURE_REASONS.map((reason) => reason.code)).size).toBe(FAILURE_REASONS.length)
  })
})

describe('presentation helpers', () => {
  it('formats money without precision loss', () => {
    expect(formatMoney('90071992547409930000')).toContain('تومان')
    expect(formatMoney('not-money')).toBe('not-money')
  })

  it('shows a deadline as a time of day, not a date the courier already knows', () => {
    const formatted = formatDeadline('2026-08-08T15:00:00.000Z')
    expect(formatted).toBeTruthy()
    expect(formatted).not.toMatch(/\d{4}/)
  })

  it('has nothing to show when there is no deadline or it is unreadable', () => {
    expect(formatDeadline(null)).toBeNull()
    expect(formatDeadline('not a date')).toBeNull()
  })

  it('refuses to render a call button that would do nothing', () => {
    expect(telHref('+989121234567')).toBe('tel:+989121234567')
    expect(telHref('09121234567')).toBeNull()
    expect(telHref('')).toBeNull()
  })
})

describe('error wording', () => {
  it('separates "not your app" from "wrong code"', () => {
    // Sign-in worked and this simply is not their app. Telling them the code
    // was wrong would send them to retype a code that was right.
    expect(courierErrorMessage('NOT_A_COURIER')).toContain('فهرست پیک‌ها')
    expect(courierErrorMessage('AUTH_OTP_INVALID')).toContain('کد')
  })

  it('shows an unrecognised code rather than hiding it', () => {
    expect(courierErrorMessage('SOMETHING_ODD')).toContain('SOMETHING_ODD')
  })
})

/**
 * Routing the courier to the door.
 *
 * The app carried an address as a line of text and nothing else, so a rider
 * read it off the screen and typed it into a map at the kerb, one-handed. The
 * coordinates were in the order the whole time. These assert the shape of what
 * replaced that, and the failure the list exists to prevent: a dead button.
 */
describe('navigation targets', () => {
  const babol = [36.5513, 52.679] as const

  it('always offers something that needs nothing installed', () => {
    // The last entry is the universal one. If the list could be exhausted, a
    // rider with no map app taps and nothing happens.
    const urls = navigationUrls(babol[0], babol[1], 'خانه')
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.at(-1)).toMatch(/^https:\/\//)
  })

  it('offers Neshan first, because that is the map couriers here use', () => {
    expect(navigationUrls(babol[0], babol[1], 'خانه')[0]).toMatch(/^nshn:/)
  })

  it('includes the Android intent, which opens whichever map the rider chose', () => {
    expect(navigationUrls(babol[0], babol[1], 'خانه').some((u) => u.startsWith('geo:'))).toBe(true)
  })

  it('carries the coordinates to a precision past any consumer fix', () => {
    for (const url of navigationUrls(36.5513, 52.679, 'خانه')) {
      expect(url).toContain('36.551300')
      expect(url).toContain('52.679000')
    }
  })

  it('does not let a label break the URL it is inside', () => {
    // `geo:` puts the name in parentheses, so an unescaped one truncates the
    // target and the map opens somewhere else entirely.
    const urls = navigationUrls(babol[0], babol[1], 'خانه (طبقهٔ ۳)')
    const geo = urls.find((u) => u.startsWith('geo:'))!
    expect(geo.endsWith(')')).toBe(true)
    expect(geo.slice(0, -1)).not.toContain(')')
  })

  it('answers with nothing rather than a broken target for impossible coordinates', () => {
    // A dead button is bad; a button that opens the middle of the ocean is
    // worse, because the rider follows it.
    expect(navigationUrls(Number.NaN, 52.679, 'خانه')).toEqual([])
    expect(navigationUrls(91, 52.679, 'خانه')).toEqual([])
    expect(navigationUrls(36.55, 181, 'خانه')).toEqual([])
  })
})

describe('which leg the courier is on', () => {
  it('sends them to the bakery before the bread is collected, and to the door after', () => {
    expect(courierLegFor('ASSIGNED')).toBe('PICKUP')
    expect(courierLegFor('PICKED_UP')).toBe('DROPOFF')
    expect(courierLegFor('OUT_FOR_DELIVERY')).toBe('DROPOFF')
  })

  it('routes nobody anywhere for an offer or a finished task', () => {
    // An offer has not been accepted; a delivered or cancelled task is not
    // somewhere to be sent. A route button on either is a button that means
    // nothing, on a screen built so every button means one thing.
    for (const state of ['ASSIGNMENT_PENDING', 'UNASSIGNED', 'DELIVERED', 'CANCELLED', 'FAILED'])
      expect(courierLegFor(state)).toBeNull()
  })
})
