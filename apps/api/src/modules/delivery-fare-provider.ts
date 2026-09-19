import { isRetryableDatabaseFailure } from '@alo-noon/database'
import type { Prisma, PrismaClient } from '@alo-noon/database'

/**
 * Governs which courier platform prices a tenant's deliveries.
 *
 * Deliberately the same shape as the routing governance beside it, because it
 * answers the same kind of question and an operator should not have to learn a
 * second set of rules: a configuration is created in its final form, and the
 * only control afterwards is `healthStatus`. Marking one UNHEALTHY is how a
 * platform leaves rotation without a migration and without a deploy.
 *
 * `env://` is allowed, as it is for routing and unlike payment credentials. The
 * distinction the schema draws holds here: a fare key buys quotes on somebody
 * else's dispatch account, which is worth protecting but is not a key that
 * moves money out of a bank account.
 *
 * Creating a configuration is what makes real customers quotable by a third
 * party, so it is audited: who, when, and why.
 */

export type DeliveryFareGovernanceActor =
  { actor: 'STAFF'; actorId: string } | { actor: 'SYSTEM'; actorId?: never }

export interface DeliveryFareConfigurationSummary {
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

export type CreateDeliveryFareConfiguration = DeliveryFareGovernanceActor & {
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  enabled: boolean
  isDefault: boolean
  priority?: number
  reason: string
}

export type SetDeliveryFareHealth = DeliveryFareGovernanceActor & {
  configurationId: string
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  reason: string
}

export interface DeliveryFareProviderService {
  createConfiguration(
    tenantId: string,
    command: CreateDeliveryFareConfiguration,
    now: Date,
    correlationId: string,
  ): Promise<DeliveryFareConfigurationSummary>
  listConfigurations(
    tenantId: string,
    actor: DeliveryFareGovernanceActor,
    now: Date,
  ): Promise<DeliveryFareConfigurationSummary[]>
  setConfigurationHealth(
    tenantId: string,
    command: SetDeliveryFareHealth,
    now: Date,
    correlationId: string,
  ): Promise<DeliveryFareConfigurationSummary>
}

export class DeliveryFareProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DeliveryFareProviderError'
  }
}

export interface DeliveryFareProviderOptions {
  allowSystemOperations?: boolean
  maxSerializationAttempts?: number
}

const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,31}$/
const ADAPTER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CREDENTIAL_REFERENCE = /^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/
// The environment-backed resolver accepts only this shape, and the prefix is
// what stops a configuration from naming an unrelated variable and handing its
// value to a third party's adapter.
const ENV_CREDENTIAL_REFERENCE = /^env:\/\/DELIVERY_FARE_[A-Z0-9_]{1,120}$/
const FARE_GOVERN_PERMISSION = 'delivery-fare-provider.configuration.govern'

