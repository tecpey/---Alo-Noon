import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import { authenticationDeliveryEventPayloadSchema } from '@alo-noon/contracts'
import {
  assertAuthenticationDeliveryTransition,
  createAuthenticationDeliveryPolicy,
  generateSecureOtp,
  normalizeAuthenticationDeliveryResult,
  selectAuthenticationProvider,
  type AuthenticationCredentialResolver,
  type AuthenticationDeliveryPolicy,
  type AuthenticationDeliveryProvider,
  type AuthenticationDeliveryRegistry,
  type AuthenticationDeliveryResult,
  type AuthenticationProviderConfigurationView,
  type SafeAuthenticationDeliveryResult,
} from '@alo-noon/domain'

const preparedInclude = {
  challenge: true,
  providerConfiguration: true,
} satisfies Prisma.AuthOtpDeliveryAttemptInclude
type PreparedAttempt = Prisma.AuthOtpDeliveryAttemptGetPayload<{ include: typeof preparedInclude }>

export interface AuthenticationDeliveryCommand {
  tenantId: string
  mobileE164: string
  idempotencyKey: string
  sourceIp: string
  now: Date
  correlationId: string
}

export interface AuthenticationDeliveryAccepted {
  challengeId: string
  expiresAt: Date
  retryAfterSeconds: number
  replayed: boolean
  uncertain: boolean
}

export interface AuthenticationDeliveryService {
  request(command: AuthenticationDeliveryCommand): Promise<AuthenticationDeliveryAccepted>
}

export interface PrismaAuthenticationDeliveryOptions {
  registry: AuthenticationDeliveryRegistry
  credentialResolver: AuthenticationCredentialResolver
  policy: AuthenticationDeliveryPolicy
  otpPepper: string
  abusePepper: string
  generateOtp?: () => string
  observer?: AuthenticationDeliveryObserver
  beforePreparationCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
  afterPreparationCommit?: (attemptId: string) => Promise<void>
  beforeFinalizationCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
}

export interface AuthenticationDeliveryObserver {
  record(event: {
    name: 'auth_delivery_suppressed' | 'auth_delivery_completed'
    providerCode: string | null
    outcome: 'SUPPRESSED' | SafeAuthenticationDeliveryResult['outcome']
    durationMs: number | null
  }): void | Promise<void>
}

export class AuthenticationDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 409 | 503,
  ) {
    super(code)
    this.name = 'AuthenticationDeliveryError'
  }
}

type Preparation =
  | { kind: 'SUPPRESSED'; result: AuthenticationDeliveryAccepted }
  | { kind: 'REPLAY'; attempt: PreparedAttempt; result: AuthenticationDeliveryAccepted }
  | {
      kind: 'PREPARED'
      attempt: PreparedAttempt
      adapter: AuthenticationDeliveryProvider
      otp: string
      fingerprint: string
    }

export function createPrismaAuthenticationDeliveryService(
  prisma: PrismaClient,
  input: PrismaAuthenticationDeliveryOptions,
): AuthenticationDeliveryService {
  const options: PrismaAuthenticationDeliveryOptions = {
    ...input,
    policy: createAuthenticationDeliveryPolicy(input.policy),
  }
  if (options.policy.environment === 'PRODUCTION' && options.credentialResolver.testOnly === true) {
    throw new AuthenticationDeliveryError('AUTH_DELIVERY_CREDENTIAL_UNAVAILABLE', 503)
  }

  return {
    async request(command) {
      if (!command.sourceIp.trim()) {
        throw new AuthenticationDeliveryError('AUTH_SOURCE_IP_UNAVAILABLE', 503)
      }
      const preparation = await prepareDelivery(prisma, options, command)
      if (preparation.kind === 'SUPPRESSED' || preparation.kind === 'REPLAY') {
        if (preparation.kind === 'SUPPRESSED') {
          await observe(options, {
            name: 'auth_delivery_suppressed',
            providerCode: null,
            outcome: 'SUPPRESSED',
            durationMs: null,
          })
        }
        return preparation.result
      }

      await options.afterPreparationCommit?.(preparation.attempt.id)
      const invocationStartedAt = Date.now()
      const normalized = await invokeDelivery(options, preparation, command)
      await observe(options, {
        name: 'auth_delivery_completed',
        providerCode: preparation.attempt.providerConfiguration.providerCode,
        outcome: normalized.outcome,
        durationMs: Math.max(0, Date.now() - invocationStartedAt),
      })
      return finalizeDelivery(prisma, options, command, preparation, normalized)
    },
  }
}

