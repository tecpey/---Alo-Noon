import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  otpRequestSchema,
  otpIdempotencyKeySchema,
  otpVerificationEventPayloadSchema,
  otpVerifySchema,
  type AccessGrantContract,
  type AuthorizationScopeType,
  type ErrorEnvelope,
  type OtpRequestAccepted,
  type ResponseMeta,
  type SessionContext,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import { normalizeIranianMobile } from '@alo-noon/domain'

import {
  AuthenticationDeliveryError,
  authenticationIdentifierDigest,
  authenticationOtpDigest,
  authenticationSessionDigest,
  isRetryableAuthenticationConflict,
  normalizeAuthenticationClientIp,
  type AuthenticationDeliveryService,
} from './auth-delivery.js'

const OTP_MAX_IP_FAILURES_PER_TEN_MINUTES = 25
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_COOKIE = 'alo_session'
const SESSION_SELF_PERMISSION = 'session.self.read'

export interface OtpChallengeRecord {
  id: string
  mobileE164: string
  codeDigest: string
  status:
    | 'PREPARED'
    | 'DELIVERED'
    | 'DELIVERY_UNKNOWN'
    | 'FAILED'
    | 'CONSUMED'
    | 'INVALIDATED'
    | 'EXPIRED'
  attempts: number
  maxAttempts: number
  expiresAt: Date
}

export interface AuthorizationContext {
  cityId?: string
  operationalZoneId?: string
  bakeryBranchId?: string
  courierPartnerId?: string
  selfId?: string
}

export interface AuthRepository {
  resolveTenantByHost(host: string): Promise<string | null>
  findChallenge(challengeId: string, tenantId: string): Promise<OtpChallengeRecord | null>
  recordFailedAttempt(
    challengeId: string,
    tenantId: string,
    sourceIpDigest: string,
    now: Date,
    correlationId: string,
  ): Promise<void>
  consumeChallengeAndCreateSession(input: {
    challengeId: string
    mobileE164: string
    tenantId: string
    tokenDigest: string
    now: Date
    expiresAt: Date
    correlationId: string
  }): Promise<SessionContext | null>
  findSession(tokenDigest: string, tenantId: string, now: Date): Promise<SessionContext | null>
  revokeSession(
    tokenDigest: string,
    tenantId: string,
    now: Date,
    correlationId: string,
  ): Promise<boolean>
}

export interface AuthDependencies {
  repository: AuthRepository
  deliveryService: AuthenticationDeliveryService
  otpPepper: string
  abusePepper: string
  sessionPepper: string
  secureCookie: boolean
  now?: () => Date
  generateSessionToken?: () => string
}

export class InvalidOtpError extends Error {}
export class TenantUnavailableError extends Error {}