export function createPrismaDeliveryFareProviderService(
  prisma: PrismaClient,
  options: DeliveryFareProviderOptions = {},
): DeliveryFareProviderService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async createConfiguration(tenantId, command, now, correlationId) {
      if (!PROVIDER_CODE.test(command.providerCode)) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_PROVIDER_CODE_INVALID')
      }
      if (!ADAPTER_VERSION.test(command.adapterVersion)) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_ADAPTER_VERSION_INVALID')
      }
      if (!CREDENTIAL_REFERENCE.test(command.credentialReference)) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_CREDENTIAL_REFERENCE_INVALID')
      }
      if (
        command.credentialReference.startsWith('env://') &&
        !ENV_CREDENTIAL_REFERENCE.test(command.credentialReference)
      ) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_ENV_CREDENTIAL_UNRESOLVABLE')
      }
      if (!command.reason.trim()) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_REASON_REQUIRED')
      }

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorize(transaction, tenantId, command, now, options)

        const existing = await transaction.deliveryFareProviderConfiguration.findFirst({
          where: {
            tenantId,
            providerCode: command.providerCode,
            environment: command.environment,
            adapterVersion: command.adapterVersion,
          },
        })
        if (existing) {
          // Re-running provisioning is safe only when it asks for exactly what
          // is already there. Anything else would quietly mean something other
          // than what the operator typed.
          if (
            existing.credentialReference !== command.credentialReference ||
            existing.enabled !== command.enabled ||
            existing.isDefault !== command.isDefault
          ) {
            throw new DeliveryFareProviderError('DELIVERY_FARE_CONFIGURATION_CONFLICT')
          }
          return mapConfiguration(existing)
        }

        if (command.isDefault) {
          // One default per environment, enforced here rather than left to the
          // reader: two defaults would make which platform prices an order
          // depend on row order, which is the kind of thing that only shows up
          // as an unreconcilable invoice weeks later.
          await transaction.deliveryFareProviderConfiguration.updateMany({
            where: { tenantId, environment: command.environment, isDefault: true },
            data: { isDefault: false },
          })
        }

        const created = await transaction.deliveryFareProviderConfiguration.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            adapterVersion: command.adapterVersion,
            environment: command.environment,
            credentialReference: command.credentialReference,
            enabled: command.enabled,
            isDefault: command.isDefault,
            ...(command.priority !== undefined && { priority: command.priority }),
            updatedAt: now,
          },
        })
        await writeAudit(
          transaction,
          tenantId,
          created.id,
          command.actor,
          command.actorId,
          'delivery_fare_provider.configured',
          `Delivery fare provider ${command.providerCode} configured for ${command.environment}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(created)
      })
    },

    async listConfigurations(tenantId, actor, now) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorize(transaction, tenantId, actor, now, options)
        const configurations = await transaction.deliveryFareProviderConfiguration.findMany({
          where: { tenantId },
          orderBy: [{ environment: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
        })
        return configurations.map(mapConfiguration)
      })
    },

    async setConfigurationHealth(tenantId, command, now, correlationId) {
      if (!command.reason.trim()) {
        throw new DeliveryFareProviderError('DELIVERY_FARE_REASON_REQUIRED')
      }
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorize(transaction, tenantId, command, now, options)
        const existing = await transaction.deliveryFareProviderConfiguration.findFirst({
          where: { id: command.configurationId, tenantId },
        })
        if (!existing) throw new DeliveryFareProviderError('DELIVERY_FARE_CONFIGURATION_NOT_FOUND')

        const updated = await transaction.deliveryFareProviderConfiguration.update({
          where: { id: existing.id },
          data: {
            healthStatus: command.healthStatus,
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
          'delivery_fare_provider.health_changed',
          `Delivery fare provider ${updated.providerCode} marked ${command.healthStatus}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(updated)
      })
    },
  }
}

/**
 * Who may change which courier platform prices a tenant's orders.
 *
 * A SYSTEM actor has no account to check and is accepted only when the caller
 * opted in — the provisioning CLI does, an HTTP route never would.
 */
async function authorize(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: DeliveryFareGovernanceActor,
  now: Date,
  options: DeliveryFareProviderOptions,
): Promise<void> {
  if (actor.actor === 'SYSTEM') {
    if (!options.allowSystemOperations) {
      throw new DeliveryFareProviderError('DELIVERY_FARE_OPERATION_FORBIDDEN')
    }
    return
  }
  const authorized = await transaction.accessGrant.findFirst({
    where: {
      accountId: actor.actorId,
      revokedAt: null,
      scopeType: 'GLOBAL',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      account: { tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } } },
      role: { permissions: { some: { permission: { code: FARE_GOVERN_PERMISSION } } } },
    },
    select: { id: true },
  })
  if (!authorized) throw new DeliveryFareProviderError('DELIVERY_FARE_OPERATION_FORBIDDEN')
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
      entityType: 'delivery_fare_provider_configuration',
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
}): DeliveryFareConfigurationSummary {
  return {
    id: configuration.id,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion,
    environment: configuration.environment as 'TEST' | 'PRODUCTION',
    // The reference, never the key. An operator debugging "why is Tapsi not
    // pricing anything" needs to see which variable it is pointing at.
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
      if (!isRetryableDatabaseFailure(error) || attempt === maxAttempts) throw error
    }
  }
  throw new DeliveryFareProviderError('DELIVERY_FARE_CONCURRENCY_CONFLICT')
}
