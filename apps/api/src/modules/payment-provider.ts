import { createHash } from 'node:crypto'

import {
  paymentAttemptEventPayloadSchema,
  paymentAttemptSummarySchema,
  paymentCallbackEventPayloadSchema,
  paymentCallbackReceiptSummarySchema,
  paymentProviderConfigurationEventPayloadSchema,
  paymentProviderConfigurationSummarySchema,
  providerCredentialReferenceCreatedEventPayloadSchema,
  type PaymentAttemptSummary,
  type PaymentCallbackReceiptSummary,
  type PaymentProviderConfigurationSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  canonicalProviderRequest,
  redactProviderSecrets,
  requireProviderCapability,
  resolveProductionProviderAdapter,
  selectPaymentProvider,
  transitionPaymentAttempt,
  validateProviderCapabilities,
  type PaymentAttemptState,
  type PaymentProviderAdapter,
  type PaymentProviderCapability,
  type ProviderSecretResolver,
  type ProviderNormalizedOutcome,
} from '@alo-noon/domain'

const PROVIDER_GOVERN_PERMISSION = 'payment-provider.configuration.govern'
const CALLBACK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const APPROVED_CALLBACK_HEADERS = new Set([
  'x-provider-event-id',
  'x-provider-signature-version',
  'x-provider-timestamp',
])

type GovernanceActor = { actor: 'STAFF'; actorId: string } | { actor: 'SYSTEM'; actorId?: never }

export type CreateCredentialReferenceCommand = GovernanceActor & {
  providerCode: string
  reference: string
  keyVersion: string
  metadata: Readonly<Record<string, string>>
  idempotencyKey: string
}

export type CreateProviderConfigurationCommand = GovernanceActor & {
  providerCode: string
  merchantReference: string
  environment: 'TEST' | 'PRODUCTION'
  paymentContext: 'CHECKOUT'
  currency: 'IRR'
  callbackPolicy: 'SIGNED_ONLY'
  capabilities: readonly PaymentProviderCapability[]
  credentialReferenceId: string
  idempotencyKey: string
  reason: string
}

export type GovernProviderConfigurationCommand = GovernanceActor & {
  providerConfigurationId: string
  targetActive: boolean
  makeDefault: boolean
  idempotencyKey: string
  reason: string
}

export interface CreatePaymentAttemptCommand {
  paymentId: string
  environment: 'TEST' | 'PRODUCTION'
  paymentContext: 'CHECKOUT'
  idempotencyKey: string
}

export interface TransitionPaymentAttemptCommand {
  paymentAttemptId: string
  to: PaymentAttemptState
  normalizedOutcome?: ProviderNormalizedOutcome
  providerReference?: string
  idempotencyKey: string
}

export interface ReceivePaymentCallbackCommand {
  providerCode: string
  environment: 'TEST' | 'PRODUCTION'
  externalEventId: string
  approvedHeaders: Readonly<Record<string, string>>
  canonicalPayload: Readonly<Record<string, unknown>>
  idempotencyKey: string
}

export interface VerifyPaymentCallbackCommand {
  callbackReceiptId: string
  idempotencyKey: string
  canonicalBody: Uint8Array
  approvedHeaders: Readonly<Record<string, string>>
}

