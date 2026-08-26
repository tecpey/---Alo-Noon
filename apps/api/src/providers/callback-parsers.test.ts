import { describe, expect, it } from 'vitest'

import {
  CALLBACK_PROVIDER_CODES,
  canonicalCallbackParams,
  extractExternalEventId,
  isCallbackProviderCode,
} from './callback-parsers'

/**
 * Five gateways name their transaction reference five different ways, and the
 * callback route has exactly one job: work out which transaction a redirect is
 * about. Getting the field name wrong does not fail loudly — it produces a
 * callback that matches no attempt, which looks to everyone involved like a
 * payment that simply never arrived.
 */
describe('reading a gateway redirect', () => {
  it.each([
    ['NEXTPAY', { trans_id: 'tx-1' }],
    ['SHEPA', { token: 'tx-1' }],
    ['IDPAY', { id: 'tx-1' }],
    ['ZARINPAL', { Authority: 'tx-1' }],
    ['ZIBAL', { trackId: 'tx-1' }],
  ] as const)('reads %s from its own parameter', (code, params) => {
    expect(extractExternalEventId(code, params)).toBe('tx-1')
  })

  it('has a parser for every provider the route accepts', () => {
    for (const code of CALLBACK_PROVIDER_CODES) {
      expect(extractExternalEventId(code, { some: 'other-field' })).toBeNull()
      expect(isCallbackProviderCode(code)).toBe(true)
    }
  })

  it('does not read one gateway’s parameter for another', () => {
    // Zarinpal capitalises; a lowercase `authority` is not its parameter, and
    // treating it as one would let a crafted redirect name a transaction.
    expect(extractExternalEventId('ZARINPAL', { authority: 'tx-1' })).toBeNull()
    expect(extractExternalEventId('ZIBAL', { Authority: 'tx-1' })).toBeNull()
  })

  it('refuses a reference that is absent, empty, oversized, or not a string', () => {
    expect(extractExternalEventId('ZIBAL', {})).toBeNull()
    expect(extractExternalEventId('ZIBAL', { trackId: '   ' })).toBeNull()
    expect(extractExternalEventId('ZIBAL', { trackId: 'x'.repeat(201) })).toBeNull()
    // Zibal sends a number in its own API, but a query parameter is text; a
    // JSON body that carries a number is not silently coerced.
    expect(extractExternalEventId('ZIBAL', { trackId: 3341234512 })).toBeNull()
  })

  it('rejects a provider code the route has no parser for', () => {
    expect(isCallbackProviderCode('ZARRINPAL')).toBe(false)
    expect(isCallbackProviderCode('')).toBe(false)
  })
})

describe('canonicalising what a redirect carried', () => {
  it('merges query and body, with the body winning a collision', () => {
    expect(canonicalCallbackParams([{ trackId: '1', success: '1' }, { trackId: '2' }])).toEqual({
      trackId: '2',
      success: '1',
    })
  })

  it('keeps scalars as text and drops everything else', () => {
    expect(
      canonicalCallbackParams([
        { code: 100, ok: true, nested: { a: 1 }, list: [1], nothing: null },
      ]),
    ).toEqual({ code: '100', ok: 'true' })
  })

  it('ignores absent sources and non-objects rather than failing', () => {
    // The array is cast in deliberately: the signature says it cannot happen,
    // but a parsed query string or a JSON body genuinely can arrive as one, and
    // the guard against it is only worth having if something checks it holds.
    const sources = [undefined, null, ['a'], { trackId: '1' }] as (Record<string, unknown> | null)[]
    expect(canonicalCallbackParams(sources)).toEqual({ trackId: '1' })
  })

  it('bounds what a hostile redirect can push into the durable receipt', () => {
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`k${index}`, 'v']))
    expect(Object.keys(canonicalCallbackParams([wide])).length).toBeLessThanOrEqual(40)

    expect(canonicalCallbackParams([{ ['k'.repeat(65)]: 'v', long: 'v'.repeat(513) }])).toEqual({})
  })
})
