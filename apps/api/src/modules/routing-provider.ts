import type { Prisma, PrismaClient } from '@alo-noon/database'

/**
 * Governs which engine measures the road for a tenant.
 *
 * The table existed and the delivery-pricing path read it, but nothing except
 * the provisioning CLI could write it — and the CLI writes with a raw Prisma
 * call, no permission check and no audit row. So the one setting that decides
 * how far every delivery is billed as could only be changed by someone with the
 * database password, and changing it left no trace.
 *
 * Shaped like the SMS provider governance an operator already knows: a
 * configuration is created in its final form, and the only control afterwards
 * is `healthStatus`. Marking one UNHEALTHY is how an engine leaves rotation
 * without a migration.
 *
 * `env://` is allowed here where payment credentials forbid it, for the reason
 * the schema gives: a routing key buys distances, not money, and the worst a
 * leaked one does is spend the tenant's routing quota.
 */

/**
 * A STAFF actor is authorized inside the same transaction that performs the
 * write, against a GLOBAL-scoped grant carrying the governance permission. A
 * SYSTEM actor has no account to check and is only accepted when the caller is
 * a trusted composition root — the provisioning CLI — which opts in explicitly.
 */
export type RoutingGovernanceActor =
  { actor: 'STAFF'; actorId: string } | { actor: 'SYSTEM'; actorId?: never }

export type CreateRoutingConfigurationCommand = RoutingGovernanceActor & {
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  enabled: boolean
  isDefault: boolean
  priority?: number
  reason: string
}

export type SetRoutingConfigurationHealthCommand = RoutingGovernanceActor & {
  configurationId: string
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  reason: string
}

export interface RoutingConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  adapterSpiVersion: number
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: string
}

export interface RoutingProviderService {
  createConfiguration(
    tenantId: string,
    command: CreateRoutingConfigurationCommand,
    now: Date,
    correlationId: string,
  ): Promise<RoutingConfigurationSummary>
  setConfigurationHealth(
    tenantId: string,
    command: SetRoutingConfigurationHealthCommand,
    now: Date,
    correlationId: string,
  ): Promise<RoutingConfigurationSummary>
  listConfigurations(
    tenantId: string,
    actor: RoutingGovernanceActor,
    now: Date,
  ): Promise<RoutingConfigurationSummary[]>
}

export class RoutingProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RoutingProviderError'
  }
}

export interface RoutingProviderOptions {
  allowSystemOperations?: boolean
  maxSerializationAttempts?: number
}

// Mirrors the database CHECK constraints so a misconfiguration is reported with
// a usable message instead of a raw constraint violation.
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,31}$/
const ADAPTER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CREDENTIAL_REFERENCE = /^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/
// The environment-backed resolver only accepts this shape, so an env:// reference
// that does not match would resolve to nothing when a distance is asked for.
// The prefix is what stops a configuration from naming an unrelated environment
// variable and handing its value to a routing adapter.
const ENV_CREDENTIAL_REFERENCE = /^env:\/\/ROUTING_[A-Z0-9_]{1,120}$/
const ROUTING_GOVERN_PERMISSION = 'routing-provider.configuration.govern'