export interface PaymentProviderService {
  createCredentialReference(
    tenantId: string,
    command: CreateCredentialReferenceCommand,
    now: Date,
    correlationId: string,
  ): Promise<{ id: string; providerCode: string; keyVersion: string; createdAt: string }>
  createConfiguration(
    tenantId: string,
    command: CreateProviderConfigurationCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentProviderConfigurationSummary>
  governConfiguration(
    tenantId: string,
    command: GovernProviderConfigurationCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentProviderConfigurationSummary>
  createAttempt(
    tenantId: string,
    command: CreatePaymentAttemptCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentAttemptSummary>
  transitionAttempt(
    tenantId: string,
    command: TransitionPaymentAttemptCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentAttemptSummary>
  receiveCallback(
    tenantId: string,
    command: ReceivePaymentCallbackCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentCallbackReceiptSummary>
  verifyCallback(
    tenantId: string,
    command: VerifyPaymentCallbackCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentCallbackReceiptSummary>
}

export interface PrismaPaymentProviderOptions {
  maxSerializationAttempts?: number
  allowSystemOperations?: boolean
  adapters?: ReadonlyMap<string, PaymentProviderAdapter>
  secretResolver?: ProviderSecretResolver
  beforeCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
}

export class PaymentProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function createPrismaPaymentProviderService(
  prisma: PrismaClient,
  options: PrismaPaymentProviderOptions = {},
): PaymentProviderService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async createCredentialReference(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.providerCredentialReference.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          if (
            replay.providerCode !== command.providerCode ||
            replay.reference !== command.reference ||
            replay.keyVersion !== command.keyVersion ||
            replay.actorType !== command.actor ||
            replay.actorId !== (command.actorId ?? null) ||
            providerFingerprint(replay.metadata) !== providerFingerprint(command.metadata)
          ) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          await authorizeGovernanceActor(transaction, tenantId, command, now, options)
          return mapCredential(replay)
        }
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        validateCredentialReference(command.reference)
        const created = await transaction.providerCredentialReference.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            reference: command.reference,
            keyVersion: command.keyVersion,
            metadata: command.metadata,
            idempotencyKey: command.idempotencyKey,
            actorType: command.actor,
            ...(command.actorId && { actorId: command.actorId }),
            correlationId,
            createdAt: now,
          },
        })
        const payload = providerCredentialReferenceCreatedEventPayloadSchema.parse({
          credentialReferenceId: created.id,
          providerCode: created.providerCode,
          keyVersion: created.keyVersion,
        })
        await Promise.all([
          transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: command.actor,
              ...(command.actorId && { actorId: command.actorId }),
              action: 'payment_provider.credential_reference_created',
              entityType: 'provider_credential_reference',
              entityId: created.id,
              summary: 'Opaque provider credential reference created',
              correlationId,
              metadata: payload,
              occurredAt: now,
            },
          }),
          transaction.domainEventOutbox.create({
            data: {
              tenantId,
              eventId: created.id,
              name: 'payment_provider.credential_reference_created',
              aggregateType: 'provider_credential_reference',
              aggregateId: created.id,
              actorType: command.actor,
              ...(command.actorId && { actorId: command.actorId }),
              correlationId,
              consentBasis: 'TRANSACTIONAL',
              payload,
              occurredAt: now,
            },
          }),
        ])
        await options.beforeCommit?.(transaction)
        return mapCredential(created)
      })
    },

    async createConfiguration(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.paymentProviderConfiguration.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          const governance = await transaction.paymentProviderGovernanceEvent.findFirst({
            where: { tenantId, idempotencyKey: command.idempotencyKey },
          })
          if (!sameConfiguration(replay, command)) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          if (
            !governance ||
            governance.actorType !== command.actor ||
            governance.actorId !== (command.actorId ?? null) ||
            governance.reason !== command.reason
          ) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          await authorizeGovernanceActor(transaction, tenantId, command, now, options)
          return mapConfiguration(replay, {
            isActive: governance.toActive,
            isDefault: governance.toDefault,
            version: governance.version,
            updatedAt: governance.occurredAt,
          })
        }
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        validateProviderCapabilities(command.capabilities)
        const credential = await transaction.providerCredentialReference.findFirst({
          where: {
            id: command.credentialReferenceId,
            tenantId,
            providerCode: command.providerCode,
          },
        })
        if (!credential) throw new PaymentProviderError('PROVIDER_CREDENTIAL_NOT_FOUND')
        const configuration = await transaction.paymentProviderConfiguration.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            merchantReference: command.merchantReference,
            environment: command.environment,
            paymentContext: command.paymentContext,
            currency: command.currency,
            callbackPolicy: command.callbackPolicy,
            capabilities: [...command.capabilities],
            credentialReferenceId: credential.id,
            idempotencyKey: command.idempotencyKey,
            createdAt: now,
            updatedAt: now,
          },
        })
        const governance = await transaction.paymentProviderGovernanceEvent.create({
          data: {
            tenantId,
            providerConfigurationId: configuration.id,
            action: 'CREATED',
            fromActive: null,
            toActive: false,
            fromDefault: null,
            toDefault: false,
            actorType: command.actor,
            ...(command.actorId && { actorId: command.actorId }),
            version: 1,
            idempotencyKey: command.idempotencyKey,
            reason: command.reason,
            correlationId,
            occurredAt: now,
          },
        })
        await writeProviderGovernanceRecords(
          transaction,
          tenantId,
          configuration,
          governance.id,
          command.actor,
          command.actorId,
          'payment_provider.configuration_created',
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapConfiguration(configuration)
      })
    },

    async governConfiguration(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.paymentProviderGovernanceEvent.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          if (
            replay.providerConfigurationId !== command.providerConfigurationId ||
            replay.toActive !== command.targetActive ||
            replay.toDefault !== (command.targetActive && command.makeDefault) ||
            replay.actorType !== command.actor ||
            replay.actorId !== (command.actorId ?? null) ||
            replay.reason !== command.reason
          ) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
        }
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        if (replay) {
          return mapConfiguration(
            await loadConfiguration(transaction, tenantId, replay.providerConfigurationId),
            {
              isActive: replay.toActive,
              isDefault: replay.toDefault,
              version: replay.version,
              updatedAt: replay.occurredAt,
            },
          )
        }
        await transaction.$queryRaw`
          SELECT "id" FROM "PaymentProviderConfiguration"
          WHERE "id" = ${command.providerConfigurationId}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE
        `
        const configuration = await loadConfiguration(
          transaction,
          tenantId,
          command.providerConfigurationId,
        )
        const toDefault = command.targetActive && command.makeDefault
        if (configuration.isActive === command.targetActive) {
          throw new PaymentProviderError('PROVIDER_CONFIGURATION_STATE_UNCHANGED')
        }
        const version = configuration.governanceVersion + 1
        const action = command.targetActive ? 'ACTIVATED' : 'DEACTIVATED'
        const governance = await transaction.paymentProviderGovernanceEvent.create({
          data: {
            tenantId,
            providerConfigurationId: configuration.id,
            action,
            fromActive: configuration.isActive,
            toActive: command.targetActive,
            fromDefault: configuration.isDefault,
            toDefault,
            actorType: command.actor,
            ...(command.actorId && { actorId: command.actorId }),
            version,
            idempotencyKey: command.idempotencyKey,
            reason: command.reason,
            correlationId,
            occurredAt: now,
          },
        })
        const updated = await transaction.paymentProviderConfiguration.update({
          where: { id: configuration.id },
          data: {
            isActive: command.targetActive,
            isDefault: toDefault,
            governanceVersion: version,
            updatedAt: now,
          },
        })
        await writeProviderGovernanceRecords(
          transaction,
          tenantId,
          updated,
          governance.id,
          command.actor,
          command.actorId,
          `payment_provider.configuration_${command.targetActive ? 'activated' : 'deactivated'}`,
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapConfiguration(updated)
      })
    },

    async createAttempt(tenantId, command, now, correlationId) {
      if (options.allowSystemOperations !== true) {
        throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
      }
      const fingerprint = providerFingerprint({
        paymentId: command.paymentId,
        environment: command.environment,
        paymentContext: command.paymentContext,
      })
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.paymentAttempt.findFirst({
          where: { tenantId, requestIdempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          if (replay.requestFingerprint !== fingerprint) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          return mapAttempt(replay, {
            state: 'CREATED',
            version: 1,
            providerReference: null,
            updatedAt: replay.createdAt,
          })
        }
        const payment = await transaction.payment.findFirst({
          where: { id: command.paymentId, tenantId },
        })
        if (!payment) throw new PaymentProviderError('PAYMENT_NOT_FOUND')
        if (payment.state === 'CAPTURED' || payment.state === 'FAILED') {
          throw new PaymentProviderError('PAYMENT_NOT_ELIGIBLE_FOR_ATTEMPT')
        }
        const configurations = await transaction.paymentProviderConfiguration.findMany({
          where: {
            tenantId,
            environment: command.environment,
            paymentContext: command.paymentContext,
            currency: payment.currency,
            isActive: true,
            isDefault: true,
          },
        })
        const selected = selectPaymentProvider(
          configurations.map((configuration) => ({
            ...configuration,
            capabilities: configuration.capabilities,
          })),
          {
            tenantId,
            environment: command.environment,
            paymentContext: command.paymentContext,
            currency: payment.currency,
            capability: 'PAYMENT_INITIALIZATION',
          },
        )
        const attempt = await transaction.paymentAttempt.create({
          data: {
            tenantId,
            paymentId: payment.id,
            providerConfigurationId: selected.id,
            requestIdempotencyKey: command.idempotencyKey,
            requestFingerprint: fingerprint,
            correlationId,
            createdAt: now,
            updatedAt: now,
          },
        })
        const transition = await transaction.paymentAttemptStateTransition.create({
          data: {
            tenantId,
            paymentAttemptId: attempt.id,
            fromState: null,
            toState: 'CREATED',
            version: 1,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
          },
        })
        await writeAttemptRecords(
          transaction,
          tenantId,
          attempt,
          transition.id,
          'payment.attempt_created',
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapAttempt(attempt)
      })
    },

    async transitionAttempt(tenantId, command, now, correlationId) {
      if (options.allowSystemOperations !== true) {
        throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
      }
      if (command.to === 'VERIFIED') {
        throw new PaymentProviderError('PAYMENT_ATTEMPT_VERIFICATION_REQUIRES_ADAPTER')
      }
      if (command.providerReference && command.to !== 'INITIALIZED') {
        throw new PaymentProviderError('INVALID_PROVIDER_REFERENCE_ASSIGNMENT')
      }
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.paymentAttemptStateTransition.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          if (
            replay.paymentAttemptId !== command.paymentAttemptId ||
            replay.toState !== command.to ||
            replay.providerOutcome !== (command.normalizedOutcome ?? null) ||
            replay.providerReference !== (command.providerReference ?? null)
          ) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          const historical = await loadAttempt(transaction, tenantId, replay.paymentAttemptId)
          return mapAttempt(historical, {
            state: replay.toState,
            version: replay.version,
            providerReference: replay.providerReference,
            updatedAt: replay.occurredAt,
          })
        }
        await transaction.$queryRaw`
          SELECT "id" FROM "PaymentAttempt"
          WHERE "id" = ${command.paymentAttemptId}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE
        `
        const attempt = await loadAttempt(transaction, tenantId, command.paymentAttemptId)
        transitionPaymentAttempt(attempt.state, command.to)
        const version = attempt.version + 1
        const transition = await transaction.paymentAttemptStateTransition.create({
          data: {
            tenantId,
            paymentAttemptId: attempt.id,
            fromState: attempt.state,
            toState: command.to,
            version,
            ...(command.normalizedOutcome && { providerOutcome: command.normalizedOutcome }),
            ...(command.providerReference && { providerReference: command.providerReference }),
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
          },
        })
        const updated = await transaction.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            state: command.to,
            version,
            ...(command.providerReference && { providerReference: command.providerReference }),
            updatedAt: now,
          },
        })
        await writeAttemptRecords(
          transaction,
          tenantId,
          updated,
          transition.id,
          'payment.attempt_state_changed',
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapAttempt(updated)
      })
    },

    async receiveCallback(tenantId, command, now, correlationId) {
      if (options.allowSystemOperations !== true) {
        throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
      }
      validateApprovedHeaders(command.approvedHeaders)
      const bodyDigest = providerFingerprint(command.canonicalPayload)
      const headersFingerprint = providerFingerprint(command.approvedHeaders)
      const safePayload = redactProviderSecrets(command.canonicalPayload) as Prisma.InputJsonValue
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const keyReplay = await transaction.paymentCallbackReceipt.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        const eventReplay = await transaction.paymentCallbackReceipt.findFirst({
          where: {
            tenantId,
            externalEventId: command.externalEventId,
            providerConfiguration: {
              providerCode: command.providerCode,
              environment: command.environment,
            },
          },
        })
        const replay = keyReplay ?? eventReplay
        if (replay) {
          if (
            replay.externalEventId !== command.externalEventId ||
            replay.bodyDigest !== bodyDigest ||
            replay.headersFingerprint !== headersFingerprint ||
            providerFingerprint(replay.safePayload) !== providerFingerprint(safePayload)
          ) {
            throw new PaymentProviderError('CALLBACK_REPLAY_CONFLICT')
          }
          return mapCallback(replay)
        }
        const configurations = await transaction.paymentProviderConfiguration.findMany({
          where: {
            tenantId,
            providerCode: command.providerCode,
            environment: command.environment,
            isActive: true,
            healthStatus: 'HEALTHY',
            capabilities: { has: 'CALLBACK_VERIFICATION' },
          },
        })
        if (configurations.length !== 1) {
          throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE')
        }
        const receipt = await transaction.paymentCallbackReceipt.create({
          data: {
            tenantId,
            providerConfigurationId: configurations[0]!.id,
            externalEventId: command.externalEventId,
            headersFingerprint,
            bodyDigest,
            safePayload,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            receivedAt: now,
            retentionUntil: new Date(now.getTime() + CALLBACK_RETENTION_MS),
            createdAt: now,
            updatedAt: now,
          },
        })
        await writeCallbackRecords(
          transaction,
          tenantId,
          receipt,
          'payment.callback_received',
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapCallback(receipt)
      })
    },

    async verifyCallback(tenantId, command, now, correlationId) {
      if (options.allowSystemOperations !== true) {
        throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
      }
      validateApprovedHeaders(command.approvedHeaders)
      const boundary = await withTenantRead(prisma, tenantId, async (transaction) => {
        const keyOwner = await transaction.paymentCallbackReceipt.findFirst({
          where: { tenantId, processingIdempotencyKey: command.idempotencyKey },
          select: { id: true },
        })
        if (keyOwner && keyOwner.id !== command.callbackReceiptId) {
          throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
        }
        const receipt = await transaction.paymentCallbackReceipt.findFirst({
          where: { id: command.callbackReceiptId, tenantId },
          include: { providerConfiguration: { include: { credentialReference: true } } },
        })
        if (!receipt) throw new PaymentProviderError('CALLBACK_RECEIPT_NOT_FOUND')
        return receipt
      })
      const processingFingerprint = providerFingerprint({
        callbackReceiptId: boundary.id,
        bodyDigest: boundary.bodyDigest,
        headersFingerprint: providerFingerprint(command.approvedHeaders),
      })
      if (
        createHash('sha256').update(command.canonicalBody).digest('hex') !== boundary.bodyDigest ||
        providerFingerprint(command.approvedHeaders) !== boundary.headersFingerprint
      ) {
        throw new PaymentProviderError('CALLBACK_VERIFICATION_INPUT_MISMATCH')
      }
      if (boundary.processingIdempotencyKey) {
        if (
          boundary.processingIdempotencyKey !== command.idempotencyKey ||
          boundary.processingFingerprint !== processingFingerprint
        ) {
          throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
        }
        return mapCallback(boundary)
      }
      const adapter = resolveProductionProviderAdapter(
        options.adapters ?? new Map(),
        boundary.providerConfiguration.providerCode,
        boundary.providerConfiguration.environment,
      )
      requireProviderCapability(adapter, 'CALLBACK_VERIFICATION')
      if (!options.secretResolver) {
        throw new PaymentProviderError('PROVIDER_SECRET_RESOLVER_UNAVAILABLE')
      }
      let credential
      try {
        credential = await options.secretResolver.resolve(
          boundary.providerConfiguration.credentialReference.reference,
          tenantId,
          boundary.providerConfiguration.providerCode,
        )
      } catch {
        throw new PaymentProviderError('PROVIDER_CREDENTIAL_RESOLUTION_FAILED')
      }
      let verification
      try {
        verification = await adapter.verifyCallback!({
          canonicalBody: command.canonicalBody,
          approvedHeaders: command.approvedHeaders,
          receivedAt: boundary.receivedAt,
          configuration: {
            id: boundary.providerConfiguration.id,
            tenantId,
            providerCode: boundary.providerConfiguration.providerCode,
            environment: boundary.providerConfiguration.environment,
            merchantReference: boundary.providerConfiguration.merchantReference,
            callbackPolicy: 'SIGNED_ONLY',
            capabilities: boundary.providerConfiguration.capabilities,
            credentialReference: boundary.providerConfiguration.credentialReference.reference,
          },
          credential,
        })
      } catch {
        throw new PaymentProviderError('PROVIDER_CALLBACK_VERIFICATION_FAILED')
      } finally {
        try {
          credential.dispose()
        } catch {
          throw new PaymentProviderError('PROVIDER_CREDENTIAL_DISPOSAL_FAILED')
        }
      }
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const receipt = await transaction.paymentCallbackReceipt.findFirst({
          where: { id: command.callbackReceiptId, tenantId },
        })
        if (!receipt) throw new PaymentProviderError('CALLBACK_RECEIPT_NOT_FOUND')
        if (receipt.processingIdempotencyKey) {
          if (
            receipt.processingIdempotencyKey !== command.idempotencyKey ||
            receipt.processingFingerprint !== processingFingerprint
          ) {
            throw new PaymentProviderError('IDEMPOTENCY_KEY_CONFLICT')
          }
          return mapCallback(receipt)
        }
        const verified = verification.verified
        const updated = await transaction.paymentCallbackReceipt.update({
          where: { id: receipt.id },
          data: {
            verificationStatus: verified ? 'VERIFIED' : 'REJECTED',
            processingStatus: verified ? 'PROCESSED' : 'REJECTED',
            processingIdempotencyKey: command.idempotencyKey,
            processingFingerprint,
            updatedAt: now,
          },
        })
        await writeCallbackRecords(
          transaction,
          tenantId,
          updated,
          verified ? 'payment.callback_verified' : 'payment.callback_rejected',
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapCallback(updated)
      })
    },
  }
}

