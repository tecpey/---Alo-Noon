import type { Prisma, PrismaClient } from '@alo-noon/database'

/**
 * Governs which service carries a tenant's email.
 *
 * Shaped like the SMS and routing governance an operator already knows: a
 * configuration is created in its final form, and the only control afterwards
 * is `healthStatus`. Marking one UNHEALTHY is how a service leaves rotation
 * without a migration.
 *
 * `env://` is allowed here, as it is for SMS and routing and unlike payment: an
 * email credential sends messages, it does not move money.
 */

/**
 * A STAFF actor is authorized inside the same transaction that performs the
 * write, against a GLOBAL-scoped grant carrying the governance permission. A
 * SYSTEM actor has no account to check and is only accepted when the caller is
 * a trusted composition root — the provisioning CLI — which opts in explicitly.
 */
export type EmailGovernanceActor =
  { actor: 'STAFF'; actorId: string } | { actor: 'SYSTEM'; actorId?: never }

export type CreateEmailConfigurationCommand = EmailGovernanceActor & {
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  senderAddress: string
  senderName: string
  enabled: boolean
  isDefault: boolean
  priority?: number
  reason: string
}

export type SetEmailConfigurationHealthCommand = EmailGovernanceActor & {
  configurationId: string
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  reason: string
}

export interface EmailConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  adapterSpiVersion: number
  environment: 'TEST' | 'PRODUCTION'
  credentialReference: string
  senderAddress: string
  senderName: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: string
}

export interface AlertRecipientSummary {
  id: string
  address: string
  displayName: string
  enabled: boolean
  criticalOnly: boolean
  createdAt: string
}

export type AddAlertRecipientCommand = EmailGovernanceActor & {
  address: string
  displayName: string
  criticalOnly: boolean
  reason: string
}

export type SetAlertRecipientEnabledCommand = EmailGovernanceActor & {
  recipientId: string
  enabled: boolean
  reason: string
}

export interface EmailProviderService {
  /** Who is told when something breaks. */
  listAlertRecipients(
    tenantId: string,
    actor: EmailGovernanceActor,
    now: Date,
  ): Promise<AlertRecipientSummary[]>
  addAlertRecipient(
    tenantId: string,
    command: AddAlertRecipientCommand,
    now: Date,
    correlationId: string,
  ): Promise<AlertRecipientSummary>
  setAlertRecipientEnabled(
    tenantId: string,
    command: SetAlertRecipientEnabledCommand,
    now: Date,
    correlationId: string,
  ): Promise<AlertRecipientSummary>
  createConfiguration(
    tenantId: string,
    command: CreateEmailConfigurationCommand,
    now: Date,
    correlationId: string,
  ): Promise<EmailConfigurationSummary>
  setConfigurationHealth(
    tenantId: string,
    command: SetEmailConfigurationHealthCommand,
    now: Date,
    correlationId: string,
  ): Promise<EmailConfigurationSummary>
  listConfigurations(
    tenantId: string,
    actor: EmailGovernanceActor,
    now: Date,
  ): Promise<EmailConfigurationSummary[]>
}

export class EmailProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'EmailProviderError'
  }
}

export interface EmailProviderOptions {
  allowSystemOperations?: boolean
  maxSerializationAttempts?: number
}

// Mirrors the database CHECK constraints so a misconfiguration is reported with
// a usable message instead of a raw constraint violation.
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,31}$/
const ADAPTER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CREDENTIAL_REFERENCE = /^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/
// The environment-backed resolver only accepts this shape, so an env:// reference
// that does not match would resolve to nothing at send time. The prefix is what
// stops a configuration from naming an unrelated environment variable and
// handing its value to an email adapter.
const ENV_CREDENTIAL_REFERENCE = /^env:\/\/EMAIL_[A-Z0-9_]{1,120}$/
// Deliberately loose, matching the CHECK: one @, something either side, no
// spaces. The authority on whether an address works is the receiving mail
// server, not a regular expression here — and a stricter pattern would refuse
// addresses that deliver perfectly well.
const SENDER_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const EMAIL_GOVERN_PERMISSION = 'notification-provider.configuration.govern'

