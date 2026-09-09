import { describe, expect, it } from 'vitest'

import { decodeEnvelope, isUnauthenticated, isUuid } from './api-envelope'

describe('decodeEnvelope', () => {
  it('unwraps the data envelope on success', () => {
    const { result } = decodeEnvelope<{ id: string }>(200, true, {
      success: true,
      data: { id: 'order-1' },
    })
    expect(result).toEqual({ ok: true, data: { id: 'order-1' } })
  })

  it('carries the meta block through for the pagination helper', () => {
    const { meta } = decodeEnvelope(200, true, {
      data: [],
      meta: { pagination: { page: 2 } },
    })
    expect(meta).toEqual({ pagination: { page: 2 } })
  })

  /**
   * `DELETE /api/v1/auth/session` answers 204 with an empty body. Treating that
   * as a malformed response threw inside the sign-out Server Action, so the one
   * customer who saw the crash was the one whose session had just been revoked.
   */
  it('treats a bodiless success as a success', () => {
    const { result } = decodeEnvelope(204, true, null)
    expect(result.ok).toBe(true)
  })

  it('keeps the API error code when one is sent', () => {
    const { result } = decodeEnvelope(401, false, {
      error: { code: 'SESSION_UNAUTHORIZED', message: 'A valid session is required.' },
    })
    expect(result).toEqual({
      ok: false,
      error: { code: 'SESSION_UNAUTHORIZED', message: 'A valid session is required.' },
    })
  })

  it('synthesises a code when a failure carries no body', () => {
    const { result } = decodeEnvelope(502, false, null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('HTTP_502')
  })

  it('does not read a failure as an empty success', () => {
    const { result } = decodeEnvelope(500, false, 'upstream exploded')
    expect(result.ok).toBe(false)
  })
})

describe('isUnauthenticated', () => {
  it('is true only for a missing session, not a missing permission', () => {
    expect(isUnauthenticated({ code: 'SESSION_UNAUTHORIZED', message: '' })).toBe(true)
    expect(isUnauthenticated({ code: 'ORDER_OPERATION_FORBIDDEN', message: '' })).toBe(false)
  })
})

describe('isUuid', () => {
  it('accepts a uuid and rejects a path traversal', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isUuid('../../admin')).toBe(false)
    expect(isUuid('')).toBe(false)
  })
})
