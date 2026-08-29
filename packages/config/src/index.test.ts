import { describe, expect, it } from 'vitest'

import { parseCorsOrigins, validateEnv } from './index'

describe('environment configuration', () => {
  it('applies safe local defaults', () => {
    const result = validateEnv({})

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.API_PORT).toBe(3001)
  })

  it('listens everywhere by default, and on whatever it is told', () => {
    // The default has to suit a container, whose loopback nothing else shares.
    // A server behind nginx overrides it, and that override must survive.
    const fallback = validateEnv({})
    expect(fallback.success && fallback.data.API_HOST).toBe('0.0.0.0')

    const loopback = validateEnv({ API_HOST: '127.0.0.1' })
    expect(loopback.success && loopback.data.API_HOST).toBe('127.0.0.1')

    expect(validateEnv({ API_HOST: '' }).success).toBe(false)
  })

  it('requires non-default authentication secrets in production', () => {
    const missing = validateEnv({ NODE_ENV: 'production' })
    expect(missing.success).toBe(false)

    const configured = validateEnv({
      NODE_ENV: 'production',
      AUTH_OTP_PEPPER: 'o'.repeat(32),
      AUTH_SESSION_PEPPER: 's'.repeat(32),
      AUTH_ABUSE_PEPPER: 'a'.repeat(32),
      API_TRUST_PROXY_HOPS: '0',
    })
    expect(configured.success).toBe(true)

    const reused = validateEnv({
      NODE_ENV: 'production',
      AUTH_OTP_PEPPER: 'x'.repeat(32),
      AUTH_SESSION_PEPPER: 'x'.repeat(32),
      AUTH_ABUSE_PEPPER: 'x'.repeat(32),
    })
    expect(reused.success).toBe(false)
  })

  it('bounds explicitly trusted proxy hops', () => {
    expect(validateEnv({ API_TRUST_PROXY_HOPS: '3' }).success).toBe(true)
    expect(validateEnv({ API_TRUST_PROXY_HOPS: '4' }).success).toBe(false)
  })

  it('refuses to start in production until the proxy topology is stated', () => {
    const productionSecrets = {
      NODE_ENV: 'production',
      AUTH_OTP_PEPPER: 'o'.repeat(32),
      AUTH_SESSION_PEPPER: 's'.repeat(32),
      AUTH_ABUSE_PEPPER: 'a'.repeat(32),
    }

    // Silently defaulting this behind a load balancer would key rate limiting
    // and OTP abuse control on the proxy address for every user.
    const unset = validateEnv(productionSecrets)
    expect(unset.success).toBe(false)
    if (!unset.success) {
      expect(unset.errors.join(' ')).toContain('API_TRUST_PROXY_HOPS')
    }

    // Both answers are acceptable, as long as the operator gave one.
    expect(validateEnv({ ...productionSecrets, API_TRUST_PROXY_HOPS: '0' }).success).toBe(true)
    expect(validateEnv({ ...productionSecrets, API_TRUST_PROXY_HOPS: '1' }).success).toBe(true)
  })

  it('requires a valid URL for the payment callback base when provided', () => {
    expect(validateEnv({}).success).toBe(true)
    expect(validateEnv({ PAYMENT_CALLBACK_BASE_URL: 'https://api.alonoon.ir' }).success).toBe(true)
    expect(validateEnv({ PAYMENT_CALLBACK_BASE_URL: 'not-a-url' }).success).toBe(false)
  })

  it('parses exact credential-safe CORS origins', () => {
    expect(parseCorsOrigins('http://localhost:3000, https://app.alonoon.ir')).toEqual([
      'http://localhost:3000',
      'https://app.alonoon.ir',
    ])
    expect(() => parseCorsOrigins('*')).toThrow('wildcard')
    expect(() => parseCorsOrigins('https://app.alonoon.ir/path')).toThrow('path')
  })
})
