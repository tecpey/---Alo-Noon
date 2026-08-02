import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  otpRequestSchema,
  otpVerifySchema,
  type AccessGrantContract,
  type AuthorizationScopeType,
  type ErrorEnvelope,
  type OtpRequestAccepted,
  type ResponseMeta,
  type SessionContext,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_RESEND_COOLDOWN_MS = 60 * 1000
const OTP_REQUEST_WINDOW_MS = 60 * 60 * 1000
const OTP_REQUEST_LIMIT = 5
const OTP_MAX_ATTEMPTS = 5
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_COOKIE = 'alo_session'
const SESSION_SELF_PERMISSION = 'session.self.read'

export interface OtpDeliveryProvider {
  send(input: { mobileE164: string; code: string; expiresAt: Date }): Promise<void>
}

export interface OtpChallengeRecord {
  id: string
  mobileE164: string
  codeDigest: string
  status: 'PENDING' | 'CONSUMED' | 'INVALIDATED'
  attempts: number
  maxAttempts: number
  expiresAt: Date
}

export type CreateChallengeResult =
  | { status: 'CREATED'; challengeId: string }
  | { status: 'COOLDOWN'; retryAfterSeconds: number }
  | { status: 'RATE_LIMITED'; retryAfterSeconds: number }

export interface AuthorizationContext {
  cityId?: string
  operationalZoneId?: string
  bakeryBranchId?: string
  courierPartnerId?: string
  selfId?: string
}

export interface AuthRepository {
  resolveTenantByHost(host: string): Promise<string | null>
  createChallenge(input: {
    id: string
    mobileE164: string
    codeDigest: string
    now: Date
    expiresAt: Date
    resendAvailableAt: Date
    maxAttempts: number
    requestWindowStartedAt: Date
    requestLimit: number
    correlationId: string
    tenantId: string
  }): Promise<CreateChallengeResult>
  invalidateChallenge(
    challengeId: string,
    tenantId: string,
    now: Date,
    correlationId: string,
  ): Promise<void>
  findChallenge(challengeId: string): Promise<OtpChallengeRecord | null>
  recordFailedAttempt(challengeId: string, now: Date): Promise<void>
  consumeChallenge(
    challengeId: string,
    mobileE164: string,
    tenantId: string,
    now: Date,
    correlationId: string,
  ): Promise<{ accountId: string; customerId: string } | null>
  createSession(input: {
    tenantId: string
    accountId: string
    tokenDigest: string
    now: Date
    expiresAt: Date
    correlationId: string
  }): Promise<SessionContext>
  findSession(tokenDigest: string, tenantId: string, now: Date): Promise<SessionContext | null>
  revokeSession(tokenDigest: string, now: Date, correlationId: string): Promise<boolean>
}

export interface AuthDependencies {
  repository: AuthRepository
  deliveryProvider: OtpDeliveryProvider
  otpPepper: string
  sessionPepper: string
  secureCookie: boolean
  now?: () => Date
  generateOtp?: () => string
  generateSessionToken?: () => string
}

export class OtpThrottledError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly rateLimited: boolean,
  ) {
    super(rateLimited ? 'OTP request limit reached' : 'OTP resend cooldown active')
  }
}

