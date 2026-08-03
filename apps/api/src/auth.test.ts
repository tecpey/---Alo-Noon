import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccessGrantContract, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import {
  authorizeGrants,
  type AuthDependencies,
  type AuthRepository,
  type OtpChallengeRecord,
} from './modules/auth'
import {
  AuthenticationDeliveryError,
  authenticationIdentifierDigest,
  authenticationOtpDigest,
  authenticationSessionDigest,
  isRetryableAuthenticationConflict,
  normalizeAuthenticationClientIp,
} from './modules/auth-delivery'

const tenantId = '00000000-0000-4000-8000-000000000001'
const accountId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const cityId = '33333333-3333-4333-8333-333333333333'
const otherCityId = '44444444-4444-4444-8444-444444444444'
const now = new Date('2026-07-29T12:00:00.000Z')
const otpHeaders = { 'idempotency-key': 'otp-request-key-0001' }

class MemoryAuthRepository implements AuthRepository {
  resolvedTenantId: string | null = tenantId
  challenge: OtpChallengeRecord | null = null
  session: SessionContext | null = null
  sessionDigest: string | null = null

  async resolveTenantByHost(): Promise<string | null> {
    return this.resolvedTenantId
  }

  async findChallenge(challengeId: string): Promise<OtpChallengeRecord | null> {
    return this.challenge?.id === challengeId ? this.challenge : null
  }

  async recordFailedAttempt(): Promise<void> {
    if (!this.challenge) return
    this.challenge.attempts += 1
    if (this.challenge.attempts >= this.challenge.maxAttempts) {
      this.challenge.status = 'INVALIDATED'
    }
  }

  async consumeChallengeAndCreateSession(
    input: Parameters<AuthRepository['consumeChallengeAndCreateSession']>[0],
  ): Promise<SessionContext | null> {
    if (
      this.challenge?.id !== input.challengeId ||
      !['DELIVERED', 'DELIVERY_UNKNOWN'].includes(this.challenge.status)
    )
      return null
    this.challenge.status = 'CONSUMED'
    this.sessionDigest = input.tokenDigest
    this.session = {
      tenantId: input.tenantId,
      accountId,
      customerId,
      expiresAt: input.expiresAt.toISOString(),
      grants: [
        {
          roleCode: 'CUSTOMER',
          permissions: ['session.self.read'],
          scopeType: 'SELF',
          scopeId: accountId,
          expiresAt: null,
        },
      ],
    }
    return this.session
  }

  async findSession(tokenDigest: string): Promise<SessionContext | null> {
    return tokenDigest === this.sessionDigest ? this.session : null
  }

  async revokeSession(tokenDigest: string): Promise<boolean> {
    if (tokenDigest !== this.sessionDigest || !this.session) return false
    this.session = null
    return true
  }
}

function fixture(overrides: Partial<AuthDependencies> = {}): {
  dependencies: AuthDependencies
  repository: MemoryAuthRepository
  deliveredCodes: string[]
} {
  const repository = new MemoryAuthRepository()
  const deliveredCodes: string[] = []
  const otpPepper = 'otp-test-pepper-that-is-long-enough'
  const deliveryService = {
    request: async (command: {
      tenantId: string
      mobileE164: string
      idempotencyKey: string
      sourceIp: string
      now: Date
      correlationId: string
    }) => {
      const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const code = '004231'
      const expiresAt = new Date(command.now.getTime() + 5 * 60_000)
      deliveredCodes.push(code)
      repository.challenge = {
        id: challengeId,
        mobileE164: command.mobileE164,
        codeDigest: authenticationOtpDigest(otpPepper, tenantId, challengeId, code),
        status: 'DELIVERED',
        attempts: 0,
        maxAttempts: 5,
        expiresAt,
      }
      return {
        challengeId,
        expiresAt,
        retryAfterSeconds: 60,
        replayed: false,
        uncertain: false,
      }
    },
  }
  return {
    repository,
    deliveredCodes,
    dependencies: {
      repository,
      deliveryService,
      otpPepper,
      abusePepper: 'abuse-test-pepper-that-is-long-enough',
      sessionPepper: 'session-test-pepper-that-is-long-enough',
      secureCookie: false,
      now: () => new Date(now),
      generateSessionToken: () => 'opaque-session-token',
      ...overrides,
    },
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
})

