import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  composeOperatorAlert,
  decideOperatorAlert,
  OPERATOR_ALERT_DEFINITIONS,
  OPERATOR_ALERT_KINDS,
} from './operator-alerts'

const now = new Date('2026-08-29T04:00:00.000Z')

function observation(
  count: number,
  kind: (typeof OPERATOR_ALERT_KINDS)[number] = 'OUTBOX_EVENTS_PARKED',
) {
  return { kind, count, detailFa: 'جزئیات آزمون' }
}

describe('deciding whether to wake somebody', () => {
  it('sends the first time a condition is true', () => {
    const decision = decideOperatorAlert(observation(3), null, now)

    expect(decision.send).toBe(true)
    expect(decision.reason).toBe('FIRING')
  })

  it('says nothing when the condition has cleared', () => {
    // Deliberately no all-clear message. An operator who receives one learns to
    // skim, and the next real alert arrives looking like the last four that
    // meant nothing.
    const decision = decideOperatorAlert(observation(0), null, now)

    expect(decision.send).toBe(false)
    expect(decision.reason).toBe('CLEARED')
  })

  it('stays quiet while the condition keeps being true inside its quiet period', () => {
    const quiet = OPERATOR_ALERT_DEFINITIONS.OUTBOX_EVENTS_PARKED.quietPeriodMs
    const sentJustNow = new Date(now.getTime() - quiet + 60_000)

    const decision = decideOperatorAlert(observation(3), sentJustNow, now)

    expect(decision.send).toBe(false)
    expect(decision.reason).toBe('QUIET_PERIOD')
    // And it says when it will speak again, so a caller can show that rather
    // than leaving the operator wondering whether alerting is broken.
    expect(decision.nextEligibleAt.getTime()).toBe(sentJustNow.getTime() + quiet)
  })

  it('speaks again once the quiet period has passed and the problem persists', () => {
    const quiet = OPERATOR_ALERT_DEFINITIONS.OUTBOX_EVENTS_PARKED.quietPeriodMs
    const longAgo = new Date(now.getTime() - quiet - 1)

    expect(decideOperatorAlert(observation(3), longAgo, now).send).toBe(true)
  })

  it('treats a last-sent time in the future as quiet, not as elapsed', () => {
    // A clock that jumped backwards should not turn into a burst of mail.
    const future = new Date(now.getTime() + 60 * 60_000)

    const decision = decideOperatorAlert(observation(3), future, now)

    expect(decision.send).toBe(false)
    expect(decision.reason).toBe('QUIET_PERIOD')
  })

  it('refuses a count that is not a whole number of things', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => decideOperatorAlert(observation(bad), null, now)).toThrow(DomainError)
      try {
        decideOperatorAlert(observation(bad), null, now)
      } catch (error) {
        expect((error as DomainError).code).toBe('OPERATOR_ALERT_COUNT_INVALID')
      }
    }
  })

  it('gives money-shaped problems a shorter leash than routine ones', () => {
    // Not a style preference. Money already taken from a customer and not
    // recorded is the one condition where waiting makes the reconciliation
    // harder rather than just later.
    expect(
      OPERATOR_ALERT_DEFINITIONS.PAYMENTS_AWAITING_SETTLEMENT.quietPeriodMs,
    ).toBeLessThanOrEqual(OPERATOR_ALERT_DEFINITIONS.OUTBOX_EVENTS_PARKED.quietPeriodMs)
    expect(OPERATOR_ALERT_DEFINITIONS.PAYMENTS_AWAITING_SETTLEMENT.severity).toBe('CRITICAL')
  })

  it('defines every kind it claims to know', () => {
    for (const kind of OPERATOR_ALERT_KINDS) {
      const definition = OPERATOR_ALERT_DEFINITIONS[kind]
      expect(definition.kind).toBe(kind)
      expect(definition.quietPeriodMs).toBeGreaterThan(0)
    }
  })
})

describe('what the operator reads at four in the morning', () => {
  it('puts the severity and the bakery in the subject', () => {
    const { subject } = composeOperatorAlert(
      observation(3, 'PAYMENT_GATEWAY_UNHEALTHY'),
      'نان سنگک بابل',
      'https://alonoon.ir/admin',
    )

    // On a phone this line is often all that is read before deciding whether to
    // get up, so it has to carry the severity and whose business it is.
    expect(subject).toContain('بحرانی')
    expect(subject).toContain('نان سنگک بابل')
  })

  it('says what it means for the business, not just what broke', () => {
    const { body } = composeOperatorAlert(
      observation(2, 'PAYMENT_GATEWAY_UNHEALTHY'),
      'نان سنگک بابل',
      'https://alonoon.ir/admin',
    )

    expect(body).toContain('جزئیات آزمون')
    // The consequence, because "gateway unhealthy" tells an operator nothing
    // about whether they can still take orders. With one way to pay, they
    // cannot: no payment means no order.
    expect(body).toContain('فروش متوقف است')
    expect(body).toContain('https://alonoon.ir/admin')
  })

  it('tells the reader it will not repeat immediately', () => {
    const { body } = composeOperatorAlert(
      observation(1, 'OUTBOX_EVENTS_PARKED'),
      'نان سنگک بابل',
      'https://alonoon.ir/admin',
    )

    expect(body).toContain('دیگر')
  })

  it('has wording for every kind, so none can ship as a bare code', () => {
    for (const kind of OPERATOR_ALERT_KINDS) {
      const { subject, body } = composeOperatorAlert(
        observation(1, kind),
        'نانوایی آزمون',
        'https://example.test/admin',
      )
      expect(subject).not.toContain(kind)
      expect(body.length).toBeGreaterThan(40)
    }
  })
})