export function createPrismaEmailProviderService(
  prisma: PrismaClient,
  options: EmailProviderOptions = {},
): EmailProviderService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async createConfiguration(tenantId, command, now, correlationId) {
      validateCreateCommand(command)

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.emailProviderConfiguration.findFirst({
          where: {
            tenantId,
            providerCode: command.providerCode,
            environment: command.environment,
            adapterVersion: command.adapterVersion,
          },
        })
        if (existing) {
          // Re-running provisioning is only safe when it asks for exactly what
          // already exists; anything else would quietly mean something other
          // than what the operator typed.
          if (
            existing.credentialReference !== command.credentialReference ||
            existing.senderAddress !== command.senderAddress ||
            existing.senderName !== command.senderName ||
            existing.enabled !== command.enabled ||
            existing.isDefault !== command.isDefault
          ) {
            throw new EmailProviderError('EMAIL_CONFIGURATION_CONFLICT')
          }
          return mapConfiguration(existing)
        }

        if (command.isDefault) {
          // A partial unique index enforces one default per environment.
          // Reading first turns an index violation into a sentence the operator
          // can act on.
          const currentDefault = await transaction.emailProviderConfiguration.findFirst({
            where: { tenantId, environment: command.environment, isDefault: true },
          })
          if (currentDefault) throw new EmailProviderError('EMAIL_DEFAULT_ALREADY_EXISTS')
        }

        const configuration = await transaction.emailProviderConfiguration.create({
          data: {
            tenantId,
            providerCode: command.providerCode,
            adapterVersion: command.adapterVersion,
            adapterSpiVersion: 1,
            environment: command.environment,
            credentialReference: command.credentialReference,
            senderAddress: command.senderAddress,
            senderName: command.senderName,
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
          'notification.email_provider.configured',
          `Email provider ${command.providerCode} configured for ${command.environment}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(configuration)
      })
    },

    async setConfigurationHealth(tenantId, command, now, correlationId) {
      if (!command.reason.trim()) throw new EmailProviderError('EMAIL_REASON_REQUIRED')

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.emailProviderConfiguration.findFirst({
          where: { id: command.configurationId, tenantId },
        })
        if (!existing) throw new EmailProviderError('EMAIL_CONFIGURATION_NOT_FOUND')

        const updated = await transaction.emailProviderConfiguration.update({
          where: { id: existing.id },
          data: {
            healthStatus: command.healthStatus,
            // The table's guard trigger refuses any update that does not raise
            // this, which is the schema saying every change is a governed act
            // with a number on it — and what stops two operators from silently
            // overwriting each other's decision about a service.
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
          'notification.email_provider.health_changed',
          `Email provider health set to ${command.healthStatus}`,
          command.reason,
          correlationId,
          now,
        )
        return mapConfiguration(updated)
      })
    },

    async listAlertRecipients(tenantId, actor, now) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, actor, now, options)
        const recipients = await transaction.operatorAlertRecipient.findMany({
          where: { tenantId },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        })
        return recipients.map(mapRecipient)
      })
    },

    async addAlertRecipient(tenantId, command, now, correlationId) {
      if (!SENDER_ADDRESS.test(command.address) || command.address.length > 254) {
        throw new EmailProviderError('EMAIL_RECIPIENT_ADDRESS_INVALID')
      }
      if (!command.displayName.trim() || command.displayName.length > 128) {
        throw new EmailProviderError('EMAIL_RECIPIENT_NAME_INVALID')
      }
      if (!command.reason.trim()) throw new EmailProviderError('EMAIL_REASON_REQUIRED')

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        // The unique index is on lower(address), because Operator@x and
        // operator@x are one inbox and adding both would send it everything
        // twice. Reading first turns that into a sentence.
        const existing = await transaction.operatorAlertRecipient.findFirst({
          where: { tenantId, address: { equals: command.address, mode: 'insensitive' } },
        })
        if (existing) throw new EmailProviderError('EMAIL_RECIPIENT_ALREADY_EXISTS')

        const recipient = await transaction.operatorAlertRecipient.create({
          data: {
            tenantId,
            address: command.address,
            displayName: command.displayName,
            criticalOnly: command.criticalOnly,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
        })
        await writeAudit(
          transaction,
          tenantId,
          recipient.id,
          command.actor,
          command.actorId,
          'notification.alert_recipient.added',
          `Alert recipient ${command.address} added`,
          command.reason,
          correlationId,
          now,
        )
        return mapRecipient(recipient)
      })
    },

    async setAlertRecipientEnabled(tenantId, command, now, correlationId) {
      if (!command.reason.trim()) throw new EmailProviderError('EMAIL_REASON_REQUIRED')

      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, command, now, options)
        const existing = await transaction.operatorAlertRecipient.findFirst({
          where: { id: command.recipientId, tenantId },
        })
        if (!existing) throw new EmailProviderError('EMAIL_RECIPIENT_NOT_FOUND')

        const updated = await transaction.operatorAlertRecipient.update({
          where: { id: existing.id },
          data: { enabled: command.enabled, updatedAt: now },
        })
        await writeAudit(
          transaction,
          tenantId,
          updated.id,
          command.actor,
          command.actorId,
          command.enabled
            ? 'notification.alert_recipient.enabled'
            : 'notification.alert_recipient.disabled',
          `Alert recipient ${existing.address} ${command.enabled ? 'enabled' : 'disabled'}`,
          command.reason,
          correlationId,
          now,
        )
        return mapRecipient(updated)
      })
    },

    async listConfigurations(tenantId, actor, now) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await authorizeGovernanceActor(transaction, tenantId, actor, now, options)
        const configurations = await transaction.emailProviderConfiguration.findMany({
          where: { tenantId },
          orderBy: [{ environment: 'asc' }, { priority: 'asc' }],
        })
        return configurations.map(mapConfiguration)
      })
    },
  }
}

function validateCreateCommand(command: CreateEmailConfigurationCommand): void {
  if (!PROVIDER_CODE.test(command.providerCode)) {
    throw new EmailProviderError('EMAIL_PROVIDER_CODE_INVALID')
  }
  if (!ADAPTER_VERSION.test(command.adapterVersion)) {
    throw new EmailProviderError('EMAIL_ADAPTER_VERSION_INVALID')
  }
  if (!CREDENTIAL_REFERENCE.test(command.credentialReference)) {
    throw new EmailProviderError('EMAIL_CREDENTIAL_REFERENCE_INVALID')
  }
  if (
    command.credentialReference.startsWith('env://') &&
    !ENV_CREDENTIAL_REFERENCE.test(command.credentialReference)
  ) {
    throw new EmailProviderError('EMAIL_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE')
  }
  if (!SENDER_ADDRESS.test(command.senderAddress) || command.senderAddress.length > 254) {
    throw new EmailProviderError('EMAIL_SENDER_ADDRESS_INVALID')
  }
  if (!command.senderName.trim() || command.senderName.length > 128) {
    throw new EmailProviderError('EMAIL_SENDER_NAME_INVALID')
  }
  if (command.priority !== undefined && (command.priority < 1 || command.priority > 1000)) {
    throw new EmailProviderError('EMAIL_PRIORITY_OUT_OF_RANGE')
  }
  // The database enforces this too; failing here names the actual problem
  // rather than a check-constraint identifier.
  if (command.isDefault && !command.enabled) {
    throw new EmailProviderError('EMAIL_DEFAULT_MUST_BE_ENABLED')
  }
  if (!command.reason.trim()) throw new EmailProviderError('EMAIL_REASON_REQUIRED')
}

/**
 * Mirrors payment, SMS and routing governance: the account must be ACTIVE, an
 * ACTIVE member of *this* tenant, and hold an unexpired GLOBAL-scoped grant
 * carrying the governance permission. Checking inside the write transaction
 * means a grant revoked concurrently cannot be raced past.
 *
 * Shares the notification permission with message templates rather than adding
 * a fourth: both answer "what does this tenant say to people, and through
 * what", and splitting them would mean an operator who can write the wording
 * cannot fix the service that carries it.
 */
async function authorizeGovernanceActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: EmailGovernanceActor,
  now: Date,
  options: EmailProviderOptions,
): Promise<void> {
  if (actor.actor === 'SYSTEM') {
    if (options.allowSystemOperations === true) return
    throw new EmailProviderError('EMAIL_PROVIDER_OPERATION_FORBIDDEN')
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
            permissions: { some: { permission: { code: EMAIL_GOVERN_PERMISSION } } },
          },
        },
      },
    },
    select: { id: true },
  })
  if (!authorized) throw new EmailProviderError('EMAIL_PROVIDER_OPERATION_FORBIDDEN')
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
      entityType: 'email_provider_configuration',
      entityId: configurationId,
      summary,
      correlationId,
      // Credentials are referenced, never copied, so the reference is safe to
      // record while the password itself never reaches the audit trail.
      metadata: { reason },
      occurredAt,
    },
  })
}

function mapRecipient(recipient: {
  id: string
  address: string
  displayName: string
  enabled: boolean
  criticalOnly: boolean
  createdAt: Date
}): AlertRecipientSummary {
  return {
    id: recipient.id,
    address: recipient.address,
    displayName: recipient.displayName,
    enabled: recipient.enabled,
    criticalOnly: recipient.criticalOnly,
    createdAt: recipient.createdAt.toISOString(),
  }
}

function mapConfiguration(configuration: {
  id: string
  providerCode: string
  adapterVersion: string
  adapterSpiVersion: number
  environment: string
  credentialReference: string
  senderAddress: string
  senderName: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: string
  createdAt: Date
}): EmailConfigurationSummary {
  return {
    id: configuration.id,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion,
    environment: configuration.environment as 'TEST' | 'PRODUCTION',
    credentialReference: configuration.credentialReference,
    // Both are printed on every message the tenant sends, so neither is a
    // secret and both are what an operator needs to read when mail is going
    // to spam.
    senderAddress: configuration.senderAddress,
    senderName: configuration.senderName,
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
  throw new EmailProviderError('EMAIL_PROVIDER_CONCURRENCY_CONFLICT')
}
