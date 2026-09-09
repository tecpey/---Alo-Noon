import type { Prisma, PrismaClient } from '@alo-noon/database'

/**
 * Governs which SMS provider a tenant sends OTPs through.
 *
 * Nothing could create these rows before: the table was only ever read by the
 * delivery path, so a tenant had no provider and OTP requests always failed.
 *
 * A database trigger makes providerCode, adapterVersion, environment,
 * credentialReference, sender/template references, enabled, isDefault, priority
 * and governanceVersion immutable after insert, and forbids deletion. A
 * configuration is therefore created in its final governed shape. The only
 * supported control afterwards is healthStatus, which the delivery path already
 * mutates for circuit breaking and which selection treats as authoritative:
 * marking a configuration UNHEALTHY is how an operator takes a provider out of
 * rotation without a migration.
 */
/**
 * A STAFF actor is authorized inside the same transaction that performs the
 * write, against a GLOBAL-scoped grant carrying the governance permission. A
 * SYSTEM actor has no account to check and is only accepted when the caller is
 * a trusted composition root — the provisioning CLI — which opts in explicitly.
 */
export type AuthDeliveryGovernanceActor =
  { actor: 'STAFF'; actorId: string } | { actor: 'SYSTEM'; actorId?: never }

export type CreateAuthDeliveryConfigurationCommand = AuthDeliveryGovernanceActor & {
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  senderReference: string
  templateReference: string
  enabled: boolean
  isDefault: boolean
  priority?: number
  reason: string
}

export type SetAuthDeliveryConfigurationHealthCommand = AuthDeliveryGovernanceActor & {
  configurationId: string
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  reason: string
}

export interface AuthDeliveryConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  adapterSpiVersion: number
  environment: 'TEST' | 'PRODUCTION'
  senderReference: string
  templateReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: string
}

export interface AuthDeliveryProviderService {
  createConfiguration(
    tenantId: string,
    command: CreateAuthDeliveryConfigurationCommand,
    now: Date,
    correlationId: string,
  ): Promise<AuthDeliveryConfigurationSummary>
  setConfigurationHealth(
    tenantId: string,
    command: SetAuthDeliveryConfigurationHealthCommand,
    now: Date,
    correlationId: string,
  ): Promise<AuthDeliveryConfigurationSummary>
  listConfigurations(
    tenantId: string,
    actor: AuthDeliveryGovernanceActor,
    now: Date,
  ): Promise<AuthDeliveryConfigurationSummary[]>
}

export class AuthDeliveryProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AuthDeliveryProviderError'
  }
}

export interface AuthDeliveryProviderOptions {
  allowSystemOperations?: boolean
  maxSerializationAttempts?: number
}

// Mirrors the database CHECK constraints so a misconfiguration is reported with
// a usable message instead of a raw constraint violation.
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,31}$/
const ADAPTER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CREDENTIAL_REFERENCE = /^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/
// The environment-backed resolver only accepts this shape, so an env:// reference
// that does not match would resolve to nothing at send time.
const ENV_CREDENTIAL_REFERENCE = /^env:\/\/AUTH_SMS_[A-Z0-9_]{1,120}$/
const DELIVERY_GOVERN_PERMISSION = 'auth-delivery-provider.configuration.govern'

export function createPrismaAuthDeliveryProviderService(
  prisma: PrismaClient,
  options: AuthDeliveryProviderOptions = {},
): AuthDeliveryProviderService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async createConfiguration(tenantId, command, now, correlationId) {
      validateCreateCommand(command)

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.authDeliveryProviderConfiguration.findFirst({
          where: {
            tenantId,
            providerCode: command.providerCode,
            environment: command.environment,
            adapterVersion: command.adapterVersion,
          },
        })
        if (existing) {
          // Configurations are immutable, so re-running provisioning is only safe
          // when it asks for exactly what already exists.
          if (
            existing.credentialReference !== command.credentialReference ||
            existing.senderReference !== command.senderReference ||
            existing.templateReference !== command.templateReference ||
            existing.enabled !== command.enabled ||
            existing.isDefault !== command.isDefault
          ) {
            throw new AuthDeliveryProviderError('AUTH_DELIVERY_CONFIGURATION_CONFLICT')
          }
          return mapConfiguration(existing)
        }

        if (command.enabled && command.isDefault) {
          const currentDefault = await transaction.authDeliveryProviderConfiguration.findFirst({
            where: { tenantId, environment: command.environment, enabled: true, isDefault: true },
          })
          // The existing default cannot be demoted (immutable), so report this
          // rather than letting a unique-index violation surface.
          if (currentDefault) {
            throw new AuthDeliveryProviderError('AUTH_DELIVERY_DEFAULT_ALREADY_EXISTS')
          }
        }

        const configuration = await transaction.authDeliveryProviderConfiguration.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            adapterVersion: command.adapterVersion,
            adapterSpiVersion: 1,
            environment: command.environment,
            credentialReference: command.credentialReference,
            senderReference: command.senderReference,
            templateReference: command.templateReference,
            enabled: command.enabled,
            isDefault: command.isDefault,
            priority: command.priority ?? 100,
            createdAt: now,
            updatedAt: now,
          },
        })
        await writeAudit(
          transaction,
          tenantId,
          configuration.id,
          command.actor,
          command.actorId,
          'auth.delivery_provider.configured',
          `SMS provider ${command.providerCode} configured for ${command.environment}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(configuration)
      })
    },

    async setConfigurationHealth(tenantId, command, now, correlationId) {
      if (!command.reason.trim()) {
        throw new AuthDeliveryProviderError('AUTH_DELIVERY_REASON_REQUIRED')
      }

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.authDeliveryProviderConfiguration.findFirst({
          where: { id: command.configurationId, tenantId },
        })
        if (!existing) throw new AuthDeliveryProviderError('AUTH_DELIVERY_CONFIGURATION_NOT_FOUND')

        const updated = await transaction.authDeliveryProviderConfiguration.update({
          where: { id: existing.id },
          data: {
            healthStatus: command.healthStatus,
            // Restoring a provider clears the circuit the delivery path opened.
            ...(command.healthStatus === 'HEALTHY' && {
              consecutiveFailures: 0,
              circuitOpenedUntil: null,
            }),
            updatedAt: now,
          },
        })
        await writeAudit(
          transaction,
          tenantId,
          updated.id,
          command.actor,
          command.actorId,
          'auth.delivery_provider.health_changed',
          `SMS provider health set to ${command.healthStatus}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(updated)
      })
    },

    async listConfigurations(tenantId, actor, now) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, actor, now, options)
        const configurations = await transaction.authDeliveryProviderConfiguration.findMany({
          where: { tenantId },
          orderBy: [{ environment: 'asc' }, { priority: 'asc' }],
        })
        return configurations.map(mapConfiguration)
      })
    },
  }
}