export class InvalidOtpError extends Error {}
export class DeliveryUnavailableError extends Error {}
export class TenantUnavailableError extends Error {}

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthDependencies): void {
  app.post('/api/v1/auth/otp/request', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const tenantId = await resolveTenantId(request, dependencies)
    if (!tenantId)
      return reply
        .code(404)
        .send(errorEnvelope('TENANT_NOT_FOUND', 'The requested service is unavailable.'))
    const parsed = otpRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorEnvelope('INVALID_OTP_REQUEST', 'OTP request is invalid.', parsed.error.flatten()),
        )
    }

    try {
      const accepted = await requestOtp(parsed.data.mobileE164, tenantId, dependencies)
      return reply.code(202).send({
        success: true,
        data: accepted,
        meta: responseMeta(),
      })
    } catch (error) {
      if (error instanceof OtpThrottledError) {
        reply.header('Retry-After', String(error.retryAfterSeconds))
        return reply
          .code(429)
          .send(
            errorEnvelope(
              error.rateLimited ? 'OTP_RATE_LIMITED' : 'OTP_COOLDOWN_ACTIVE',
              'A verification code cannot be requested yet.',
            ),
          )
      }
      request.log.error({ err: error }, 'OTP delivery failed')
      return reply
        .code(503)
        .send(errorEnvelope('OTP_DELIVERY_UNAVAILABLE', 'Verification is temporarily unavailable.'))
    }
  })

  app.post('/api/v1/auth/otp/verify', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const tenantId = await resolveTenantId(request, dependencies)
    if (!tenantId)
      return reply
        .code(404)
        .send(errorEnvelope('TENANT_NOT_FOUND', 'The requested service is unavailable.'))
    const parsed = otpVerifySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            'INVALID_OTP_VERIFICATION',
            'OTP verification request is invalid.',
            parsed.error.flatten(),
          ),
        )
    }

    try {
      const result = await verifyOtp(
        parsed.data.challengeId,
        parsed.data.code,
        tenantId,
        dependencies,
      )
      reply.header(
        'Set-Cookie',
        sessionCookie(result.token, result.context.expiresAt, dependencies),
      )
      return {
        success: true,
        data: result.context,
        meta: responseMeta(),
      }
    } catch (error) {
      if (!(error instanceof InvalidOtpError)) {
        request.log.error({ err: error }, 'OTP verification failed')
      }
      return reply
        .code(401)
        .send(errorEnvelope('OTP_INVALID_OR_EXPIRED', 'Verification code is invalid or expired.'))
    }
  })

  app.get('/api/v1/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticateRequest(request, dependencies)
    if (
      !session ||
      !authorizeGrants(session.grants, SESSION_SELF_PERMISSION, {
        selfId: session.accountId,
      })
    ) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid session is required.'))
    }

    return {
      success: true,
      data: session,
      meta: responseMeta(),
    }
  })

  app.delete('/api/v1/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const token = sessionTokenFromRequest(request)
    if (token) {
      await dependencies.repository.revokeSession(
        digest(dependencies.sessionPepper, token),
        currentTime(dependencies),
        randomUUID(),
      )
    }
    reply.header('Set-Cookie', clearSessionCookie(dependencies.secureCookie))
    return reply.code(204).send()
  })
}

export async function requestOtp(
  mobileE164: string,
  tenantId: string,
  dependencies: AuthDependencies,
): Promise<OtpRequestAccepted> {
  const now = currentTime(dependencies)
  const challengeId = randomUUID()
  const code = dependencies.generateOtp?.() ?? String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS)
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS)
  const correlationId = randomUUID()
  const created = await dependencies.repository.createChallenge({
    id: challengeId,
    mobileE164,
    codeDigest: otpDigest(dependencies.otpPepper, challengeId, code),
    now,
    expiresAt,
    resendAvailableAt,
    maxAttempts: OTP_MAX_ATTEMPTS,
    requestWindowStartedAt: new Date(now.getTime() - OTP_REQUEST_WINDOW_MS),
    requestLimit: OTP_REQUEST_LIMIT,
    correlationId,
    tenantId,
  })

  if (created.status !== 'CREATED') {
    throw new OtpThrottledError(created.retryAfterSeconds, created.status === 'RATE_LIMITED')
  }

  try {
    await dependencies.deliveryProvider.send({ mobileE164, code, expiresAt })
  } catch {
    await dependencies.repository.invalidateChallenge(challengeId, tenantId, now, correlationId)
    throw new DeliveryUnavailableError()
  }

  return {
    challengeId,
    expiresAt: expiresAt.toISOString(),
    retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000),
  }
}

export async function verifyOtp(
  challengeId: string,
  code: string,
  tenantId: string,
  dependencies: AuthDependencies,
): Promise<{ context: SessionContext; token: string }> {
  const now = currentTime(dependencies)
  const challenge = await dependencies.repository.findChallenge(challengeId)

  if (
    !challenge ||
    challenge.status !== 'PENDING' ||
    challenge.expiresAt <= now ||
    challenge.attempts >= challenge.maxAttempts
  ) {
    throw new InvalidOtpError()
  }

  const suppliedDigest = otpDigest(dependencies.otpPepper, challenge.id, code)
  if (!safeDigestEqual(challenge.codeDigest, suppliedDigest)) {
    await dependencies.repository.recordFailedAttempt(challenge.id, now)
    throw new InvalidOtpError()
  }

  const account = await dependencies.repository.consumeChallenge(
    challenge.id,
    challenge.mobileE164,
    tenantId,
    now,
    randomUUID(),
  )
  if (!account) throw new InvalidOtpError()

  const token = dependencies.generateSessionToken?.() ?? randomBytes(32).toString('base64url')
  const context = await dependencies.repository.createSession({
    tenantId,
    accountId: account.accountId,
    tokenDigest: digest(dependencies.sessionPepper, token),
    now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    correlationId: randomUUID(),
  })
  return { context, token }
}