async function authorizeGovernanceActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  command: GovernanceActor,
  now: Date,
  options: PrismaPaymentProviderOptions,
): Promise<void> {
  if (command.actor === 'SYSTEM') {
    if (options.allowSystemOperations === true) return
    throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
  }
  const authorized = await transaction.identityAccount.findFirst({
    where: {
      id: command.actorId,
      status: 'ACTIVE',
      tenantMemberships: {
        some: {
          tenantId,
          status: 'ACTIVE',
          activeAt: { lte: now },
          suspendedAt: null,
          revokedAt: null,
        },
      },
      accessGrants: {
        some: {
          scopeType: 'GLOBAL',
          scopeId: null,
          activeAt: { lte: now },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          role: {
            permissions: { some: { permission: { code: PROVIDER_GOVERN_PERMISSION } } },
          },
        },
      },
    },
    select: { id: true },
  })
  if (!authorized) throw new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN')
}

function validateCredentialReference(reference: string): void {
  if (!/^(vault|aws-sm|gcp-sm|local-encrypted):\/\/[A-Za-z0-9/_:.-]+$/.test(reference)) {
    throw new PaymentProviderError('INVALID_PROVIDER_CREDENTIAL_REFERENCE')
  }
}

function validateApprovedHeaders(headers: Readonly<Record<string, string>>): void {
  if (Object.keys(headers).some((header) => !APPROVED_CALLBACK_HEADERS.has(header.toLowerCase()))) {
    throw new PaymentProviderError('CALLBACK_HEADER_NOT_APPROVED')
  }
}

