import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  paymentExecutionEventPayloadSchema,
  paymentExecutionInitializeSchema,
  paymentExecutionSummarySchema,
  type ErrorEnvelope,
  type PaymentExecutionInitialize,
  type PaymentExecutionSummary,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  canonicalProviderRequest,
  createProviderExecutionPolicy,
  initializationAttemptStates,
  normalizeInitializationResult,
  selectPaymentProvider,
  transitionPaymentAttempt,
  validateInitializationAdapter,
  type PaymentProviderAdapter,
  type PaymentProviderAdapterRegistry,
  type PaymentAttemptState,
  type ProviderConfigurationView,
  type ProviderExecutionPolicy,
  type ProviderInitializationOutcome,
  type ProviderSecretResolver,
  type SafeInitializationResult,
} from '@alo-noon/domain'

import type { AuthDependencies } from './auth.js'
import { authenticatedCustomer } from './commerce.js'

const attemptInclude = {
  payment: { include: { order: true } },
  providerConfiguration: { include: { credentialReference: true } },
} satisfies Prisma.PaymentAttemptInclude
type AttemptRecord = Prisma.PaymentAttemptGetPayload<{ include: typeof attemptInclude }>
type ConfigurationRecord = AttemptRecord['providerConfiguration']

export type PaymentExecutionActor =
  { type: 'CUSTOMER'; id: string } | { type: 'SYSTEM'; id: string }

export interface PaymentExecutionService {
  initialize(
    tenantId: string,
    actor: PaymentExecutionActor,
    command: PaymentExecutionInitialize,
    now: Date,
    correlationId: string,
  ): Promise<PaymentExecutionSummary>
}

export interface PaymentExecutionDependencies {
  service: PaymentExecutionService
  auth: AuthDependencies
  now?: () => Date
}

export interface PrismaPaymentExecutionOptions {
  adapterRegistry: PaymentProviderAdapterRegistry
  secretResolver: ProviderSecretResolver
  policy: ProviderExecutionPolicy
  allowSystemOperations?: boolean
  beforePreparationCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
  afterPreparationCommit?: (attemptId: string) => Promise<void>
  beforeResultCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
}

export class PaymentExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

interface PreparedExecution {
  attempt: AttemptRecord
  adapter: PaymentProviderAdapter | null
  fingerprint: string
  replayed: boolean
  completed: boolean
}

export function registerPaymentExecutionRoutes(
  app: FastifyInstance,
  dependencies: PaymentExecutionDependencies,
): void {
  app.post(
    '/api/v1/payments/initialize',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const customer = await authenticatedCustomer(request, dependencies.auth)
      if (!customer) {
        return reply
          .code(401)
          .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
      }
      const parsed = paymentExecutionInitializeSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PAYMENT_EXECUTION_REQUEST', 'Payment request is invalid.'))
      }

      try {
        const result = await dependencies.service.initialize(
          customer.tenantId,
          { type: 'CUSTOMER', id: customer.customerId },
          parsed.data,
          dependencies.now?.() ?? new Date(),
          randomUUID(),
        )
        return reply.code(result.replayed ? 200 : 201).send({
          success: true,
          data: result,
          meta: responseMeta(),
        })
      } catch (error) {
        return executionFailure(request, reply, error)
      }
    },
  )
}

export function createPrismaPaymentExecutionService(
  prisma: PrismaClient,
  options: PrismaPaymentExecutionOptions,
): PaymentExecutionService {
  const runtimeOptions: PrismaPaymentExecutionOptions = {
    ...options,
    policy: createProviderExecutionPolicy({
      environment: options.policy.environment,
      maxPersistenceAttempts: options.policy.maxPersistenceAttempts,
      invocationTimeoutMs: options.policy.invocationTimeoutMs,
    }),
  }
  if (
    runtimeOptions.policy.environment === 'PRODUCTION' &&
    runtimeOptions.secretResolver.testOnly === true
  ) {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE', 503)
  }

  return {
    async initialize(tenantId, actor, command, now, correlationId) {
      authorizeActor(actor, runtimeOptions)
      const prepared = await prepareExecution(
        prisma,
        runtimeOptions,
        tenantId,
        actor,
        command,
        now,
        correlationId,
      )
      if (prepared.completed) return mapExecution(prepared.attempt, true)

      await runtimeOptions.afterPreparationCommit?.(prepared.attempt.id)
      const normalized = await invokeProvider(runtimeOptions, prepared, tenantId, now)
      return persistExecutionResult(
        prisma,
        runtimeOptions,
        tenantId,
        actor,
        command,
        prepared,
        normalized,
        now,
      )
    },
  }
}

