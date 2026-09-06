import { describe, expect, it } from 'vitest'

import {
  evaluateTransferConfirmation,
  maskMobile,
  maskName,
  MAXIMUM_TRANSFER,
  MINIMUM_TRANSFER,
  TRANSFER_CODE_TTL_MS,
  TRANSFER_MAX_ATTEMPTS,
  transferRefusalMessage,
  validateTransferAmount,
  WalletTransferState,
} from './wallet-transfer'

const now = new Date('2026-08-30T09:00:00.000Z')
const pending = {
  state: WalletTransferState.PENDING,
  expiresAt: new Date(now.getTime() + TRANSFER_CODE_TTL_MS),
  failedAttempts: 0,
  codeMatches: true,
  now,
}

describe('transfer amounts', () => {
  it('accepts the range the business allows', () => {
    expect(validateTransferAmount(MINIMUM_TRANSFER)).toBeUndefined()
    expect(validateTransferAmount(MAXIMUM_TRANSFER)).toBeUndefined()
    expect(validateTransferAmount(500_000n)).toBeUndefined()
  })

  it('refuses outside it, and says why in a sentence', () => {
    expect(validateTransferAmount(MINIMUM_TRANSFER - 1n)).toBe('BELOW_MINIMUM')
    expect(validateTransferAmount(MAXIMUM_TRANSFER + 1n)).toBe('ABOVE_MAXIMUM')
    expect(validateTransferAmount(0n)).toBe('NOT_A_WHOLE_RIAL')
    expect(validateTransferAmount(-1n)).toBe('NOT_A_WHOLE_RIAL')
    for (const reason of ['BELOW_MINIMUM', 'ABOVE_MAXIMUM', 'SELF_TRANSFER'] as const) {
      expect(transferRefusalMessage(reason)).toMatch(/\S/)
    }
  })

  /**
   * The ceiling is deliberately below the top-up ceiling. Charging your own
   * balance too eagerly is recoverable; sending it to a stranger is not.
   */
  it('caps a transfer lower than a top-up', () => {
    expect(MAXIMUM_TRANSFER).toBeLessThan(50_000_000n)
  })

  it('says nothing about a refusal it does not have', () => {
    expect(transferRefusalMessage('SOMETHING_ELSE')).toBeUndefined()
  })
})

describe('confirming a transfer', () => {
  it('accepts the right code while it is still good', () => {
    expect(evaluateTransferConfirmation(pending)).toEqual({ ok: true })
  })

  it('counts down the attempts left so a customer knows where they are', () => {
    expect(evaluateTransferConfirmation({ ...pending, codeMatches: false })).toEqual({
      ok: false,
      reason: 'INVALID_CODE',
      attemptsLeft: TRANSFER_MAX_ATTEMPTS - 1,
    })
  })

  /** The last wrong guess ends it rather than promising a next one. */
  it('is over after the last attempt', () => {
    expect(
      evaluateTransferConfirmation({
        ...pending,
        codeMatches: false,
        failedAttempts: TRANSFER_MAX_ATTEMPTS - 1,
      }),
    ).toEqual({ ok: false, reason: 'EXHAUSTED' })
    expect(
      evaluateTransferConfirmation({
        ...pending,
        failedAttempts: TRANSFER_MAX_ATTEMPTS,
      }),
    ).toEqual({ ok: false, reason: 'EXHAUSTED' })
  })

  /**
   * A correct code presented late is worth exactly as much as a wrong one, and
   * is told the same thing. Separating the two would tell somebody holding a
   * stolen handset whether they are racing a clock or a keyspace.
   */
  it('refuses a right code that arrived too late, indistinguishably', () => {
    const late = { ...pending, now: new Date(pending.expiresAt.getTime()) }
    expect(evaluateTransferConfirmation(late)).toEqual({ ok: false, reason: 'EXHAUSTED' })
    expect(evaluateTransferConfirmation({ ...late, codeMatches: false })).toEqual({
      ok: false,
      reason: 'EXHAUSTED',
    })
  })

  it('refuses a transfer that already ended', () => {
    for (const state of ['COMPLETED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(evaluateTransferConfirmation({ ...pending, state })).toEqual({
        ok: false,
        reason: 'NOT_PENDING',
      })
    }
  })
})

describe('showing the sender who they are paying', () => {
  it('keeps the digits people actually check', () => {
    expect(maskMobile('+989121234567')).toBe('********4567')
    expect(maskMobile('09121234567')).toBe('*******4567')
  })

  it('refuses to mask something that is not a number', () => {
    expect(() => maskMobile('+98')).toThrow(/masked/)
  })

  it('shows enough of a name to recognise and not enough to learn', () => {
    expect(maskName('زهرا محمدی')).toBe('زهرا م.')
    expect(maskName('علی')).toBe('علی')
    expect(maskName('  ')).toBeUndefined()
    expect(maskName(null)).toBeUndefined()
  })
})