async function prepareDelivery(
  prisma: PrismaClient,
  options: PrismaAuthenticationDeliveryOptions,
  command: AuthenticationDeliveryCommand,
): Promise<Preparation> {
  const mobileDigest = hmac(options.abusePepper, `mobile:${command.mobileE164}`)
  const sourceIpDigest = hmac(options.abusePepper, `ip:${command.sourceIp}`)
  const fingerprint = hmac(
    options.abusePepper,
    `auth-delivery:v1:${command.tenantId}:${mobileDigest}`,
  )
  const candidateChallengeId = randomUUID()
  const candidateAttemptId = randomUUID()
  const otp = options.generateOtp?.() ?? generateSecureOtp(randomInt)
  if (!/^\d{6}$/.test(otp)) {
    throw new AuthenticationDeliveryError('AUTH_DELIVERY_POLICY_INVALID', 503)
  }
  const expiresAt = new Date(command.now.getTime() + options.policy.otpTtlMs)
  const resendAvailableAt = new Date(command.now.getTime() + options.policy.resendCooldownMs)

  return serializableWithRetry(
    prisma,
    command.tenantId,
    options.policy.maxPersistenceAttempts,
    new Set(['auth_challenge_idempotency_key', 'auth_challenge_one_active_mobile_key']),
    async (transaction) => {
      const replay = await transaction.authOtpChallenge.findFirst({
        where: { tenantId: command.tenantId, requestIdempotencyKey: command.idempotencyKey },
        include: { deliveryAttempt: { include: { providerConfiguration: true, challenge: true } } },
      })
      if (replay) {
        if (replay.requestFingerprint !== fingerprint || replay.mobileDigest !== mobileDigest) {
          throw new AuthenticationDeliveryError('IDEMPOTENCY_KEY_CONFLICT', 409)
        }
        let attempt = replay.deliveryAttempt
        if (!attempt) throw new AuthenticationDeliveryError('AUTH_DELIVERY_STATE_INCOMPLETE', 503)
        if (
          attempt.state === 'INITIALIZED' &&
          attempt.startedAt.getTime() + options.policy.invocationTimeoutMs * 2 <=
            command.now.getTime()
        ) {
          assertAuthenticationDeliveryTransition('INITIALIZED', 'UNKNOWN')
          attempt = await transaction.authOtpDeliveryAttempt.update({
            where: { id: attempt.id },
            data: {
              state: 'UNKNOWN',
              safeFailureCode: 'RECOVERY_OUTCOME_UNKNOWN',
              finalizedAt: command.now,
              version: { increment: 1 },
            },
            include: preparedInclude,
          })
          await transaction.authOtpChallenge.update({
            where: { id: replay.id },
            data: { status: 'DELIVERY_UNKNOWN', version: { increment: 1 } },
          })
          const nextFailures = attempt.providerConfiguration.consecutiveFailures + 1
          await transaction.authDeliveryProviderConfiguration.update({
            where: { id: attempt.providerConfigurationId },
            data: {
              consecutiveFailures: nextFailures,
              healthStatus: 'DEGRADED',
              circuitOpenedUntil:
                nextFailures >= options.policy.circuitFailureThreshold
                  ? new Date(command.now.getTime() + options.policy.circuitOpenMs)
                  : null,
            },
          })
          await writeDeliveryRecords(
            transaction,
            attempt,
            'auth.otp.delivery_unknown',
            'UNKNOWN',
            'RECOVERY_OUTCOME_UNKNOWN',
            command.now,
          )
        }
        return {
          kind: 'REPLAY',
          attempt,
          result: {
            challengeId: replay.id,
            expiresAt: replay.expiresAt,
            retryAfterSeconds: secondsUntil(replay.resendAvailableAt, command.now),
            replayed: true,
            uncertain:
              attempt.state === 'INITIALIZED' ||
              attempt.state === 'UNKNOWN' ||
              replay.status === 'DELIVERY_UNKNOWN',
          },
        }
      }

      const configurations = await transaction.authDeliveryProviderConfiguration.findMany({
        where: {
          tenantId: command.tenantId,
          environment: options.policy.environment,
          enabled: true,
          isDefault: true,
        },
      })
      let selected: (typeof configurations)[number]
      let adapter: AuthenticationDeliveryProvider
      try {
        selected = selectAuthenticationProvider(
          configurations.map((configuration) => ({
            id: configuration.id,
            tenantId: configuration.tenantId,
            providerCode: configuration.providerCode,
            adapterVersion: configuration.adapterVersion,
            adapterSpiVersion: configuration.adapterSpiVersion,
            environment: configuration.environment,
            enabled: configuration.enabled,
            isDefault: configuration.isDefault,
            priority: configuration.priority,
            healthStatus: configuration.healthStatus,
            circuitOpenedUntil: configuration.circuitOpenedUntil,
          })),
          command.tenantId,
          options.policy.environment,
          command.now,
        ) as (typeof configurations)[number]
        adapter = options.registry.resolve({
          providerCode: selected.providerCode,
          adapterVersion: selected.adapterVersion,
          adapterSpiVersion: selected.adapterSpiVersion,
          environment: options.policy.environment,
        })
      } catch {
        throw new AuthenticationDeliveryError('AUTH_DELIVERY_PROVIDER_UNAVAILABLE', 503)
      }

      const active = await transaction.authOtpChallenge.findFirst({
        where: {
          tenantId: command.tenantId,
          mobileDigest,
          status: { in: ['PREPARED', 'DELIVERED', 'DELIVERY_UNKNOWN'] },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (active) {
        if (active.expiresAt <= command.now) {
          await transaction.authOtpChallenge.update({
            where: { id: active.id },
            data: {
              status: 'EXPIRED',
              invalidatedAt: command.now,
              version: { increment: 1 },
            },
          })
        } else if (
          active.status === 'DELIVERY_UNKNOWN' ||
          active.status === 'PREPARED' ||
          active.resendAvailableAt > command.now
        ) {
          return {
            kind: 'SUPPRESSED',
            result: genericAccepted(command.now, options.policy, true),
          }
        } else {
          await transaction.authOtpChallenge.update({
            where: { id: active.id },
            data: {
              status: 'INVALIDATED',
              invalidatedAt: command.now,
              supersededAt: command.now,
              version: { increment: 1 },
            },
          })
        }
      }

      const [phoneCount, ipCount, tenantCount, providerCount] = await Promise.all([
        transaction.authAbuseEvent.count({
          where: {
            tenantId: command.tenantId,
            action: 'OTP_REQUEST',
            mobileDigest,
            occurredAt: { gte: new Date(command.now.getTime() - 60 * 60_000) },
          },
        }),
        transaction.authAbuseEvent.count({
          where: {
            tenantId: command.tenantId,
            action: 'OTP_REQUEST',
            sourceIpDigest,
            occurredAt: { gte: new Date(command.now.getTime() - 10 * 60_000) },
          },
        }),
        transaction.authAbuseEvent.count({
          where: {
            tenantId: command.tenantId,
            action: 'OTP_REQUEST',
            occurredAt: { gte: new Date(command.now.getTime() - 60 * 60_000) },
          },
        }),
        transaction.authAbuseEvent.count({
          where: {
            tenantId: command.tenantId,
            action: 'OTP_REQUEST',
            providerConfigurationId: selected.id,
            occurredAt: { gte: new Date(command.now.getTime() - 60_000) },
          },
        }),
      ])
      if (
        phoneCount >= options.policy.maxPhoneSendsPerHour ||
        ipCount >= options.policy.maxIpSendsPerTenMinutes ||
        tenantCount >= options.policy.maxTenantSendsPerHour ||
        providerCount >= options.policy.maxProviderSendsPerMinute
      ) {
        return {
          kind: 'SUPPRESSED',
          result: genericAccepted(command.now, options.policy, true),
        }
      }

      const challenge = await transaction.authOtpChallenge.create({
        data: {
          id: candidateChallengeId,
          tenantId: command.tenantId,
          mobileE164: command.mobileE164,
          mobileDigest,
          codeDigest: hmac(options.otpPepper, `${candidateChallengeId}.${otp}`),
          requestIdempotencyKey: command.idempotencyKey,
          requestFingerprint: fingerprint,
          sourceIpDigest,
          expiresAt,
          resendAvailableAt,
          maxAttempts: options.policy.maxVerificationAttempts,
          correlationId: command.correlationId,
        },
      })
      const attempt = await transaction.authOtpDeliveryAttempt.create({
        data: {
          id: candidateAttemptId,
          tenantId: command.tenantId,
          challengeId: challenge.id,
          providerConfigurationId: selected.id,
          requestFingerprint: fingerprint,
          correlationId: command.correlationId,
          startedAt: command.now,
        },
        include: preparedInclude,
      })
      await transaction.authAbuseEvent.create({
        data: {
          tenantId: command.tenantId,
          action: 'OTP_REQUEST',
          mobileDigest,
          sourceIpDigest,
          providerConfigurationId: selected.id,
          occurredAt: command.now,
          expiresAt: new Date(command.now.getTime() + 24 * 60 * 60_000),
        },
      })
      await writeDeliveryRecords(
        transaction,
        attempt,
        'auth.otp.delivery_requested',
        'INITIALIZED',
        null,
        command.now,
      )
      await options.beforePreparationCommit?.(transaction)
      return { kind: 'PREPARED', attempt, adapter, otp, fingerprint }
    },
  )
}

async function invokeDelivery(
  options: PrismaAuthenticationDeliveryOptions,
  preparation: Extract<Preparation, { kind: 'PREPARED' }>,
  command: AuthenticationDeliveryCommand,
): Promise<SafeAuthenticationDeliveryResult> {
  const configuration = configurationView(preparation.attempt.providerConfiguration)
  let credential: Awaited<ReturnType<AuthenticationCredentialResolver['resolve']>> | undefined
  try {
    credential = await options.credentialResolver.resolve(
      configuration.credentialReference,
      command.tenantId,
      configuration.providerCode,
    )
  } catch {
    return failure('PERMANENT_FAILURE', 'CREDENTIAL_UNAVAILABLE')
  }

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutResult = new Promise<AuthenticationDeliveryResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve({ outcome: 'UNKNOWN', normalizedCode: 'PROVIDER_TIMEOUT_UNKNOWN' })
      }, options.policy.invocationTimeoutMs)
    })
    const result = await Promise.race([
      preparation.adapter.deliverOtp({
        challengeId: preparation.attempt.challengeId,
        deliveryAttemptId: preparation.attempt.id,
        mobileE164: preparation.attempt.challenge.mobileE164,
        otp: preparation.otp,
        expiresAt: preparation.attempt.challenge.expiresAt,
        idempotencyKey: preparation.attempt.id,
        requestFingerprint: preparation.fingerprint,
        timeoutMs: options.policy.invocationTimeoutMs,
        signal: controller.signal,
        configuration,
        credential,
      }),
      timeoutResult,
    ])
    return normalizeAuthenticationDeliveryResult(result)
  } catch {
    return failure('UNKNOWN', 'PROVIDER_OUTCOME_UNKNOWN')
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
    credential.dispose()
  }
}

