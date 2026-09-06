import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  selectAuthenticationProvider,
  type AuthenticationCredentialResolver,
  type AuthenticationDeliveryEnvironment,
  type TextMessageProvider,
} from '@alo-noon/domain'

/**
 * Putting one text message on the wire.
 *
 * Everything above this decides *whether* to send and what the words are; this
 * decides nothing. It selects the tenant's gateway, resolves the credential,
 * calls the adapter under a timeout, and reports what happened in terms the
 * caller can record.
 *
 * It exists as its own module because there are now two callers with nothing
 * else in common — order notifications, which are keyed on an order and go by
 * push when they can, and a wallet transfer's confirmation code, which is keyed
 * on nothing and must never go by push. Leaving the send inside the first of
 * them would have meant the second either reached through it or grew a second
 * provider-selection path, and a second selection path is a second way for a
 * message to fail to be sent at all.
 *
 * Never throws for a delivery failure. A caller deciding what to do about an
 * unreachable gateway needs the reason, not a stack trace.
 */
export interface TextMessageSenderOptions {
  readonly providers: readonly TextMessageProvider[]
  readonly credentialResolver: AuthenticationCredentialResolver
  readonly environment: AuthenticationDeliveryEnvironment
  readonly timeoutMs?: number
}

export interface TextMessageRequest {
  readonly mobileE164: string
  readonly body: string
  readonly idempotencyKey: string
  readonly timeoutMs: number
  readonly now: Date
}

export interface TextMessageOutcome {
  readonly outcome: string
  readonly providerReference?: string | undefined
  readonly code: string
}

export async function sendTextMessage(
  prisma: PrismaClient,
  options: TextMessageSenderOptions,
  tenantId: string,
  input: TextMessageRequest,
): Promise<TextMessageOutcome> {
  const configurations = await readTransaction(prisma, tenantId, (transaction) =>
    transaction.authDeliveryProviderConfiguration.findMany({ where: { tenantId } }),
  )

  let selected
  try {
    // The same gateway that carries sign-in codes. A tenant running two SMS
    // accounts, one for codes and one for notifications, is not a thing anyone
    // has asked for, and inventing a second selection path would double the
    // ways a message can fail to be sent at all.
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
      tenantId,
      options.environment,
      input.now,
    )
  } catch {
    return { outcome: 'TRANSIENT_FAILURE', code: 'PROVIDER_MISSING' }
  }

  const adapter = options.providers.find((provider) => provider.code === selected.providerCode)
  const configuration = configurations.find((entry) => entry.id === selected.id)
  if (!adapter || !configuration) {
    return { outcome: 'TRANSIENT_FAILURE', code: 'ADAPTER_UNAVAILABLE' }
  }

  let credential
  try {
    credential = await options.credentialResolver.resolve(
      configuration.credentialReference,
      tenantId,
      configuration.providerCode,
    )
  } catch {
    return { outcome: 'PERMANENT_FAILURE', code: 'CREDENTIAL_UNAVAILABLE' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const result = await adapter.sendText({
      mobileE164: input.mobileE164,
      body: input.body,
      senderReference: configuration.senderReference,
      idempotencyKey: input.idempotencyKey,
      timeoutMs: input.timeoutMs,
      signal: controller.signal,
      credential,
    })
    return {
      outcome: result.outcome,
      providerReference: result.providerReference,
      code: result.normalizedCode ?? 'UNSPECIFIED',
    }
  } catch {
    return { outcome: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function readTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