function validateCreateCommand(command: CreateAuthDeliveryConfigurationCommand): void {
  if (!PROVIDER_CODE.test(command.providerCode)) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_PROVIDER_CODE_INVALID')
  }
  if (!ADAPTER_VERSION.test(command.adapterVersion)) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_ADAPTER_VERSION_INVALID')
  }
  if (!CREDENTIAL_REFERENCE.test(command.credentialReference)) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_CREDENTIAL_REFERENCE_INVALID')
  }
  if (
    command.credentialReference.startsWith('env://') &&
    !ENV_CREDENTIAL_REFERENCE.test(command.credentialReference)
  ) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE')
  }
  if (
    !command.senderReference.trim() ||
    command.senderReference.length > 128 ||
    !command.templateReference.trim() ||
    command.templateReference.length > 128
  ) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_REFERENCE_METADATA_INVALID')
  }
  if (command.priority !== undefined && (command.priority < 1 || command.priority > 1000)) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_PRIORITY_OUT_OF_RANGE')
  }
  // The database enforces this too; failing here names the actual problem.
  if (command.isDefault && !command.enabled) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_DEFAULT_MUST_BE_ENABLED')
  }
  if (!command.reason.trim()) {
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_REASON_REQUIRED')
  }
}

/**
 * Mirrors payment-provider governance: the account must be ACTIVE, an ACTIVE
 * member of *this* tenant, and hold an unexpired GLOBAL-scoped grant carrying
 * the governance permission. Checking inside the write transaction means a grant
 * revoked concurrently cannot be raced past.
 */
async function authorizeGovernanceActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: AuthDeliveryGovernanceActor,
  now: Date,
  options: AuthDeliveryProviderOptions,
): Promise<void> {
  if (actor.actor === 'SYSTEM') {
    if (options.allowSystemOperations === true) return
    throw new AuthDeliveryProviderError('AUTH_DELIVERY_PROVIDER_OPERATION_FORBIDDEN')
  }
  const authorized = await transaction.identityAccount.findFirst({
    where: {
      id: actor.actorId,
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
            permissions: { some: { permission: { code: DELIVERY_GOVERN_PERMISSION } } },
          },
        },
      },
    },
    select: { id: true },
  })
  if (!authorized) throw new AuthDeliveryProviderError('AUTH_DELIVERY_PROVIDER_OPERATION_FORBIDDEN')
}

async function writeAudit(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  configurationId: string,
  actorType: 'STAFF' | 'SYSTEM',
  actorId: string | undefined,
  action: string,
  summary: string,
  reason: string,
  correlationId: string,
  occurredAt: Date,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType,
      ...(actorId && { actorId }),
      action,
      entityType: 'auth_delivery_provider_configuration',
      entityId: configurationId,
      summary,
      correlationId,
      // Credentials are referenced, never copied, so the reference is safe to
      // record while the secret itself never reaches the audit trail.
      metadata: { reason },
      occurredAt,
    },
  })
}

function mapConfiguration(configuration: {
  id: string
  providerCode: string
  adapterVersion: string
  adapterSpiVersion: number
  environment: string
  senderReference: string
  templateReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: Date
}): AuthDeliveryConfigurationSummary {
  return {
    id: configuration.id,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion,
    environment: configuration.environment as 'TEST' | 'PRODUCTION',
    senderReference: configuration.senderReference,
    templateReference: configuration.templateReference,
    enabled: configuration.enabled,
    isDefault: configuration.isDefault,
    priority: configuration.priority,
    healthStatus: configuration.healthStatus,
    createdAt: configuration.createdAt.toISOString(),
  }
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
          return operation(transaction)
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
      const retryable = code === 'P2034' || code === '40001'
      if (!retryable || attempt === maxAttempts) throw error
    }
  }
  throw new AuthDeliveryProviderError('AUTH_DELIVERY_PROVIDER_CONCURRENCY_CONFLICT')
}