export function createEnvironmentPaymentCredentialResolver(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderSecretResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const match = /^env:\/(?:\/)?(PAYMENT_PROVIDER_[A-Z0-9_]{1,120})$/.exec(reference)
      const value = match ? environment[match[1]!] : undefined
      if (!value || value.length < 16) {
        throw new PaymentExecutionError('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE', 503)
      }
      const material = Buffer.from(value, 'utf8')
      return {
        material,
        dispose: () => material.fill(0),
      }
    },
  })
}

async function prepareExecution(
  prisma: PrismaClient,
  options: PrismaPaymentExecutionOptions,
  tenantId: string,
  actor: PaymentExecutionActor,
  command: PaymentExecutionInitialize,
  now: Date,
  correlationId: string,
): Promise<PreparedExecution> {
  const scopedRequestKey = paymentExecutionRequestKey(actor, command.idempotencyKey)
  return serializableWithRetry(
    prisma,
    tenantId,
    options.policy.maxPersistenceAttempts,
    true,
    async (transaction) => {
      const replay = await transaction.paymentAttempt.findFirst({
        where: { tenantId, requestIdempotencyKey: scopedRequestKey },
        include: attemptInclude,
      })
      if (replay) return replayExecution(options, tenantId, actor, command, replay)

      await transaction.$queryRaw`
        SELECT "id" FROM "Payment"
        WHERE "id" = ${command.paymentId}::uuid AND "tenantId" = ${tenantId}::uuid
        FOR UPDATE
      `
      const payment = await transaction.payment.findFirst({
        where: { id: command.paymentId, tenantId },
        include: { order: true },
      })
      if (!payment || !ownsPayment(payment.customerId, actor)) {
        throw new PaymentExecutionError('PAYMENT_NOT_FOUND', 404)
      }
      assertPaymentEligible(payment)

      const configurations = await transaction.paymentProviderConfiguration.findMany({
        where: {
          tenantId,
          environment: options.policy.environment,
          paymentContext: options.policy.paymentContext,
          currency: payment.currency,
          isActive: true,
          isDefault: true,
        },
        include: { credentialReference: true },
      })
      let selected: ReturnType<typeof selectPaymentProvider>
      try {
        selected = selectPaymentProvider(
          configurations.map((configuration) => ({
            ...configuration,
            capabilities: configuration.capabilities,
          })),
          {
            tenantId,
            environment: options.policy.environment,
            paymentContext: options.policy.paymentContext,
            currency: options.policy.currency,
            capability: options.policy.capability,
          },
        )
      } catch (error) {
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
        if (code === 'PAYMENT_PROVIDER_MISSING' || code === 'PAYMENT_PROVIDER_AMBIGUOUS') {
          throw new PaymentExecutionError(String(code), 503)
        }
        throw error
      }
      const configuration = configurations.find((candidate) => candidate.id === selected.id)
      if (!configuration) throw new PaymentExecutionError('PAYMENT_PROVIDER_MISSING', 503)
      const adapter = resolveAdapter(options, configuration)
      const fingerprint = executionFingerprint(
        tenantId,
        actor,
        payment,
        configuration,
        options.policy,
      )

      const createdTransitionId = randomUUID()
      const pendingTransitionId = randomUUID()
      const attempt = await transaction.paymentAttempt.create({
        data: {
          tenantId,
          paymentId: payment.id,
          providerConfigurationId: configuration.id,
          state: 'INITIALIZATION_PENDING',
          version: 2,
          requestIdempotencyKey: scopedRequestKey,
          requestFingerprint: fingerprint,
          correlationId,
          createdAt: now,
          updatedAt: now,
          transitions: {
            create: [
              {
                id: createdTransitionId,
                tenantId,
                fromState: null,
                toState: 'CREATED',
                version: 1,
                idempotencyKey: transitionIdempotencyKey(scopedRequestKey, 'created'),
                correlationId,
                occurredAt: now,
              },
              {
                id: pendingTransitionId,
                tenantId,
                fromState: 'CREATED',
                toState: 'INITIALIZATION_PENDING',
                version: 2,
                providerOutcome: 'PENDING',
                idempotencyKey: transitionIdempotencyKey(scopedRequestKey, 'pending'),
                correlationId,
                occurredAt: now,
              },
            ],
          },
        },
        include: attemptInclude,
      })
      await writeExecutionRecords(
        transaction,
        attempt,
        createdTransitionId,
        actor,
        'payment.execution_requested',
        'CREATED',
        1,
        null,
        null,
        now,
      )
      await writeExecutionRecords(
        transaction,
        attempt,
        pendingTransitionId,
        actor,
        'payment.attempt_initialization_started',
        'INITIALIZATION_PENDING',
        2,
        null,
        null,
        now,
      )
      await options.beforePreparationCommit?.(transaction)
      return { attempt, adapter, fingerprint, replayed: false, completed: false }
    },
  )
}

