import { describe, expect, it } from 'vitest'

import { safeNextPath } from './safe-next'

/**
 * This value decides where a browser goes immediately after a customer proves
 * who they are, and it arrives in a URL anyone can compose and send. Every
 * rejected case below is a real open-redirect technique, not a hypothetical.
 */
describe('safeNextPath', () => {
  it('keeps an ordinary path on this origin', () => {
    expect(safeNextPath('/checkout')).toBe('/checkout')
    expect(safeNextPath('/orders?page=2')).toBe('/orders?page=2')
  })

  it('falls back when nothing was asked for', () => {
    expect(safeNextPath(null)).toBe('/account')
    expect(safeNextPath(undefined)).toBe('/account')
    expect(safeNextPath('')).toBe('/account')
  })

  it('refuses an absolute URL to another site', () => {
    expect(safeNextPath('https://evil.example/pay')).toBe('/account')
    expect(safeNextPath('http://evil.example')).toBe('/account')
  })

  /** A browser reads `//host` as protocol-relative — it leaves this origin. */
  it('refuses a protocol-relative host', () => {
    expect(safeNextPath('//evil.example/pay')).toBe('/account')
  })

  /** Several browsers normalise a backslash to a slash before resolving. */
  it('refuses the backslash spelling of the same trick', () => {
    expect(safeNextPath('/\\evil.example')).toBe('/account')
  })

  it('refuses a scheme that is not navigation at all', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe('/account')
    expect(safeNextPath('data:text/html,<script>')).toBe('/account')
  })

  /** A newline in a redirect target is how a Location header gets split. */
  it('refuses control characters', () => {
    expect(safeNextPath('/checkout\nSet-Cookie: a=b')).toBe('/account')
    expect(safeNextPath('/checkout\r\nLocation: https://evil.example')).toBe('/account')
  })

  it('honours a caller-chosen fallback', () => {
    expect(safeNextPath('https://evil.example', '/orders')).toBe('/orders')
  })
})