export function authorizeGrants(
  grants: AccessGrantContract[],
  permission: string,
  context: AuthorizationContext,
  now = new Date(),
): boolean {
  return grants.some((grant) => {
    if (!grant.permissions.includes(permission)) return false
    if (grant.expiresAt && new Date(grant.expiresAt) <= now) return false

    switch (grant.scopeType) {
      case 'GLOBAL':
        return grant.scopeId === null
      case 'CITY':
        return grant.scopeId === context.cityId
      case 'OPERATIONAL_ZONE':
        return grant.scopeId === context.operationalZoneId
      case 'BAKERY_BRANCH':
        return grant.scopeId === context.bakeryBranchId
      case 'COURIER_PARTNER':
        return grant.scopeId === context.courierPartnerId
      case 'SELF':
        return grant.scopeId === context.selfId
    }
  })
}

export function createPrismaAuthRepository(prisma: PrismaClient): AuthRepository {
  return {
    async resolveTenantByHost(host) {
      const domain = await prisma.tenantDomain.findFirst({
        where: { host: normalizeHost(host), tenant: { is: { status: 'ACTIVE' } } },
        select: { tenantId: true },
      })
      return domain?.tenantId ?? null
    },

    async createChallenge(input) {
      return tenantTransaction(
        prisma,
        input.tenantId,
        async (transaction) => {
          const recent = await transaction.otpChallenge.findFirst({
            where: {
              mobileE164: input.mobileE164,
              resendAvailableAt: { gt: input.now },
            },
            orderBy: { createdAt: 'desc' },
            select: { resendAvailableAt: true },
          })
          if (recent) {
            return {
              status: 'COOLDOWN',
              retryAfterSeconds: secondsUntil(recent.resendAvailableAt, input.now),
            }
          }

          const requestCount = await transaction.otpChallenge.count({
            where: {
              mobileE164: input.mobileE164,
              createdAt: { gte: input.requestWindowStartedAt },
            },
          })
          if (requestCount >= input.requestLimit) {
            const oldestRequest = await transaction.otpChallenge.findFirst({
              where: {
                mobileE164: input.mobileE164,
                createdAt: { gte: input.requestWindowStartedAt },
              },
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            })
            return {
              status: 'RATE_LIMITED',
              retryAfterSeconds: secondsUntil(
                new Date((oldestRequest?.createdAt ?? input.now).getTime() + OTP_REQUEST_WINDOW_MS),
                input.now,
              ),
            }
          }

          await transaction.otpChallenge.create({
            data: {
              id: input.id,
              mobileE164: input.mobileE164,
              codeDigest: input.codeDigest,
              expiresAt: input.expiresAt,
              resendAvailableAt: input.resendAvailableAt,
              maxAttempts: input.maxAttempts,
            },
          })
          await transaction.auditEvent.create({
            data: {
              tenantId: input.tenantId,
              actorType: 'SYSTEM',
              action: 'auth.otp.requested',
              entityType: 'otp_challenge',
              entityId: input.id,
              summary: 'OTP challenge requested',
              correlationId: input.correlationId,
              occurredAt: input.now,
            },
          })
          return { status: 'CREATED', challengeId: input.id }
        },
        'Serializable',
      )
    },

    async invalidateChallenge(challengeId, tenantId, now, correlationId) {
      await tenantTransaction(prisma, tenantId, async (transaction) => {
        await transaction.otpChallenge.updateMany({
          where: { id: challengeId, status: 'PENDING' },
          data: { status: 'INVALIDATED', invalidatedAt: now },
        })
        await transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'SYSTEM',
            action: 'auth.otp.delivery_failed',
            entityType: 'otp_challenge',
            entityId: challengeId,
            summary: 'OTP challenge invalidated after delivery failure',
            correlationId,
            occurredAt: now,
          },
        })
      })
    },

    async findChallenge(challengeId) {
      return prisma.otpChallenge.findUnique({
        where: { id: challengeId },
        select: {
          id: true,
          mobileE164: true,
          codeDigest: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          expiresAt: true,
        },
      })
    },

    async recordFailedAttempt(challengeId, now) {
      const incremented = await prisma.otpChallenge.updateMany({
        where: {
          id: challengeId,
          status: 'PENDING',
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: { attempts: { increment: 1 } },
      })
      if (incremented.count !== 1) return
      await prisma.otpChallenge.updateMany({
        where: {
          id: challengeId,
          status: 'PENDING',
          attempts: { gte: OTP_MAX_ATTEMPTS },
        },
        data: { status: 'INVALIDATED', invalidatedAt: now },
      })
    },

    async consumeChallenge(challengeId, mobileE164, tenantId, now, correlationId) {
      return tenantTransaction(
        prisma,
        tenantId,
        async (transaction) => {
          const existingAccount = await transaction.identityAccount.findUnique({
            where: { mobileE164 },
            select: { status: true },
          })
          if (existingAccount && existingAccount.status !== 'ACTIVE') return null

          const consumed = await transaction.otpChallenge.updateMany({
            where: {
              id: challengeId,
              mobileE164,
              status: 'PENDING',
              expiresAt: { gt: now },
              attempts: { lt: OTP_MAX_ATTEMPTS },
            },
            data: { status: 'CONSUMED', consumedAt: now },
          })
          if (consumed.count !== 1) return null

          const existingCustomer = await transaction.customer.findUnique({
            where: { mobileE164 },
            select: { tenantId: true },
          })
          if (existingCustomer && existingCustomer.tenantId !== tenantId) return null
          const customer = await transaction.customer.upsert({
            where: { mobileE164 },
            update: { lifecycleStatus: 'ACTIVE' },
            create: { tenantId, mobileE164, lifecycleStatus: 'ACTIVE' },
          })
          const account = await transaction.identityAccount.upsert({
            where: { mobileE164 },
            update: { customerId: customer.id, verifiedAt: now },
            create: {
              mobileE164,
              customerId: customer.id,
              verifiedAt: now,
            },
          })
          if (account.status !== 'ACTIVE') return null
          await transaction.tenantMembership.upsert({
            where: { tenantId_accountId: { tenantId, accountId: account.id } },
            update: { status: 'ACTIVE', activeAt: now, suspendedAt: null, revokedAt: null },
            create: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
          })

          const permission = await transaction.authorizationPermission.upsert({
            where: { code: SESSION_SELF_PERMISSION },
            update: {},
            create: {
              code: SESSION_SELF_PERMISSION,
              description: 'Read the current authenticated session',
            },
          })
          const role = await transaction.authorizationRole.upsert({
            where: { code: 'CUSTOMER' },
            update: {},
            create: { code: 'CUSTOMER', name: 'Customer' },
          })
          await transaction.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: role.id,
                permissionId: permission.id,
              },
            },
            update: {},
            create: { roleId: role.id, permissionId: permission.id },
          })
          const existingGrant = await transaction.accessGrant.findFirst({
            where: {
              accountId: account.id,
              roleId: role.id,
              scopeType: 'SELF',
              scopeId: account.id,
              revokedAt: null,
            },
            select: { id: true },
          })
          if (!existingGrant) {
            await transaction.accessGrant.create({
              data: {
                accountId: account.id,
                roleId: role.id,
                scopeType: 'SELF',
                scopeId: account.id,
              },
            })
          }
          await transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: 'CUSTOMER',
              actorId: customer.id,
              action: 'auth.identity.verified',
              entityType: 'identity_account',
              entityId: account.id,
              summary: 'Customer identity verified',
              correlationId,
              occurredAt: now,
            },
          })
          return { accountId: account.id, customerId: customer.id }
        },
        'Serializable',
      )
    },

    async createSession(input) {
      return tenantTransaction(prisma, input.tenantId, async (transaction) => {
        const session = await transaction.authSession.create({
          data: {
            accountId: input.accountId,
            activeTenantId: input.tenantId,
            tokenDigest: input.tokenDigest,
            expiresAt: input.expiresAt,
            lastSeenAt: input.now,
          },
          select: {
            id: true,
            account: { select: { customerId: true } },
          },
        })
        await transaction.auditEvent.create({
          data: {
            tenantId: input.tenantId,
            actorType: 'CUSTOMER',
            actorId: session.account.customerId,
            action: 'auth.session.created',
            entityType: 'auth_session',
            entityId: session.id,
            summary: 'Authenticated session created',
            correlationId: input.correlationId,
            occurredAt: input.now,
          },
        })
        return loadSessionContext(
          transaction,
          input.tokenDigest,
          input.tenantId,
          input.now,
          input.expiresAt,
        )
      })
    },

    async findSession(tokenDigest, tenantId, now) {
      return tenantTransaction(prisma, tenantId, (transaction) =>
        loadSessionContext(transaction, tokenDigest, tenantId, now),
      )
    },

    async revokeSession(tokenDigest, now, correlationId) {
      const session = await prisma.authSession.findUnique({
        where: { tokenDigest },
        select: {
          id: true,
          activeTenantId: true,
          account: { select: { customerId: true } },
          revokedAt: true,
        },
      })
      if (!session || session.revokedAt) return false

      return tenantTransaction(prisma, session.activeTenantId, async (transaction) => {
        const revoked = await transaction.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        })
        if (revoked.count !== 1) return false
        await transaction.auditEvent.create({
          data: {
            tenantId: session.activeTenantId,
            actorType: 'CUSTOMER',
            actorId: session.account.customerId,
            action: 'auth.session.revoked',
            entityType: 'auth_session',
            entityId: session.id,
            summary: 'Authenticated session revoked',
            correlationId,
            occurredAt: now,
          },
        })
        return true
      })
    },
  }
}