describe('OTP authentication API', () => {
  it('issues a generic challenge while persisting only a digest', async () => {
    const { dependencies, repository, deliveredCodes } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })

    expect(response.statusCode).toBe(202)
    expect(deliveredCodes).toEqual(['004231'])
    expect(repository.challenge?.codeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(repository.challenge?.codeDigest).not.toContain('004231')
    expect(response.body).not.toContain('+989111234567')
    expect(response.body).not.toContain('004231')
  })

  it('rejects malformed phone input before delivery', async () => {
    const { dependencies, deliveredCodes } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '09111234567' },
    })

    expect(response.statusCode).toBe(400)
    expect(deliveredCodes).toEqual([])
  })

  it('fails closed without leaking details when delivery is unavailable', async () => {
    const { dependencies, repository } = fixture({
      deliveryService: {
        request: async () => {
          throw new AuthenticationDeliveryError('AUTH_DELIVERY_PROVIDER_UNAVAILABLE', 503)
        },
      },
    })
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })

    expect(response.statusCode).toBe(503)
    expect(repository.challenge).toBeNull()
    expect(response.body).not.toContain('AUTH_DELIVERY_PROVIDER_UNAVAILABLE')
    expect(response.body).not.toContain('+989111234567')
  })

  it('returns generic acceptance when a private abuse decision suppresses delivery', async () => {
    const { dependencies, deliveredCodes } = fixture({
      deliveryService: {
        request: async ({ now: requestedAt }) => ({
          challengeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expiresAt: new Date(requestedAt.getTime() + 5 * 60_000),
          retryAfterSeconds: 60,
          replayed: false,
          uncertain: true,
        }),
      },
    })
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })

    expect(response.statusCode).toBe(202)
    expect(response.headers['retry-after']).toBeUndefined()
    expect(deliveredCodes).toEqual([])
  })

  it('ignores forwarded IPs by default and selects only the first untrusted hop', async () => {
    const direct = fixture()
    let directIp = ''
    direct.dependencies.deliveryService = {
      request: async (command) => {
        directIp = command.sourceIp
        return {
          challengeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expiresAt: new Date(command.now.getTime() + 5 * 60_000),
          retryAfterSeconds: 60,
          replayed: false,
          uncertain: false,
        }
      },
    }
    const directApp = await buildApp({ auth: direct.dependencies })
    apps.push(directApp)
    await directApp.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: { ...otpHeaders, 'x-forwarded-for': '198.51.100.20, 203.0.113.20' },
      payload: { mobileE164: '+989111234567' },
    })
    expect(directIp).toBe('127.0.0.1')

    const proxied = fixture()
    let proxiedIp = ''
    proxied.dependencies.deliveryService = {
      request: async (command) => {
        proxiedIp = command.sourceIp
        return {
          challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          expiresAt: new Date(command.now.getTime() + 5 * 60_000),
          retryAfterSeconds: 60,
          replayed: false,
          uncertain: false,
        }
      },
    }
    const proxiedApp = await buildApp({ auth: proxied.dependencies, trustProxyHops: 1 })
    apps.push(proxiedApp)
    await proxiedApp.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: { ...otpHeaders, 'x-forwarded-for': '198.51.100.20, 203.0.113.20' },
      payload: { mobileE164: '+989111234567' },
    })
    expect(proxiedIp).toBe('203.0.113.20')
  })

  it('verifies once, creates an opaque cookie session, and rejects replay', async () => {
    const { dependencies } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })
    const challengeId = requested.json().data.challengeId as string

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '004231' },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.headers['set-cookie']).toContain('HttpOnly')
    expect(verified.headers['set-cookie']).toContain('SameSite=Lax')
    expect(verified.body).not.toContain('opaque-session-token')

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '004231' },
    })
    expect(replay.statusCode).toBe(401)
  })

  it('rejects an expired challenge without creating a session', async () => {
    const { dependencies, repository } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })
    const challengeId = requested.json().data.challengeId as string
    if (repository.challenge) {
      repository.challenge.expiresAt = new Date('2026-07-29T11:59:59.000Z')
    }

    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '004231' },
    })
    expect(expired.statusCode).toBe(401)
    expect(repository.session).toBeNull()
  })

  it('invalidates a challenge after the bounded number of failed attempts', async () => {
    const { dependencies, repository } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })
    const challengeId = requested.json().data.challengeId as string

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { challengeId, code: '999999' },
      })
      expect(rejected.statusCode).toBe(401)
    }
    expect(repository.challenge).toMatchObject({ attempts: 5, status: 'INVALIDATED' })

    const correctAfterLimit = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '004231' },
    })
    expect(correctAfterLimit.statusCode).toBe(401)
    expect(repository.session).toBeNull()
  })

  it('returns a generic unavailable response when a failed attempt cannot be persisted', async () => {
    const { dependencies, repository } = fixture()
    repository.recordFailedAttempt = vi.fn().mockRejectedValue(new Error('persistence unavailable'))
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })
    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId: requested.json().data.challengeId, code: '999999' },
    })

    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toMatchObject({
      success: false,
      error: { code: 'AUTHENTICATION_UNAVAILABLE' },
    })
    expect(unavailable.body).not.toContain('persistence unavailable')
  })

  it('bounds failed verification and supports inspection plus logout', async () => {
    const { dependencies, repository } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: otpHeaders,
      payload: { mobileE164: '+989111234567' },
    })
    const challengeId = requested.json().data.challengeId as string
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '999999' },
    })
    expect(rejected.statusCode).toBe(401)
    expect(repository.challenge?.attempts).toBe(1)

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { challengeId, code: '004231' },
    })
    const cookie = verified.headers['set-cookie']
    expect(typeof cookie).toBe('string')

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookie as string },
    })
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({ data: { accountId, customerId } })

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie: cookie as string },
    })
    expect(logout.statusCode).toBe(204)
    expect(logout.headers['set-cookie']).toContain('Max-Age=0')

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookie as string },
    })
    expect(revoked.statusCode).toBe(401)
  })
  it('fails closed for an unverified tenant host even with a forged tenant header', async () => {
    const { dependencies, repository, deliveredCodes } = fixture()
    repository.resolvedTenantId = null
    const app = await buildApp({ auth: dependencies })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: {
        host: 'forged.example',
        'x-tenant-id': tenantId,
        'idempotency-key': otpHeaders['idempotency-key'],
      },
      payload: { mobileE164: '+989111234567', tenantId },
    })
    expect(response.statusCode).toBe(404)
    expect(deliveredCodes).toEqual([])
  })
})