function sameConfiguration(
  record: {
    providerCode: string
    merchantReference: string
    environment: string
    paymentContext: string
    currency: string
    callbackPolicy: string
    capabilities: readonly string[]
    credentialReferenceId: string
  },
  command: CreateProviderConfigurationCommand,
): boolean {
  return (
    record.providerCode === command.providerCode &&
    record.merchantReference === command.merchantReference &&
    record.environment === command.environment &&
    record.paymentContext === command.paymentContext &&
    record.currency === command.currency &&
    record.callbackPolicy === command.callbackPolicy &&
    record.credentialReferenceId === command.credentialReferenceId &&
    providerFingerprint([...record.capabilities].sort()) ===
      providerFingerprint([...command.capabilities].sort())
  )
}

async function loadConfiguration(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
) {
  const record = await transaction.paymentProviderConfiguration.findFirst({
    where: { id, tenantId },
  })
  if (!record) throw new PaymentProviderError('PROVIDER_CONFIGURATION_NOT_FOUND')
  return record
}

async function loadAttempt(transaction: Prisma.TransactionClient, tenantId: string, id: string) {
  const record = await transaction.paymentAttempt.findFirst({ where: { id, tenantId } })
  if (!record) throw new PaymentProviderError('PAYMENT_ATTEMPT_NOT_FOUND')
  return record
}