export function createPrismaRoutingProviderService(
  prisma: PrismaClient,
  options: RoutingProviderOptions = {},
): RoutingProviderService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async createConfiguration(tenantId, command, now, correlationId) {
      validateCreateCommand(command)

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.routingProviderConfiguration.findFirst({
          where: {
            tenantId,
            providerCode: command.providerCode,
            environment: command.environment,
            adapterVersion: command.adapterVersion,
          },
        })
        if (existing) {
          // Re-running provisioning is only safe when it asks for exactly what
          // already exists; anything else would silently mean something other
          // than what the operator typed.
          if (
            existing.credentialReference !== command.credentialReference ||
            existing.enabled !== command.enabled ||
            existing.isDefault !== command.isDefault
          ) {
            throw new RoutingProviderError('ROUTING_CONFIGURATION_CONFLICT')
          }
          return mapConfiguration(existing)
        }

        if (command.isDefault) {
          // A partial unique index enforces one default per environment. Reading
          // first turns an index violation into a sentence the operator can act
          // on, and names which configuration is in the way.
          const currentDefault = await transaction.routingProviderConfiguration.findFirst({
            where: { tenantId, environment: command.environment, isDefault: true },
          })
          if (currentDefault) throw new RoutingProviderError('ROUTING_DEFAULT_ALREADY_EXISTS')
        }

        const configuration = await transaction.routingProviderConfiguration.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            adapterVersion: command.adapterVersion,
            adapterSpiVersion: 1,
            environment: command.environment,
            credentialReference: command.credentialReference,
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
          'routing.provider.configured',
          `Routing engine ${command.providerCode} configured for ${command.environment}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(configuration)
      })
    },

    async setConfigurationHealth(tenantId, command, now, correlationId) {
      if (!command.reason.trim()) throw new RoutingProviderError('ROUTING_REASON_REQUIRED')

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.routingProviderConfiguration.findFirst({
          where: { id: command.configurationId, tenantId },
        })
        if (!existing) throw new RoutingProviderError('ROUTING_CONFIGURATION_NOT_FOUND')

        const updated = await transaction.routingProviderConfiguration.update({
          where: { id: existing.id },
          data: {
            healthStatus: command.healthStatus,
            // The table's guard trigger refuses any update that does not raise
            // this. That is the schema saying every change to a routing engine
            // is a governed act with a number on it — not a rule to work
            // around. Without it the update fails inside the transaction and
            // the operator sees a 503 that reads like an outage.
            governanceVersion: { increment: 1 },
            updatedAt: now,
          },
        })
        await writeAudit(
          transaction,
          tenantId,
          updated.id,
          command.actor,
          command.actorId,
          'routing.provider.health_changed',
          `Routing engine health set to ${command.healthStatus}`,
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
        const configurations = await transaction.routingProviderConfiguration.findMany({
          where: { tenantId },
          orderBy: [{ environment: 'asc' }, { priority: 'asc' }],
        })
        return configurations.map(mapConfiguration)
      })
    },
  }
}

function validateCreateCommand(command: CreateRoutingConfigurationCommand): void {
  if (!PROVIDER_CODE.test(command.providerCode)) {
    throw new RoutingProviderError('ROUTING_PROVIDER_CODE_INVALID')
  }
  if (!ADAPTER_VERSION.test(command.adapterVersion)) {
    throw new RoutingProviderError('ROUTING_ADAPTER_VERSION_INVALID')
  }
  if (!CREDENTIAL_REFERENCE.test(command.credentialReference)) {
    throw new RoutingProviderError('ROUTING_CREDENTIAL_REFERENCE_INVALID')
  }
  if (
    command.credentialReference.startsWith('env://') &&
    !ENV_CREDENTIAL_REFERENCE.test(command.credentialReference)
  ) {
    throw new RoutingProviderError('ROUTING_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE')
  }
  if (command.priority !== undefined && (command.priority < 1 || command.priority > 1000)) {
    throw new RoutingProviderError('ROUTING_PRIORITY_OUT_OF_RANGE')
  }
  // The database enforces this too; failing here names the actual problem
  // rather than a check-constraint identifier.
  if (command.isDefault && !command.enabled) {
    throw new RoutingProviderError('ROUTING_DEFAULT_MUST_BE_ENABLED')
  }
  if (!command.reason.trim()) throw new RoutingProviderError('ROUTING_REASON_REQUIRED')
}

/**
 * Mirrors payment and SMS governance: the account must be ACTIVE, an ACTIVE
 * member of *this* tenant, and hold an unexpired GLOBAL-scoped grant carrying
 * the governance permission. Checking inside the write transaction means a
 * grant revoked concurrently cannot be raced past.
 */
async function authorizeGovernanceActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: RoutingGovernanceActor,
  now: Date,
  options: RoutingProviderOptions,
): Promise<void> {
  if (actor.actor === 'SYSTEM') {
    if (options.allowSystemOperations === true) return
    throw new RoutingProviderError('ROUTING_PROVIDER_OPERATION_FORBIDDEN')
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
            permissions: { some: { permission: { code: ROUTING_GOVERN_PERMISSION } } },
          },
        },
      },
    },
    select: { id: true },
  })
  if (!authorized) throw new RoutingProviderError('ROUTING_PROVIDER_OPERATION_FORBIDDEN')
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
      entityType: 'routing_provider_configuration',
      entityId: configurationId,
      summary,
      correlationId,
      // Credentials are referenced, never copied, so the reference is safe to
      // record while the key itself never reaches the audit trail.
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
  credentialReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: Date
}): RoutingConfigurationSummary {
  return {
    id: configuration.id,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion,
    environment: configuration.environment as 'TEST' | 'PRODUCTION',
    // The reference, never the key. Showing it is the point: an operator
    // debugging "why is routing not working" needs to see which environment
    // variable the configuration is pointing at.
    credentialReference: configuration.credentialReference,
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
  throw new RoutingProviderError('ROUTING_PROVIDER_CONCURRENCY_CONFLICT')
}