async function tenantTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  isolationLevel?: Prisma.TransactionIsolationLevel,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    isolationLevel ? { isolationLevel } : undefined,
  )
}

async function loadSessionContext(
  prisma: Prisma.TransactionClient,
  tokenDigest: string,
  tenantId: string,
  now: Date,
  expectedExpiry?: Date,
): Promise<SessionContext> {
  const session = await prisma.authSession.findFirst({
    where: {
      tokenDigest,
      activeTenantId: tenantId,
      activeTenant: { is: { status: 'ACTIVE' } },
      revokedAt: null,
      expiresAt: { gt: now },
      account: {
        is: {
          status: 'ACTIVE',
          tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } },
        },
      },
      ...(expectedExpiry && { expiresAt: expectedExpiry }),
    },
    select: {
      accountId: true,
      expiresAt: true,
      account: {
        select: {
          customerId: true,
          accessGrants: {
            where: {
              revokedAt: null,
              activeAt: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: {
              scopeType: true,
              scopeId: true,
              expiresAt: true,
              role: {
                select: {
                  code: true,
                  permissions: {
                    select: { permission: { select: { code: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!session) throw new InvalidOtpError()

  await prisma.authSession.updateMany({
    where: { tokenDigest, revokedAt: null },
    data: { lastSeenAt: now },
  })
  return {
    tenantId,
    accountId: session.accountId,
    customerId: session.account.customerId,
    expiresAt: session.expiresAt.toISOString(),
    grants: session.account.accessGrants.map((grant) => ({
      roleCode: grant.role.code,
      permissions: grant.role.permissions.map(({ permission }) => permission.code),
      scopeType: grant.scopeType as AuthorizationScopeType,
      scopeId: grant.scopeId,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    })),
  }
}

export async function authenticateRequest(
  request: FastifyRequest,
  dependencies: AuthDependencies,
): Promise<SessionContext | null> {
  const token = sessionTokenFromRequest(request)
  if (!token) return null
  const tenantId = await resolveTenantId(request, dependencies)
  if (!tenantId) return null
  return dependencies.repository
    .findSession(digest(dependencies.sessionPepper, token), tenantId, currentTime(dependencies))
    .catch(() => null)
}

export async function resolveTenantId(
  request: FastifyRequest,
  dependencies: AuthDependencies,
): Promise<string | null> {
  return dependencies.repository.resolveTenantByHost(request.hostname).catch(() => null)
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

function sessionTokenFromRequest(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim()
    if (token) return token
  }

  const cookie = request.headers.cookie
  if (!cookie) return undefined
  for (const pair of cookie.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const token = pair.slice(separator + 1).trim()
      if (token) return token
    }
  }
  return undefined
}

function otpDigest(pepper: string, challengeId: string, code: string): string {
  return digest(pepper, `${challengeId}.${code}`)
}

function digest(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex')
}

function safeDigestEqual(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'hex')
  const suppliedBuffer = Buffer.from(supplied, 'hex')
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    expectedBuffer.length > 0 &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  )
}

function currentTime(dependencies: AuthDependencies): Date {
  return dependencies.now?.() ?? new Date()
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000))
}

function sessionCookie(token: string, expiresAt: string, dependencies: AuthDependencies): string {
  const secure = dependencies.secureCookie ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`
}

function clearSessionCookie(secureCookie: boolean): string {
  const secure = secureCookie ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

function responseMeta(): ResponseMeta {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}

function errorEnvelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    success: false,
    error: { code, message, ...(details && { details }) },
    meta: responseMeta(),
  }
}
