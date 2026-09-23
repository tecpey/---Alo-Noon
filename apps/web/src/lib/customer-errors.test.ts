import { describe, expect, it } from 'vitest'

import { translateProviderError } from './admin-format'
import { customerErrorMessage } from './customer-errors'

/**
 * The one rule that separates this from the operator's translator.
 *
 * `translateProviderError` ends with `${fallback} (${code})`, which is right
 * for somebody who can search a code and go and look at a provider table. The
 * checkout used it too, so a customer on the launch tenant — which has no
 * payment gateway configured — would have reached the last step, after choosing
 * bread, typing an address and placing an order, and been shown
 * «سفارش ثبت شد اما پرداخت باز نشد. (PAYMENT_PROVIDER_UNAVAILABLE)».
 */
describe('what a customer is told when something is refused', () => {
  it('never shows a code, for any input at all', () => {
    // The property, not an example: anything unrecognised must come back as
    // the plain sentence the caller chose.
    for (const code of [
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'SOME_INVARIANT_NOBODY_HAS_MAPPED_YET',
      'UNKNOWN',
      '',
    ]) {
      const shown = customerErrorMessage(code, 'پرداخت انجام نشد.')
      expect(shown).not.toContain(code || 'IMPOSSIBLE')
      expect(shown).not.toMatch(/[A-Z]{3,}_[A-Z]/)
      expect(shown).not.toContain('(')
    }
  })

  it('falls back to the caller’s own sentence rather than a generic one', () => {
    // Each step of checkout knows something the others do not — whether an
    // order exists, whether money moved. A single "خطایی رخ داد" would throw
    // that away.
    expect(customerErrorMessage('UNMAPPED', 'اتصال به درگاه برقرار نشد.')).toBe(
      'اتصال به درگاه برقرار نشد.',
    )
  })

  it('says the order survived when the gateway is the thing that failed', () => {
    // The part a customer most needs: their order is real and unpaid. Without
    // it they order again and the shop owes them two loads of bread.
    const shown = customerErrorMessage('PAYMENT_PROVIDER_UNAVAILABLE', 'پرداخت باز نشد.')
    expect(shown).toContain('ثبت شد')
    expect(shown).toContain('کم نشده')
    expect(shown).toContain('سفارش‌های من')
  })

  it('tells a customer to look rather than retry when two taps collided', () => {
    // A retry here is how somebody ends up with two orders.
    const shown = customerErrorMessage('IDEMPOTENCY_KEY_CONFLICT', 'ناموفق.')
    expect(shown).toContain('دوباره پرداخت نکنید')
  })

  it('leaves the operator’s translator alone, because a code helps there', () => {
    // Guards against somebody "tidying" the two into one.
    expect(translateProviderError('SOME_NEW_INVARIANT', 'ثبت ناموفق بود.')).toContain(
      'SOME_NEW_INVARIANT',
    )
  })
})