function mapCredential(record: {
  id: string
  providerCode: string
  keyVersion: string
  createdAt: Date
}) {
  return {
    id: record.id,
    providerCode: record.providerCode,
    keyVersion: record.keyVersion,
    createdAt: record.createdAt.toISOString(),
  }
}

function mapConfiguration(
  record: {
    id: string
    providerCode: string
    merchantReference: string
    environment: 'TEST' | 'PRODUCTION'
    paymentContext: 'CHECKOUT'
    currency: 'IRR'
    callbackPolicy: string
    capabilities: PaymentProviderCapability[]
    credentialReferenceId: string
    isActive: boolean
    isDefault: boolean
    healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
    governanceVersion: number
    createdAt: Date
    updatedAt: Date
  },
  historical?: { isActive: boolean; isDefault: boolean; version: number; updatedAt: Date },
): PaymentProviderConfigurationSummary {
  return paymentProviderConfigurationSummarySchema.parse({
    ...record,
    callbackPolicy: 'SIGNED_ONLY',
    isActive: historical?.isActive ?? record.isActive,
    isDefault: historical?.isDefault ?? record.isDefault,
    governanceVersion: historical?.version ?? record.governanceVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: (historical?.updatedAt ?? record.updatedAt).toISOString(),
  })
}

function mapAttempt(
  record: {
    id: string
    paymentId: string
    providerConfigurationId: string
    state: PaymentAttemptState
    providerReference: string | null
    version: number
    correlationId: string
    createdAt: Date
    updatedAt: Date
  },
  historical?: {
    state: PaymentAttemptState
    version: number
    providerReference: string | null
    updatedAt: Date
  },
): PaymentAttemptSummary {
  return paymentAttemptSummarySchema.parse({
    ...record,
    state: historical?.state ?? record.state,
    version: historical?.version ?? record.version,
    providerReference: historical ? historical.providerReference : record.providerReference,
    createdAt: record.createdAt.toISOString(),
    updatedAt: (historical?.updatedAt ?? record.updatedAt).toISOString(),
  })
}