async function finalizeDelivery(
  prisma: PrismaClient,
  options: PrismaAuthenticationDeliveryOptions,
  command: AuthenticationDeliveryCommand,
  preparation: Extract<Preparation, { kind: 'PREPARED' }>,
  result: SafeAuthenticationDeliveryResult,
): Promise<AuthenticationDeliveryAccepted> {
  const finalized = await serializableWithRetry(
    prisma,
    command.tenantId,
    options.policy.maxPersistenceAttempts,
    new Set(),
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id" FROM "AuthOtpDeliveryAttempt"
        WHERE "id" = ${preparation.attempt.id}::uuid AND "tenantId" = ${command.tenantId}::uuid
        FOR UPDATE
      `
      const current = await transaction.authOtpDeliveryAttempt.findFirst({
        where: { id: preparation.attempt.id, tenantId: command.tenantId },
        include: preparedInclude,
      })
      if (!current || current.requestFingerprint !== preparation.fingerprint) {
        throw new AuthenticationDeliveryError('AUTH_DELIVERY_STATE_INCOMPLETE', 503)
      }
      if (current.state !== 'INITIALIZED') {
        return { result: mapPersistedAttempt(current, command.now, true), failed: false }
      }

      assertAuthenticationDeliveryTransition('INITIALIZED', result.outcome)
      const challengeState =
        result.outcome === 'DELIVERED'
          ? 'DELIVERED'
          : result.outcome === 'UNKNOWN'
            ? 'DELIVERY_UNKNOWN'
            : 'FAILED'
      const attempt = await transaction.authOtpDeliveryAttempt.update({
        where: { id: current.id },
        data: {
          state: result.outcome,
          providerReference: result.providerReference,
          safeFailureCode:
            result.outcome === 'DELIVERED' ? null : (result.normalizedCode ?? 'PROVIDER_FAILURE'),
          finalizedAt: command.now,
          version: { increment: 1 },
        },
        include: preparedInclude,
      })
      await transaction.authOtpChallenge.update({
        where: { id: current.challengeId },
        data: {
          status: challengeState,
          ...(challengeState === 'FAILED' && { invalidatedAt: command.now }),
          version: { increment: 1 },
        },
      })

      const nextFailures =
        result.outcome === 'DELIVERED' ? 0 : current.providerConfiguration.consecutiveFailures + 1
      await transaction.authDeliveryProviderConfiguration.update({
        where: { id: current.providerConfigurationId },
        data: {
          consecutiveFailures: nextFailures,
          healthStatus: result.outcome === 'DELIVERED' ? 'HEALTHY' : 'DEGRADED',
          circuitOpenedUntil:
            result.outcome !== 'DELIVERED' && nextFailures >= options.policy.circuitFailureThreshold
              ? new Date(command.now.getTime() + options.policy.circuitOpenMs)
              : null,
        },
      })
      const action =
        result.outcome === 'DELIVERED'
          ? 'auth.otp.delivery_succeeded'
          : result.outcome === 'UNKNOWN'
            ? 'auth.otp.delivery_unknown'
            : 'auth.otp.delivery_failed'
      await writeDeliveryRecords(
        transaction,
        attempt,
        action,
        result.outcome,
        result.normalizedCode,
        command.now,
      )
      await options.beforeFinalizationCommit?.(transaction)
      return {
        result: mapPersistedAttempt(attempt, command.now, false),
        failed: challengeState === 'FAILED',
      }
    },
  )
  if (finalized.failed) {
    throw new AuthenticationDeliveryError('AUTH_DELIVERY_PROVIDER_UNAVAILABLE', 503)
  }
  return finalized.result
}

function mapPersistedAttempt(
  attempt: PreparedAttempt,
  now: Date,
  replayed: boolean,
): AuthenticationDeliveryAccepted {
  return {
    challengeId: attempt.challenge.id,
    expiresAt: attempt.challenge.expiresAt,
    retryAfterSeconds: secondsUntil(attempt.challenge.resendAvailableAt, now),
    replayed,
    uncertain: attempt.state === 'INITIALIZED' || attempt.state === 'UNKNOWN',
  }
}

async function writeDeliveryRecords(
  transaction: Prisma.TransactionClient,
  attempt: PreparedAttempt,
  action: string,
  state: string,
  safeFailureCode: string | null,
  occurredAt: Date,
): Promise<void> {
  const payload = authenticationDeliveryEventPayloadSchema.parse({
    challengeId: attempt.challengeId,
    deliveryAttemptId: attempt.id,
    providerConfigurationId: attempt.providerConfigurationId,
    providerCode: attempt.providerConfiguration.providerCode,
    adapterVersion: attempt.providerConfiguration.adapterVersion,
    adapterSpiVersion: attempt.providerConfiguration.adapterSpiVersion,
    state,
    safeFailureCode,
    version: attempt.version,
  })
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId: attempt.tenantId,
        actorType: 'SYSTEM',
        action,
        entityType: 'auth_otp_delivery_attempt',
        entityId: attempt.id,
        summary: deliverySummary(action),
        correlationId: attempt.correlationId,
        metadata: payload,
        occurredAt,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId: attempt.tenantId,
        eventId: randomUUID(),
        name: action,
        aggregateType: 'auth_otp_delivery_attempt',
        aggregateId: attempt.id,
        actorType: 'SYSTEM',
        correlationId: attempt.correlationId,
        consentBasis: 'TRANSACTIONAL',
        payload,
        occurredAt,
      },
    }),
  ])
}

export function createEnvironmentAuthenticationCredentialResolver(
  environment: Readonly<Record<string, string | undefined>>,
): AuthenticationCredentialResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const match = /^env:\/(?:\/)?(AUTH_SMS_[A-Z0-9_]{1,120})$/.exec(reference)
      const value = match ? environment[match[1]!] : undefined
      if (!value || value.length < 16) {
        throw new AuthenticationDeliveryError('AUTH_DELIVERY_CREDENTIAL_UNAVAILABLE', 503)
      }
      const material = Buffer.from(value, 'utf8')
      return {
        material,
        dispose: () => material.fill(0),
      }
    },
  })
}

export function authenticationFingerprint(pepper: string, value: string): string {
  return hmac(pepper, value)
}

function configurationView(
  configuration: PreparedAttempt['providerConfiguration'],
): AuthenticationProviderConfigurationView {
  if (configuration.adapterSpiVersion !== 1) {
    throw new AuthenticationDeliveryError('AUTH_DELIVERY_PROVIDER_UNAVAILABLE', 503)
  }
  return {
    id: configuration.id,
    tenantId: configuration.tenantId,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: 1,
    environment: configuration.environment,
    credentialReference: configuration.credentialReference,
    senderReference: configuration.senderReference,
    templateReference: configuration.templateReference,
  }
}

function genericAccepted(
  now: Date,
  policy: AuthenticationDeliveryPolicy,
  uncertain: boolean,
): AuthenticationDeliveryAccepted {
  return {
    challengeId: randomUUID(),
    expiresAt: new Date(now.getTime() + policy.otpTtlMs),
    retryAfterSeconds: Math.ceil(policy.resendCooldownMs / 1000),
    replayed: false,
    uncertain,
  }
}

function failure(
  outcome: 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE' | 'UNKNOWN',
  code: string,
): SafeAuthenticationDeliveryResult {
  return {
    outcome,
    providerReference: null,
    normalizedCode: code,
    retryable: outcome === 'TRANSIENT_FAILURE',
  }
}

function hmac(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex')
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 1000))
}

function deliverySummary(action: string): string {
  if (action === 'auth.otp.delivery_requested') return 'OTP delivery requested'
  if (action === 'auth.otp.delivery_succeeded') return 'OTP delivery succeeded'
  if (action === 'auth.otp.delivery_unknown') return 'OTP delivery outcome is unknown'
  return 'OTP delivery failed'
}

async function observe(
  options: PrismaAuthenticationDeliveryOptions,
  event: Parameters<NonNullable<PrismaAuthenticationDeliveryOptions['observer']>['record']>[0],
): Promise<void> {
  try {
    await options.observer?.record(event)
  } catch {
    // Telemetry is deliberately non-authoritative and must not mutate delivery behavior.
  }
}

async function serializableWithRetry<T>(
  prisma: PrismaClient,
  tenantId: string,
  maxAttempts: number,
  retryUniqueConstraints: ReadonlySet<string>,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          return operation(transaction)
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      const retryable = isRetryableAuthenticationConflict(error, retryUniqueConstraints)
      if (!retryable || attempt === maxAttempts) {
        if (retryable) {
          throw new AuthenticationDeliveryError('AUTH_DELIVERY_CONCURRENCY_CONFLICT', 409)
        }
        throw error
      }
    }
  }
  throw new AuthenticationDeliveryError('AUTH_DELIVERY_CONCURRENCY_CONFLICT', 409)
}

export function isRetryableAuthenticationConflict(
  error: unknown,
  allowedUniqueConstraints: ReadonlySet<string> = new Set(),
): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  if (code === 'P2034' || code === '40001') return true
  const meta = Reflect.get(error, 'meta')
  if (
    code === 'P2010' &&
    meta &&
    typeof meta === 'object' &&
    Reflect.get(meta, 'code') === '40001'
  ) {
    return true
  }
  return code === 'P2002' && allowedUniqueConstraints.has(constraintIdentity(meta))
}

function constraintIdentity(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return ''
  const constraint = Reflect.get(meta, 'constraint')
  if (typeof constraint === 'string') return constraint
  const target = Reflect.get(meta, 'target')
  if (!Array.isArray(target)) return ''
  const fields = target.join(',')
  if (fields === 'tenantId,requestIdempotencyKey') return 'auth_challenge_idempotency_key'
  if (fields === 'tenantId,mobileDigest') return 'auth_challenge_one_active_mobile_key'
  return ''
}

export function authenticationRequestHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