function replayExecution(
  options: PrismaPaymentExecutionOptions,
  tenantId: string,
  actor: PaymentExecutionActor,
  command: PaymentExecutionInitialize,
  attempt: AttemptRecord,
): PreparedExecution {
  if (!ownsPayment(attempt.payment.customerId, actor)) {
    throw new PaymentExecutionError('PAYMENT_NOT_FOUND', 404)
  }
  const expectedFingerprint = executionFingerprint(
    tenantId,
    actor,
    attempt.payment,
    attempt.providerConfiguration,
    options.policy,
  )
  if (
    attempt.paymentId !== command.paymentId ||
    attempt.requestFingerprint !== expectedFingerprint
  ) {
    throw new PaymentExecutionError('IDEMPOTENCY_KEY_CONFLICT', 409)
  }
  if (attempt.initializationOutcome) {
    assertPersistedResultComplete(attempt)
    return {
      attempt,
      adapter: null,
      fingerprint: expectedFingerprint,
      replayed: true,
      completed: true,
    }
  }
  if (attempt.state !== 'INITIALIZATION_PENDING' || attempt.version !== 2) {
    throw new PaymentExecutionError('PAYMENT_EXECUTION_RESULT_INCOMPLETE', 503)
  }
  assertPaymentEligible(attempt.payment)
  assertConfigurationEligible(attempt.providerConfiguration, options.policy)
  const adapter = resolveAdapter(options, attempt.providerConfiguration)
  return {
    attempt,
    adapter,
    fingerprint: expectedFingerprint,
    replayed: true,
    completed: false,
  }
}

async function invokeProvider(
  options: PrismaPaymentExecutionOptions,
  prepared: PreparedExecution,
  tenantId: string,
  now: Date,
): Promise<SafeInitializationResult> {
  if (!prepared.adapter) {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 503)
  }
  const configuration = providerConfigurationView(prepared.attempt.providerConfiguration)
  let credential: Awaited<ReturnType<ProviderSecretResolver['resolve']>> | undefined
  let result: SafeInitializationResult
  try {
    credential = await options.secretResolver.resolve(
      configuration.credentialReference,
      tenantId,
      configuration.providerCode,
    )
  } catch {
    return safeFailure('RETRYABLE_FAILURE', 'CREDENTIAL_RESOLUTION_FAILED')
  }

  try {
    const providerResult = await prepared.adapter.initializePayment!({
      paymentAttemptId: prepared.attempt.id,
      amount: prepared.attempt.payment.amount,
      currency: 'IRR',
      idempotencyKey: prepared.attempt.id,
      requestFingerprint: prepared.fingerprint,
      timeoutMs: options.policy.invocationTimeoutMs,
      configuration,
      credential,
    })
    try {
      result = normalizeInitializationResult(providerResult, now)
    } catch {
      result = safeFailure('UNKNOWN', 'PROVIDER_RESPONSE_INVALID')
    }
  } catch {
    result = safeFailure('RETRYABLE_FAILURE', 'PROVIDER_INVOCATION_FAILED')
  }

  let disposalFailed = false
  try {
    credential.material.fill(0)
  } catch {
    disposalFailed = true
  }
  try {
    credential.dispose()
  } catch {
    disposalFailed = true
  }
  return disposalFailed ? safeFailure('UNKNOWN', 'CREDENTIAL_DISPOSAL_FAILED') : result
}