function mapCallback(record: {
  id: string
  providerConfigurationId: string
  paymentAttemptId: string | null
  externalEventId: string
  bodyDigest: string
  headersFingerprint: string
  verificationStatus: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED'
  processingStatus: 'RECEIVED' | 'PROCESSED' | 'REJECTED'
  receivedAt: Date
}): PaymentCallbackReceiptSummary {
  return paymentCallbackReceiptSummarySchema.parse({
    ...record,
    receivedAt: record.receivedAt.toISOString(),
  })
}

async function writeProviderGovernanceRecords(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  configuration: Parameters<typeof mapConfiguration>[0],
  eventId: string,
  actor: 'STAFF' | 'SYSTEM',
  actorId: string | undefined,
  action: string,
  correlationId: string,
  now: Date,
) {
  const payload = paymentProviderConfigurationEventPayloadSchema.parse({
    providerConfigurationId: configuration.id,
    providerCode: configuration.providerCode,
    environment: configuration.environment,
    paymentContext: configuration.paymentContext,
    currency: configuration.currency,
    isActive: configuration.isActive,
    isDefault: configuration.isDefault,
    version: configuration.governanceVersion,
  })
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId,
        actorType: actor,
        ...(actorId && { actorId }),
        action,
        entityType: 'payment_provider_configuration',
        entityId: configuration.id,
        summary: action,
        correlationId,
        metadata: payload,
        occurredAt: now,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId,
        eventId,
        name: action,
        aggregateType: 'payment_provider_configuration',
        aggregateId: configuration.id,
        actorType: actor,
        ...(actorId && { actorId }),
        correlationId,
        consentBasis: 'TRANSACTIONAL',
        payload,
        occurredAt: now,
      },
    }),
  ])
}

