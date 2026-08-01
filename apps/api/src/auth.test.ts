import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccessGrantContract, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import {
  authorizeGrants,
  type AuthDependencies,
  type AuthRepository,
  type CreateChallengeResult,
  type OtpChallengeRecord,
} from './modules/auth'

const tenantId = '00000000-0000-4000-8000-000000000001'
const accountId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const cityId = '33333333-3333-4333-8333-333333333333'
const otherCityId = '44444444-4444-4444-8444-444444444444'
const now = new Date('2026-07-29T12:00:00.000Z')

class MemoryAuthRepository implements AuthRepository {
  resolvedTenantId: string | null = tenantId
  challenge: OtpChallengeRecord | null = null
  invalidated = false
  session: SessionContext | null = null
  sessionDigest: string | null = null
  createResult: CreateChallengeResult | null = null

  async resolveTenantByHost(): Promise<string | null> {
    return this.resolvedTenantId
  }

  async createChallenge(
    input: Parameters<AuthRepository['createChallenge']>[0],
  ): Promise<CreateChallengeResult> {
    if (this.createResult) return this.createResult
    this.challenge = {
      id: input.id,
      mobileE164: input.mobileE164,
      codeDigest: input.codeDigest,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      expiresAt: input.expiresAt,
    }
    return { status: 'CREATED', challengeId: input.id }
  }

  async invalidateChallenge(): Promise<void> {
    this.invalidated = true
    if (this.challenge) this.challenge.status = 'INVALIDATED'
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

  async consumeChallenge(
    challengeId: string,
  ): Promise<{ accountId: string; customerId: string } | null> {
    if (this.challenge?.id !== challengeId || this.challenge.status !== 'PENDING') return null
    this.challenge.status = 'CONSUMED'
    return { accountId, customerId }
  }

  async createSession(
    input: Parameters<AuthRepository['createSession']>[0],
  ): Promise<SessionContext> {
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
  return {
    repository,
    deliveredCodes,
    dependencies: {
      repository,
      deliveryProvider: {
        send: async ({ code }) => {
          deliveredCodes.push(code)
        },
      },
      otpPepper: 'otp-test-pepper-that-is-long-enough',
      sessionPepper: 'session-test-pepper-that-is-long-enough',
      secureCookie: false,
      now: () => new Date(now),
      generateOtp: () => '004231',
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
      payload: { mobileE164: '09111234567' },
    })

    expect(response.statusCode).toBe(400)
    expect(deliveredCodes).toEqual([])
  })

  it('invalidates a challenge when the delivery provider is unavailable', async () => {
    const { dependencies, repository } = fixture({
      deliveryProvider: {
        send: async () => {
          throw new Error('provider secret and destination must not leak')
        },
      },
    })
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { mobileE164: '+989111234567' },
    })

    expect(response.statusCode).toBe(503)
    expect(repository.invalidated).toBe(true)
    expect(response.body).not.toContain('provider secret')
    expect(response.body).not.toContain('+989111234567')
  })

  it('returns a bounded retry response during cooldown', async () => {
    const { dependencies, repository } = fixture()
    repository.createResult = { status: 'COOLDOWN', retryAfterSeconds: 42 }
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { mobileE164: '+989111234567' },
    })

    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('42')
    expect(response.json()).toMatchObject({ error: { code: 'OTP_COOLDOWN_ACTIVE' } })
  })

  it('verifies once, creates an opaque cookie session, and rejects replay', async () => {
    const { dependencies } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
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

  it('bounds failed verification and supports inspection plus logout', async () => {
    const { dependencies, repository } = fixture()
    const app = await buildApp({ auth: dependencies })
    apps.push(app)

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
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
      headers: { host: 'forged.example', 'x-tenant-id': tenantId },
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
