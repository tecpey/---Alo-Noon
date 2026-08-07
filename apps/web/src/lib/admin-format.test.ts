import { describe, expect, it } from 'vitest'

import {
  derivedIdempotencyKey,
  sessionTokenFromSetCookie,
  translateProviderError,
} from './admin-format'

describe('session cookie relay', () => {
  it('reads the session token the API issued', () => {
    expect(
      sessionTokenFromSetCookie(
        ['alo_session=tok-abc; Path=/; HttpOnly; SameSite=Lax; Secure'],
        'alo_session',
      ),
    ).toBe('tok-abc')
  })

  it('ignores every cookie that is not the session', () => {
    // Copying another cookie onto the panel's origin would be relaying something
    // the API never meant this host to hold.
    expect(
      sessionTokenFromSetCookie(
        ['analytics_id=abc; Path=/', 'csrf=xyz; Path=/', 'alo_session=tok-1; Path=/; HttpOnly'],
        'alo_session',
      ),
    ).toBe('tok-1')
    expect(sessionTokenFromSetCookie(['other=tok-1; Path=/'], 'alo_session')).toBeNull()
  })

  it('does not mistake a name that merely contains the session name', () => {
    expect(
      sessionTokenFromSetCookie(['not_alo_session=tok-1', 'alo_session_x=tok-2'], 'alo_session'),
    ).toBeNull()
  })

  it('treats a clearing cookie as no session', () => {
    // This is what the API sends on sign-out; taking it as a token would hand
    // the operator an empty session that fails on the next request.
    expect(sessionTokenFromSetCookie(['alo_session=; Path=/; Max-Age=0'], 'alo_session')).toBeNull()
  })

  it('returns null when the API set no cookies at all', () => {
    expect(sessionTokenFromSetCookie([], 'alo_session')).toBeNull()
  })

  it('keeps a token containing base64 padding intact', () => {
    expect(sessionTokenFromSetCookie(['alo_session=a=b=c; Path=/'], 'alo_session')).toBe('a=b=c')
  })
})

describe('derived idempotency key', () => {
  const ACCEPTED = /^[A-Za-z0-9._:-]{16,128}$/

  it('is stable for the same command, so a resubmitted form replays', () => {
    const first = derivedIdempotencyKey('credential', 'IDPAY', 'local-encrypted://IDPAY')
    const second = derivedIdempotencyKey('credential', 'IDPAY', 'local-encrypted://IDPAY')
    expect(first).toBe(second)
  })

  it('differs when the command differs', () => {
    expect(derivedIdempotencyKey('credential', 'IDPAY', 'vault://a')).not.toBe(
      derivedIdempotencyKey('credential', 'IDPAY', 'vault://b'),
    )
  })

  it.each([
    ['a reference with slashes', ['credential', 'IDPAY', 'local-encrypted://IDPAY']],
    ['Persian reason text', ['governance', 'abc', 'فعال‌سازی برای سافت لانچ']],
    ['a short command', ['a', 'b']],
    ['an over-long command', ['x'.repeat(200), 'y'.repeat(200)]],
  ])('satisfies the API constraint for %s', (_label, parts) => {
    expect(derivedIdempotencyKey(...parts)).toMatch(ACCEPTED)
  })
})

describe('provider error translation', () => {
  it('renders a known code in Persian', () => {
    expect(translateProviderError('ADMIN_PERMISSION_DENIED', 'ناموفق')).toBe(
      'این حساب دسترسی لازم برای این کار را ندارد.',
    )
  })

  it('still surfaces an unmapped code, since it is the only actionable detail', () => {
    expect(translateProviderError('SOME_NEW_INVARIANT', 'ثبت ناموفق بود.')).toBe(
      'ثبت ناموفق بود. (SOME_NEW_INVARIANT)',
    )
  })
})