async function writeAttemptRecords(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  attempt: Parameters<typeof mapAttempt>[0],
  eventId: string,
  action: string,
  correlationId: string,
  now: Date,
) {
  const payload = paymentAttemptEventPayloadSchema.parse({
    paymentAttemptId: attempt.id,
    paymentId: attempt.paymentId,
    providerConfigurationId: attempt.providerConfigurationId,
    state: attempt.state,
    version: attempt.version,
  })
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId,
        actorType: 'SYSTEM',
        action,
        entityType: 'payment_attempt',
        entityId: attempt.id,
        summary: action,
        correlationId,
        metadata: payload,
        occurredAt: now,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId,
        eventId,
        name: action,
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        actorType: 'SYSTEM',
        correlationId,
        consentBasis: 'TRANSACTIONAL',
        payload,
        occurredAt: now,
      },
    }),
  ])
}

async function writeCallbackRecords(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  receipt: Parameters<typeof mapCallback>[0],
  action: string,
  correlationId: string,
  now: Date,
) {
  const payload = paymentCallbackEventPayloadSchema.parse({
    callbackReceiptId: receipt.id,
    providerConfigurationId: receipt.providerConfigurationId,
    paymentAttemptId: receipt.paymentAttemptId,
    externalEventId: receipt.externalEventId,
    bodyDigest: receipt.bodyDigest,
    verificationStatus: receipt.verificationStatus,
    processingStatus: receipt.processingStatus,
  })
  const eventId = canonicalEventId(receipt.id, action)
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId,
        actorType: 'SYSTEM',
        action,
        entityType: 'payment_callback_receipt',
        entityId: receipt.id,
        summary: action,
        correlationId,
        metadata: payload,
        occurredAt: now,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId,
        eventId,
        name: action,
        aggregateType: 'payment_callback_receipt',
        aggregateId: receipt.id,
        actorType: 'SYSTEM',
        correlationId,
        consentBasis: 'TRANSACTIONAL',
        payload,
        occurredAt: now,
      },
    }),
  ])
}