async function persistExecutionResult(
  prisma: PrismaClient,
  options: PrismaPaymentExecutionOptions,
  tenantId: string,
  actor: PaymentExecutionActor,
  command: PaymentExecutionInitialize,
  prepared: PreparedExecution,
  result: SafeInitializationResult,
  now: Date,
): Promise<PaymentExecutionSummary> {
  return serializableWithRetry(
    prisma,
    tenantId,
    options.policy.maxPersistenceAttempts,
    false,
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id" FROM "PaymentAttempt"
        WHERE "id" = ${prepared.attempt.id}::uuid AND "tenantId" = ${tenantId}::uuid
        FOR UPDATE
      `
      const current = await loadAttempt(transaction, tenantId, prepared.attempt.id)
      if (!ownsPayment(current.payment.customerId, actor)) {
        throw new PaymentExecutionError('PAYMENT_NOT_FOUND', 404)
      }
      assertPaymentEligible(current.payment)
      if (
        current.requestIdempotencyKey !==
          paymentExecutionRequestKey(actor, command.idempotencyKey) ||
        current.requestFingerprint !== prepared.fingerprint
      ) {
        throw new PaymentExecutionError('IDEMPOTENCY_KEY_CONFLICT', 409)
      }
      if (current.initializationOutcome) {
        assertPersistedResultComplete(current)
        return mapExecution(current, true)
      }
      if (current.state !== 'INITIALIZATION_PENDING' || current.version !== 2) {
        throw new PaymentExecutionError('PAYMENT_EXECUTION_VERSION_CONFLICT', 409)
      }

      const states = initializationAttemptStates(result.outcome)
      let fromState: PaymentAttemptState = current.state
      let version = current.version
      const transitions: Array<{
        id: string
        state: 'INITIALIZED' | 'CUSTOMER_ACTION_REQUIRED' | 'FAILED'
        version: number
        action:
          | 'payment.attempt_initialized'
          | 'payment.customer_action_required'
          | 'payment.attempt_initialization_failed'
      }> = []
      for (const state of states) {
        transitionPaymentAttempt(fromState, state)
        version += 1
        const transitionId = randomUUID()
        await transaction.paymentAttemptStateTransition.create({
          data: {
            id: transitionId,
            tenantId,
            paymentAttemptId: current.id,
            fromState,
            toState: state,
            version,
            providerOutcome: legacyProviderOutcome(result.outcome, state),
            ...(state === 'INITIALIZED' && result.providerReference
              ? { providerReference: result.providerReference }
              : {}),
            idempotencyKey: transitionIdempotencyKey(
              current.requestIdempotencyKey,
              `result-${version}`,
            ),
            correlationId: current.correlationId,
            occurredAt: now,
          },
        })
        transitions.push({
          id: transitionId,
          state,
          version,
          action:
            state === 'INITIALIZED'
              ? 'payment.attempt_initialized'
              : state === 'CUSTOMER_ACTION_REQUIRED'
                ? 'payment.customer_action_required'
                : 'payment.attempt_initialization_failed',
        })
        fromState = state
      }

      const updated = await transaction.paymentAttempt.update({
        where: { id: current.id },
        data: {
          state: fromState,
          version,
          providerReference: result.providerReference,
          initializationOutcome: result.outcome,
          customerActionUrl: result.customerActionUrl,
          actionExpiresAt: result.actionExpiresAt,
          failureCode: result.failureCode,
          customerMessageKey: result.customerMessageKey,
          initializationCompletedAt: now,
          updatedAt: now,
        },
        include: attemptInclude,
      })
      for (const transition of transitions) {
        await writeExecutionRecords(
          transaction,
          updated,
          transition.id,
          actor,
          transition.action,
          transition.state,
          transition.version,
          result.outcome,
          result.failureCode,
          now,
        )
      }
      await options.beforeResultCommit?.(transaction)
      return mapExecution(updated, prepared.replayed)
    },
  )
}

async function writeExecutionRecords(
  transaction: Prisma.TransactionClient,
  attempt: AttemptRecord,
  eventId: string,
  actor: PaymentExecutionActor,
  action: string,
  state:
    'CREATED' | 'INITIALIZATION_PENDING' | 'INITIALIZED' | 'CUSTOMER_ACTION_REQUIRED' | 'FAILED',
  version: number,
  outcome: ProviderInitializationOutcome | null,
  safeFailureCode: string | null,
  occurredAt: Date,
): Promise<void> {
  const configuration = attempt.providerConfiguration
  const payload = paymentExecutionEventPayloadSchema.parse({
    paymentAttemptId: attempt.id,
    paymentId: attempt.paymentId,
    providerConfigurationId: configuration.id,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion,
    state,
    outcome,
    safeFailureCode,
    version,
  })
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId: attempt.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action,
        entityType: 'payment_attempt',
        entityId: attempt.id,
        summary: executionSummary(action),
        correlationId: attempt.correlationId,
        metadata: payload,
        occurredAt,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId: attempt.tenantId,
        eventId,
        name: action,
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        actorType: actor.type,
        actorId: actor.id,
        correlationId: attempt.correlationId,
        consentBasis: 'TRANSACTIONAL',
        payload,
        occurredAt,
      },
    }),
  ])
}

function resolveAdapter(
  options: PrismaPaymentExecutionOptions,
  configuration: ConfigurationRecord,
): PaymentProviderAdapter {
  if (configuration.adapterSpiVersion !== 1) {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 503)
  }
  try {
    const adapter = options.adapterRegistry.resolve({
      providerCode: configuration.providerCode,
      adapterVersion: configuration.adapterVersion,
      adapterSpiVersion: 1,
      environment: options.policy.environment,
      capability: options.policy.capability,
    })
    validateInitializationAdapter(adapter, options.policy.environment)
    return adapter
  } catch {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 503)
  }
}

function providerConfigurationView(configuration: ConfigurationRecord): ProviderConfigurationView {
  if (configuration.adapterSpiVersion !== 1) {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 503)
  }
  return {
    id: configuration.id,
    tenantId: configuration.tenantId,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: 1,
    environment: configuration.environment,
    merchantReference: configuration.merchantReference,
    callbackPolicy: 'SIGNED_ONLY',
    capabilities: configuration.capabilities,
    credentialReference: configuration.credentialReference.reference,
  }
}

function executionFingerprint(
  tenantId: string,
  actor: PaymentExecutionActor,
  payment: AttemptRecord['payment'],
  configuration: ConfigurationRecord,
  policy: ProviderExecutionPolicy,
): string {
  return createHash('sha256')
    .update(
      canonicalProviderRequest({
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        customerId: payment.customerId,
        paymentId: payment.id,
        orderId: payment.orderId,
        amount: payment.amount.toString(),
        currency: payment.currency,
        providerConfigurationId: configuration.id,
        providerCode: configuration.providerCode,
        adapterVersion: configuration.adapterVersion,
        adapterSpiVersion: configuration.adapterSpiVersion,
        environment: policy.environment,
        paymentContext: policy.paymentContext,
        capability: policy.capability,
      }),
    )
    .digest('hex')
}

function assertPaymentEligible(payment: AttemptRecord['payment']): void {
  if (
    payment.currency !== 'IRR' ||
    payment.amount <= 0n ||
    payment.amount !== payment.order.totalAmount ||
    payment.state === 'CAPTURED' ||
    payment.state === 'FAILED' ||
    payment.order.state !== 'PENDING_CONFIRMATION' ||
    payment.order.paymentState !== 'NOT_STARTED'
  ) {
    throw new PaymentExecutionError('PAYMENT_NOT_ELIGIBLE_FOR_EXECUTION', 422)
  }
}

function assertConfigurationEligible(
  configuration: ConfigurationRecord,
  policy: ProviderExecutionPolicy,
): void {
  if (
    !configuration.isActive ||
    !configuration.isDefault ||
    configuration.healthStatus !== 'HEALTHY' ||
    configuration.environment !== policy.environment ||
    configuration.paymentContext !== policy.paymentContext ||
    configuration.currency !== policy.currency ||
    !configuration.capabilities.includes(policy.capability)
  ) {
    throw new PaymentExecutionError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 503)
  }
}

function authorizeActor(
  actor: PaymentExecutionActor,
  options: PrismaPaymentExecutionOptions,
): void {
  if (actor.type === 'SYSTEM' && options.allowSystemOperations !== true) {
    throw new PaymentExecutionError('PAYMENT_EXECUTION_FORBIDDEN', 404)
  }
}

function ownsPayment(customerId: string, actor: PaymentExecutionActor): boolean {
  return actor.type === 'SYSTEM' || actor.id === customerId
}

function assertPersistedResultComplete(attempt: AttemptRecord): void {
  try {
    paymentExecutionSummarySchema.parse(mapExecution(attempt, true))
  } catch {
    throw new PaymentExecutionError('PAYMENT_EXECUTION_RESULT_INCOMPLETE', 503)
  }
}

function mapExecution(attempt: AttemptRecord, replayed: boolean): PaymentExecutionSummary {
  const failed =
    attempt.initializationOutcome &&
    ['REJECTED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'UNKNOWN'].includes(
      attempt.initializationOutcome,
    )
  return paymentExecutionSummarySchema.parse({
    paymentAttemptId: attempt.id,
    paymentId: attempt.paymentId,
    providerConfigurationId: attempt.providerConfigurationId,
    providerCode: attempt.providerConfiguration.providerCode,
    adapterVersion: attempt.providerConfiguration.adapterVersion,
    adapterSpiVersion: attempt.providerConfiguration.adapterSpiVersion,
    state: initializationResultState(attempt.initializationOutcome, attempt.state),
    outcome: attempt.initializationOutcome,
    providerReference: attempt.providerReference,
    customerAction: attempt.customerActionUrl
      ? {
          url: attempt.customerActionUrl,
          expiresAt: attempt.actionExpiresAt?.toISOString() ?? null,
        }
      : null,
    failure:
      failed && attempt.failureCode
        ? {
            code: attempt.failureCode,
            retryable: attempt.initializationOutcome === 'RETRYABLE_FAILURE',
            customerMessageKey: attempt.customerMessageKey,
          }
        : null,
    correlationId: attempt.correlationId,
    replayed,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  })
}

function initializationResultState(
  outcome: ProviderInitializationOutcome | null,
  currentState: AttemptRecord['state'],
): 'INITIALIZATION_PENDING' | 'INITIALIZED' | 'CUSTOMER_ACTION_REQUIRED' | 'FAILED' {
  if (!outcome && currentState === 'INITIALIZATION_PENDING') return currentState
  if (outcome === 'ACCEPTED') return 'INITIALIZED'
  if (outcome === 'CUSTOMER_ACTION_REQUIRED') return 'CUSTOMER_ACTION_REQUIRED'
  if (outcome) return 'FAILED'
  throw new PaymentExecutionError('PAYMENT_EXECUTION_RESULT_INCOMPLETE', 503)
}

function safeFailure(
  outcome: Extract<ProviderInitializationOutcome, 'RETRYABLE_FAILURE' | 'UNKNOWN'>,
  failureCode: string,
): SafeInitializationResult {
  return normalizeInitializationResult(
    {
      outcome,
      normalizedCode: failureCode,
      retryable: outcome === 'RETRYABLE_FAILURE',
      customerMessageKey: 'payment.initialization_unavailable',
    },
    new Date(0),
  )
}

function legacyProviderOutcome(
  outcome: ProviderInitializationOutcome,
  state: 'INITIALIZED' | 'CUSTOMER_ACTION_REQUIRED' | 'FAILED',
): 'PENDING' | 'CUSTOMER_ACTION_REQUIRED' | 'REJECTED' | 'FAILED' {
  if (state === 'INITIALIZED') return 'PENDING'
  if (state === 'CUSTOMER_ACTION_REQUIRED') return 'CUSTOMER_ACTION_REQUIRED'
  return outcome === 'REJECTED' ? 'REJECTED' : 'FAILED'
}

function transitionIdempotencyKey(base: string, suffix: string): string {
  return createHash('sha256').update(`${base}:${suffix}`).digest('hex')
}

export function paymentExecutionRequestKey(
  actor: PaymentExecutionActor,
  idempotencyKey: string,
): string {
  return createHash('sha256').update(`${actor.type}:${actor.id}:${idempotencyKey}`).digest('hex')
}

function executionSummary(action: string): string {
  const summaries: Record<string, string> = {
    'payment.execution_requested': 'Payment initialization execution requested',
    'payment.attempt_initialization_started': 'Provider initialization attempt started',
    'payment.attempt_initialized': 'Provider initialization accepted',
    'payment.customer_action_required': 'Provider requires customer action',
    'payment.attempt_initialization_failed': 'Provider initialization failed safely',
  }
  return summaries[action] ?? 'Payment execution state changed'
}

async function loadAttempt(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  attemptId: string,
): Promise<AttemptRecord> {
  const attempt = await transaction.paymentAttempt.findFirst({
    where: { id: attemptId, tenantId },
    include: attemptInclude,
  })
  if (!attempt) throw new PaymentExecutionError('PAYMENT_NOT_FOUND', 404)
  return attempt
}

async function serializableWithRetry<T>(
  prisma: PrismaClient,
  tenantId: string,
  maxAttempts: number,
  retryIdempotencyRace: boolean,
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
      const retryable = isRetryablePaymentExecutionConflict(error, retryIdempotencyRace)
      if (!retryable || attempt === maxAttempts) {
        if (retryable) {
          throw new PaymentExecutionError('PAYMENT_EXECUTION_CONCURRENCY_CONFLICT', 409)
        }
        const deterministic = deterministicExecutionConflict(error)
        if (deterministic) throw new PaymentExecutionError(deterministic, 409)
        throw error
      }
    }
  }
  throw new PaymentExecutionError('PAYMENT_EXECUTION_CONCURRENCY_CONFLICT', 409)
}

export function isRetryablePaymentExecutionConflict(
  error: unknown,
  allowIdempotencyRace = false,
): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  if (code === 'P2034' || code === '40001') return true
  const meta = Reflect.get(error, 'meta')
  if (
    code === 'P2010' &&
    typeof meta === 'object' &&
    meta !== null &&
    Reflect.get(meta, 'code') === '40001'
  ) {
    return true
  }
  return (
    allowIdempotencyRace &&
    code === 'P2002' &&
    constraintIdentity(meta) === 'PaymentAttempt_tenant_idempotency_key'
  )
}

function deterministicExecutionConflict(error: unknown): string | null {
  if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'P2002') return null
  const identity = constraintIdentity(Reflect.get(error, 'meta'))
  if (identity === 'PaymentAttempt_provider_reference_key') return 'PROVIDER_REFERENCE_CONFLICT'
  if (identity === 'PaymentAttempt_tenant_idempotency_key') return 'IDEMPOTENCY_KEY_CONFLICT'
  return null
}

function constraintIdentity(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return ''
  const constraint = Reflect.get(meta, 'constraint')
  if (typeof constraint === 'string') return constraint
  const target = Reflect.get(meta, 'target')
  if (!Array.isArray(target) || Reflect.get(meta, 'modelName') !== 'PaymentAttempt') return ''
  const fields = target.join(',')
  if (fields === 'tenantId,requestIdempotencyKey') {
    return 'PaymentAttempt_tenant_idempotency_key'
  }
  if (fields === 'tenantId,providerConfigurationId,providerReference') {
    return 'PaymentAttempt_provider_reference_key'
  }
  return ''
}

function executionFailure(
  request: { log: { error(input: unknown, message: string): void } },
  reply: { code(status: number): { send(payload: ErrorEnvelope): unknown } },
  error: unknown,
) {
  if (error instanceof PaymentExecutionError) {
    const publicMessages: Record<string, string> = {
      PAYMENT_NOT_FOUND: 'The payment is not available.',
      PAYMENT_EXECUTION_FORBIDDEN: 'The payment is not available.',
      IDEMPOTENCY_KEY_CONFLICT: 'The idempotency key was already used.',
      PAYMENT_NOT_ELIGIBLE_FOR_EXECUTION: 'The payment is not eligible for initialization.',
      PAYMENT_EXECUTION_CONCURRENCY_CONFLICT: 'Payment initialization conflicted; retry safely.',
      PAYMENT_EXECUTION_VERSION_CONFLICT: 'Payment initialization state changed; retry safely.',
      PROVIDER_REFERENCE_CONFLICT: 'Provider initialization returned a conflicting reference.',
      PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE: 'Payment initialization is temporarily unavailable.',
      PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE: 'Payment initialization is temporarily unavailable.',
      PAYMENT_EXECUTION_RESULT_INCOMPLETE: 'Payment initialization is temporarily unavailable.',
    }
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, publicMessages[error.code] ?? 'Payment request rejected.'))
  }
  request.log.error({ err: error }, 'Payment initialization persistence failed')
  return reply
    .code(503)
    .send(
      errorEnvelope(
        'PAYMENT_EXECUTION_UNAVAILABLE',
        'Payment initialization is temporarily unavailable.',
      ),
    )
}

function responseMeta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