export interface PrismaAuthRepositoryOptions {
  beforeVerificationCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
}

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
      const parsedIdempotencyKey = otpIdempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      )
      if (!parsedIdempotencyKey.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_IDEMPOTENCY_KEY', 'OTP request is invalid.'))
      }
      const accepted = await requestOtp(
        parsed.data.mobileE164,
        tenantId,
        parsedIdempotencyKey.data,
        request.ip,
        dependencies,
      )
      return reply.code(202).send({
        success: true,
        data: accepted,
        meta: responseMeta(),
      })
    } catch (error) {
      if (error instanceof AuthenticationDeliveryError) {
        if (error.status === 409) {
          return reply
            .code(409)
            .send(errorEnvelope(error.code, 'The idempotency key was already used.'))
        }
        request.log.warn({ code: error.code }, 'OTP delivery unavailable')
        return reply
          .code(503)
          .send(
            errorEnvelope('OTP_DELIVERY_UNAVAILABLE', 'Verification is temporarily unavailable.'),
          )
      }
      request.log.error({ errorType: errorName(error) }, 'OTP delivery persistence failed')
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
        request.ip,
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
        request.log.error({ errorType: errorName(error) }, 'OTP verification failed')
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
    const tenantId = await resolveTenantId(request, dependencies)
    if (token && tenantId) {
      await dependencies.repository.revokeSession(
        authenticationSessionDigest(dependencies.sessionPepper, token),
        tenantId,
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
  idempotencyKey: string,
  sourceIp: string,
  dependencies: AuthDependencies,
): Promise<OtpRequestAccepted> {
  const now = currentTime(dependencies)
  const accepted = await dependencies.deliveryService.request({
    tenantId,
    mobileE164: normalizeIranianMobile(mobileE164),
    idempotencyKey,
    sourceIp,
    now,
    correlationId: randomUUID(),
  })
  return {
    challengeId: accepted.challengeId,
    expiresAt: accepted.expiresAt.toISOString(),
    retryAfterSeconds: accepted.retryAfterSeconds,
  }
}

export async function verifyOtp(
  challengeId: string,
  code: string,
  tenantId: string,
  sourceIp: string,
  dependencies: AuthDependencies,
): Promise<{ context: SessionContext; token: string }> {
  const now = currentTime(dependencies)
  const challenge = await dependencies.repository.findChallenge(challengeId, tenantId)

  if (
    !challenge ||
    !['DELIVERED', 'DELIVERY_UNKNOWN'].includes(challenge.status) ||
    challenge.expiresAt <= now ||
    challenge.attempts >= challenge.maxAttempts
  ) {
    throw new InvalidOtpError()
  }

  const suppliedDigest = authenticationOtpDigest(
    dependencies.otpPepper,
    tenantId,
    challenge.id,
    code,
  )
  if (!safeDigestEqual(challenge.codeDigest, suppliedDigest)) {
    await dependencies.repository.recordFailedAttempt(
      challenge.id,
      tenantId,
      authenticationIdentifierDigest(
        dependencies.abusePepper,
        'source-ip',
        normalizeAuthenticationClientIp(sourceIp),
      ),
      now,
      randomUUID(),
    )
    throw new InvalidOtpError()
  }

  const token = dependencies.generateSessionToken?.() ?? randomBytes(32).toString('base64url')
  const context = await dependencies.repository.consumeChallengeAndCreateSession({
    challengeId: challenge.id,
    mobileE164: challenge.mobileE164,
    tenantId,
    tokenDigest: authenticationSessionDigest(dependencies.sessionPepper, token),
    now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    correlationId: randomUUID(),
  })
  if (!context) throw new InvalidOtpError()
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

export function createPrismaAuthRepository(
  prisma: PrismaClient,
  options: PrismaAuthRepositoryOptions = {},
): AuthRepository {
  return {
    async resolveTenantByHost(host) {
      const domain = await prisma.tenantDomain.findFirst({
        where: { host: normalizeHost(host), tenant: { is: { status: 'ACTIVE' } } },
        select: { tenantId: true },
      })
      return domain?.tenantId ?? null
    },

    async findChallenge(challengeId, tenantId) {
      return tenantTransaction(prisma, tenantId, (transaction) =>
        transaction.authOtpChallenge.findFirst({
          where: { id: challengeId, tenantId },
          select: {
            id: true,
            mobileE164: true,
            codeDigest: true,
            status: true,
            attempts: true,
            maxAttempts: true,
            expiresAt: true,
          },
        }),
      )
    },

    async recordFailedAttempt(challengeId, tenantId, sourceIpDigest, now, correlationId) {
      await tenantTransaction(
        prisma,
        tenantId,
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT "id" FROM "AuthOtpChallenge"
            WHERE "id" = ${challengeId}::uuid AND "tenantId" = ${tenantId}::uuid
            FOR UPDATE
          `
          const challenge = await transaction.authOtpChallenge.findFirst({
            where: {
              id: challengeId,
              tenantId,
              status: { in: ['DELIVERED', 'DELIVERY_UNKNOWN'] },
              expiresAt: { gt: now },
            },
          })
          if (!challenge || challenge.attempts >= challenge.maxAttempts) return
          const recentIpFailures = await transaction.authAbuseEvent.count({
            where: {
              tenantId,
              action: 'OTP_VERIFY_FAILURE',
              sourceIpDigest,
              occurredAt: { gte: new Date(now.getTime() - 10 * 60_000) },
            },
          })
          const attempts = challenge.attempts + 1
          const locked =
            attempts >= challenge.maxAttempts ||
            recentIpFailures + 1 >= OTP_MAX_IP_FAILURES_PER_TEN_MINUTES
          await transaction.authOtpChallenge.update({
            where: { id: challenge.id },
            data: {
              attempts,
              ...(locked && { status: 'INVALIDATED', invalidatedAt: now }),
              version: { increment: 1 },
            },
          })
          const payload = otpVerificationEventPayloadSchema.parse({
            attempts,
            maxAttempts: challenge.maxAttempts,
            locked,
          })
          await Promise.all([
            transaction.authAbuseEvent.create({
              data: {
                tenantId,
                action: 'OTP_VERIFY_FAILURE',
                mobileDigest: challenge.mobileDigest,
                sourceIpDigest,
                occurredAt: now,
                expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
              },
            }),
            transaction.auditEvent.create({
              data: {
                tenantId,
                actorType: 'SYSTEM',
                action: locked ? 'auth.otp.verification_locked' : 'auth.otp.verification_failed',
                entityType: 'auth_otp_challenge',
                entityId: challenge.id,
                summary: locked
                  ? 'OTP challenge locked after failed verification'
                  : 'OTP verification failed',
                correlationId,
                metadata: payload,
                occurredAt: now,
              },
            }),
            transaction.domainEventOutbox.create({
              data: {
                tenantId,
                eventId: randomUUID(),
                name: locked ? 'auth.otp.verification_locked' : 'auth.otp.verification_failed',
                aggregateType: 'auth_otp_challenge',
                aggregateId: challenge.id,
                actorType: 'SYSTEM',
                correlationId,
                consentBasis: 'TRANSACTIONAL',
                payload,
                occurredAt: now,
              },
            }),
          ])
        },
        'Serializable',
      )
    },

    async consumeChallengeAndCreateSession(input) {
      return tenantTransaction(
        prisma,
        input.tenantId,
        async (transaction) => {
          const existingAccount = await transaction.identityAccount.findUnique({
            where: { mobileE164: input.mobileE164 },
            select: { id: true, status: true, customerId: true },
          })
          if (existingAccount && existingAccount.status !== 'ACTIVE') return null

          const consumed = await transaction.authOtpChallenge.updateMany({
            where: {
              id: input.challengeId,
              mobileE164: input.mobileE164,
              status: { in: ['DELIVERED', 'DELIVERY_UNKNOWN'] },
              expiresAt: { gt: input.now },
              attempts: { lt: transaction.authOtpChallenge.fields.maxAttempts },
            },
            data: { status: 'CONSUMED', consumedAt: input.now, version: { increment: 1 } },
          })
          if (consumed.count !== 1) return null

          const customer = await transaction.customer.upsert({
            where: {
              tenantId_mobileE164: {
                tenantId: input.tenantId,
                mobileE164: input.mobileE164,
              },
            },
            update: { lifecycleStatus: 'ACTIVE' },
            create: {
              tenantId: input.tenantId,
              mobileE164: input.mobileE164,
              lifecycleStatus: 'ACTIVE',
            },
          })
          const account = existingAccount
            ? await transaction.identityAccount.update({
                where: { id: existingAccount.id },
                data: {
                  verifiedAt: input.now,
                  ...(!existingAccount.customerId && { customerId: customer.id }),
                },
              })
            : await transaction.identityAccount.create({
                data: {
                  mobileE164: input.mobileE164,
                  customerId: customer.id,
                  verifiedAt: input.now,
                },
              })
          if (account.status !== 'ACTIVE') return null
          await transaction.tenantMembership.upsert({
            where: {
              tenantId_accountId: { tenantId: input.tenantId, accountId: account.id },
            },
            update: {
              customerId: customer.id,
              status: 'ACTIVE',
              activeAt: input.now,
              suspendedAt: null,
              revokedAt: null,
            },
            create: {
              tenantId: input.tenantId,
              accountId: account.id,
              customerId: customer.id,
              status: 'ACTIVE',
              activeAt: input.now,
            },
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
              tenantId: input.tenantId,
              actorType: 'CUSTOMER',
              actorId: customer.id,
              action: 'auth.identity.verified',
              entityType: 'identity_account',
              entityId: account.id,
              summary: 'Customer identity verified',
              correlationId: input.correlationId,
              occurredAt: input.now,
            },
          })
          await transaction.domainEventOutbox.create({
            data: {
              tenantId: input.tenantId,
              eventId: randomUUID(),
              name: 'auth.otp.verified',
              aggregateType: 'auth_otp_challenge',
              aggregateId: input.challengeId,
              actorType: 'CUSTOMER',
              actorId: customer.id,
              correlationId: input.correlationId,
              consentBasis: 'TRANSACTIONAL',
              payload: { accountId: account.id, customerId: customer.id },
              occurredAt: input.now,
            },
          })
          const session = await transaction.authSession.create({
            data: {
              accountId: account.id,
              activeTenantId: input.tenantId,
              tokenDigest: input.tokenDigest,
              expiresAt: input.expiresAt,
              lastSeenAt: input.now,
            },
            select: { id: true },
          })
          await transaction.auditEvent.create({
            data: {
              tenantId: input.tenantId,
              actorType: 'CUSTOMER',
              actorId: customer.id,
              action: 'auth.session.created',
              entityType: 'auth_session',
              entityId: session.id,
              summary: 'Authenticated session created',
              correlationId: input.correlationId,
              occurredAt: input.now,
            },
          })
          await options.beforeVerificationCommit?.(transaction)
          return loadSessionContext(
            transaction,
            input.tokenDigest,
            input.tenantId,
            input.now,
            input.expiresAt,
          )
        },
        'Serializable',
      )
    },

    async findSession(tokenDigest, tenantId, now) {
      return tenantTransaction(prisma, tenantId, (transaction) =>
        loadSessionContext(transaction, tokenDigest, tenantId, now),
      )
    },

    async revokeSession(tokenDigest, tenantId, now, correlationId) {
      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const session = await transaction.authSession.findFirst({
          where: { tokenDigest, activeTenantId: tenantId },
          select: {
            id: true,
            revokedAt: true,
            account: {
              select: {
                tenantMemberships: {
                  where: { tenantId, status: 'ACTIVE', revokedAt: null },
                  select: { customerId: true },
                  take: 1,
                },
              },
            },
          },
        })
        if (!session || session.revokedAt) return false
        const revoked = await transaction.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        })
        if (revoked.count !== 1) return false
        await transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'CUSTOMER',
            actorId: session.account.tenantMemberships[0]?.customerId ?? null,
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
  const maxAttempts = isolationLevel === 'Serializable' ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          return operation(transaction)
        },
        isolationLevel ? { isolationLevel } : undefined,
      )
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableAuthenticationConflict(error, new Set())) {
        throw error
      }
    }
  }
  throw new Error('Authentication persistence retries exhausted')
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
          tenantMemberships: {
            where: { tenantId, status: 'ACTIVE', revokedAt: null },
            select: { customerId: true },
            take: 1,
          },
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
    customerId: session.account.tenantMemberships[0]?.customerId ?? null,
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
    .findSession(
      authenticationSessionDigest(dependencies.sessionPepper, token),
      tenantId,
      currentTime(dependencies),
    )
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}