function canonicalEventId(receiptId: string, action: string): string {
  const digest = providerFingerprint({ receiptId, action })
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function providerFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalProviderRequest(value)).digest('hex')
}

async function withTenantRead<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}

async function serializableWithRetry<T>(
  prisma: PrismaClient,
  tenantId: string,
  maxAttempts: number,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          const result = await operation(transaction)
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
          return result
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (isDefaultConflict(error)) throw new PaymentProviderError('PROVIDER_DEFAULT_CONFLICT')
      const deterministicCode = deterministicProviderConflict(error)
      if (deterministicCode) throw new PaymentProviderError(deterministicCode)
      if (!isRetryableProviderConflict(error) || attempt === maxAttempts) {
        if (isRetryableProviderConflict(error)) {
          throw new PaymentProviderError('PAYMENT_PROVIDER_CONCURRENCY_CONFLICT')
        }
        throw error
      }
    }
  }
  throw new PaymentProviderError('PAYMENT_PROVIDER_CONCURRENCY_CONFLICT')
}

export function isRetryableProviderConflict(error: unknown): boolean {
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
  if (code !== 'P2002' || !meta || typeof meta !== 'object') return false
  const value = constraintIdentity(meta)
  return [
    'ProviderCredential_tenant_idempotency_key',
    'PaymentProvider_tenant_idempotency_key',
    'PaymentProviderGovernance_tenant_idempotency_key',
    'PaymentAttempt_tenant_idempotency_key',
    'PaymentAttemptTransition_tenant_idempotency_key',
    'PaymentCallback_tenant_idempotency_key',
    'PaymentCallback_external_event_key',
    'PaymentCallback_processing_idempotency_key',
    'idempotencyKey|tenantId',
    'externalEventId|providerConfigurationId|tenantId',
    'processingIdempotencyKey|tenantId',
  ].includes(value)
}

function deterministicProviderConflict(error: unknown): string | null {
  if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'P2002') return null
  const meta = Reflect.get(error, 'meta')
  if (!meta || typeof meta !== 'object') return null
  const identity = constraintIdentity(meta)
  if (
    [
      'ProviderCredential_tenant_provider_reference_key',
      'providerCode|reference|tenantId',
    ].includes(identity)
  ) {
    return 'PROVIDER_CREDENTIAL_CONFLICT'
  }
  if (
    ['PaymentProvider_tenant_code_environment_key', 'environment|providerCode|tenantId'].includes(
      identity,
    )
  ) {
    return 'PROVIDER_CONFIGURATION_CONFLICT'
  }
  if (
    [
      'PaymentAttempt_provider_reference_key',
      'providerConfigurationId|providerReference|tenantId',
    ].includes(identity)
  ) {
    return 'PROVIDER_REFERENCE_CONFLICT'
  }
  return null
}

function isDefaultConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'P2002') return false
  const meta = Reflect.get(error, 'meta')
  return (
    !!meta &&
    typeof meta === 'object' &&
    [
      'PaymentProvider_one_active_default_key',
      'currency|environment|paymentContext|tenantId',
    ].includes(constraintIdentity(meta))
  )
}

function constraintIdentity(meta: object): string {
  const constraint = Reflect.get(meta, 'constraint')
  if (typeof constraint === 'string') return constraint
  const target = Reflect.get(meta, 'target')
  if (Array.isArray(target)) {
    return target
      .filter((value): value is string => typeof value === 'string')
      .sort()
      .join('|')
  }
  return typeof target === 'string' ? target : ''
}
