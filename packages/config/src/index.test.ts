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
      API_TRUST_PROXY: 'none',
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

  it('takes an address for the trusted proxy, not a count of them', () => {
    expect(validateEnv({ API_TRUST_PROXY: 'loopback' }).success).toBe(true)
    expect(validateEnv({ API_TRUST_PROXY: '10.0.0.0/8' }).success).toBe(true)
    expect(validateEnv({ API_TRUST_PROXY: '' }).success).toBe(false)
  })

  it('refuses to boot on the old hop-count variable rather than ignoring it', () => {
    // The dangerous case, and the reason this is an error and not a warning: a
    // server still carrying `API_TRUST_PROXY_HOPS=1` would otherwise start with
    // proxy trust apparently configured and *nothing* actually trusted, because
    // Fastify 5.12 stopped honouring numbers here. Every request would then be
    // attributed to the load balancer, collapsing per-IP rate limiting and OTP
    // abuse control into a single bucket — invisibly, since the service answers
    // normally throughout.
    const carried = validateEnv({ API_TRUST_PROXY_HOPS: '1' })
    expect(carried.success).toBe(false)
    if (!carried.success) {
      expect(carried.errors.join(' ')).toContain('API_TRUST_PROXY')
      // The message has to say what to write instead, not just what is wrong.
      expect(carried.errors.join(' ')).toContain('loopback')
    }
    // Refused outside production too: a developer reading their own logs is
    // just as misled by an IP that is really the proxy's.
    expect(validateEnv({ NODE_ENV: 'development', API_TRUST_PROXY_HOPS: '0' }).success).toBe(false)
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
      expect(unset.errors.join(' ')).toContain('API_TRUST_PROXY')
    }

    // Both answers are acceptable, as long as the operator gave one — including
    // "none", which is how "exposed directly" is said out loud.
    expect(validateEnv({ ...productionSecrets, API_TRUST_PROXY: 'none' }).success).toBe(true)
    expect(validateEnv({ ...productionSecrets, API_TRUST_PROXY: 'loopback' }).success).toBe(true)
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