describe('scoped authorization', () => {
  const grant = (
    scopeType: AccessGrantContract['scopeType'],
    scopeId: string | null,
  ): AccessGrantContract => ({
    roleCode: 'CITY_OPERATOR',
    permissions: ['catalog.manage'],
    scopeType,
    scopeId,
    expiresAt: null,
  })

  it('allows global and matching hierarchical context grants', () => {
    expect(authorizeGrants([grant('GLOBAL', null)], 'catalog.manage', {})).toBe(true)
    expect(
      authorizeGrants([grant('CITY', cityId)], 'catalog.manage', {
        cityId,
        operationalZoneId: '55555555-5555-4555-8555-555555555555',
      }),
    ).toBe(true)
  })

  it('denies missing permission, mismatched scope, and expired grants', () => {
    expect(
      authorizeGrants([grant('CITY', cityId)], 'catalog.manage', { cityId: otherCityId }),
    ).toBe(false)
    expect(authorizeGrants([grant('CITY', cityId)], 'orders.refund', { cityId })).toBe(false)
    expect(
      authorizeGrants(
        [{ ...grant('CITY', cityId), expiresAt: '2026-07-29T11:59:59.000Z' }],
        'catalog.manage',
        { cityId },
        now,
      ),
    ).toBe(false)
  })
})

describe('authentication security primitives', () => {
  it('domain-separates OTP, session, mobile, and source-IP HMAC inputs', () => {
    const pepper = 'purpose-separation-pepper-that-is-long-enough'
    const repeated = '00000000-0000-4000-8000-000000000001'
    const digests = new Set([
      authenticationOtpDigest(pepper, tenantId, repeated, '123456'),
      authenticationSessionDigest(pepper, `${repeated}:123456`),
      authenticationIdentifierDigest(pepper, 'mobile', repeated),
      authenticationIdentifierDigest(pepper, 'source-ip', repeated),
    ])
    expect(digests.size).toBe(4)
  })

  it('canonicalizes IP forms and rejects malformed addresses', () => {
    expect(normalizeAuthenticationClientIp('::ffff:203.0.113.10')).toBe('203.0.113.10')
    expect(normalizeAuthenticationClientIp('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(normalizeAuthenticationClientIp('203.0.113.10')).toBe('203.0.113.10')
    expect(() => normalizeAuthenticationClientIp('attacker-controlled')).toThrow(
      'AUTH_SOURCE_IP_UNAVAILABLE',
    )
  })

  it('retries P2010 only when metadata carries SQLSTATE 40001', () => {
    expect(isRetryableAuthenticationConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
    expect(isRetryableAuthenticationConflict({ code: 'P2010', meta: { code: '23505' } })).toBe(
      false,
    )
    expect(isRetryableAuthenticationConflict({ code: 'P2010' })).toBe(false)
    expect(isRetryableAuthenticationConflict({ code: 'P2002' })).toBe(false)
  })
})
