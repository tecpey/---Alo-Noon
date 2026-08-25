import { describe, expect, it } from 'vitest'

import {
  courierErrorMessage,
  courierStepFor,
  FAILURE_REASONS,
  formatDeadline,
  formatRials,
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
    expect(formatRials('90071992547409930000')).toContain('ریال')
    expect(formatRials('not-money')).toBe('not-money')
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
