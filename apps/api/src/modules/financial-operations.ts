import {
  financialChartProvisionedEventPayloadSchema,
  ledgerAccountStateChangedEventPayloadSchema,
  type LedgerAccountSummary,
  type TenantFinancialBootstrapSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import { governLedgerAccount } from '@alo-noon/domain'

import { assertDeferredConstraints } from './deferred-constraints.js'

export interface ProvisionFinancialChartCommand {
  idempotencyKey: string
}

export interface GovernLedgerAccountCommand {
  accountId: string
  targetActive: boolean
  actor: 'SYSTEM' | 'STAFF'
  actorId?: string
  idempotencyKey: string
  reason: string
}

export interface FinancialOperationsService {
  provision(
    tenantId: string,
    command: ProvisionFinancialChartCommand,
    now: Date,
    correlationId: string,
  ): Promise<TenantFinancialBootstrapSummary>
  setAccountActive(
    tenantId: string,
    command: GovernLedgerAccountCommand,
    now: Date,
    correlationId: string,
  ): Promise<LedgerAccountSummary>
}

export interface PrismaFinancialOperationsOptions {
  maxSerializationAttempts?: number
  beforeCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
  allowSystemGovernance?: boolean
}

const LEDGER_ACCOUNT_GOVERN_PERMISSION = 'financial.ledger-account.govern'

export class FinancialOperationsError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function createPrismaFinancialOperationsService(
  prisma: PrismaClient,
  options: PrismaFinancialOperationsOptions = {},
): FinancialOperationsService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async provision(tenantId, command, now, correlationId) {
      if (command.idempotencyKey.trim().length < 16 || command.idempotencyKey.length > 128) {
        throw new FinancialOperationsError('INVALID_IDEMPOTENCY_KEY')
      }
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const existing = await loadBootstrap(transaction, tenantId)
        if (existing) return existing

        await transaction.$queryRaw`
          SELECT request_tenant_financial_chart(
            ${tenantId}::uuid,
            ${command.idempotencyKey},
            ${correlationId}::uuid,
            ${now}::timestamp
          )
        `
        const bootstrap = await loadBootstrap(transaction, tenantId)
        if (!bootstrap) throw new FinancialOperationsError('FINANCIAL_BOOTSTRAP_INCOMPLETE')
        financialChartProvisionedEventPayloadSchema.parse({
          tenantId,
          templateVersion: bootstrap.templateVersion,
          accountCount: bootstrap.accountCount,
        })
        await options.beforeCommit?.(transaction)
        return bootstrap
      })
    },

    async setAccountActive(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.ledgerAccountGovernanceEvent.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
        })
        if (replay) {
          if (
            replay.ledgerAccountId !== command.accountId ||
            replay.toActive !== command.targetActive ||
            replay.actorType !== command.actor ||
            replay.actorId !== (command.actorId ?? null) ||
            replay.reason !== command.reason
          ) {
            throw new FinancialOperationsError('IDEMPOTENCY_KEY_CONFLICT')
          }
        }

        await authorizeGovernanceActor(transaction, tenantId, command, now, options)

        if (replay) {
          return mapAccount(await loadAccount(transaction, tenantId, replay.ledgerAccountId), {
            isActive: replay.toActive,
            governanceVersion: replay.version,
          })
        }

        await transaction.$queryRaw`
          SELECT "id" FROM "LedgerAccount"
          WHERE "id" = ${command.accountId}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE
        `
        const account = await loadAccount(transaction, tenantId, command.accountId)
        const activeChildren = await transaction.ledgerAccount.count({
          where: { tenantId, parentId: account.id, isActive: true },
        })
        const decision = governLedgerAccount({
          accountId: account.id,
          currentActive: account.isActive,
          targetActive: command.targetActive,
          parentActive: account.parent?.isActive ?? null,
          hasActiveChildren: activeChildren > 0,
          actor: command.actor,
          ...(command.actorId && { actorId: command.actorId }),
          idempotencyKey: command.idempotencyKey,
          reason: command.reason,
          correlationId,
          occurredAt: now,
        })
        const version = account.governanceVersion + 1
        const governance = await transaction.ledgerAccountGovernanceEvent.create({
          data: {
            tenantId,
            ledgerAccountId: account.id,
            action: decision.action,
            fromActive: account.isActive,
            toActive: command.targetActive,
            actorType: command.actor,
            ...(command.actorId && { actorId: command.actorId }),
            version,
            idempotencyKey: command.idempotencyKey,
            reason: command.reason,
            correlationId,
            occurredAt: now,
          },
        })
        const updated = await transaction.ledgerAccount.update({
          where: { id: account.id },
          data: { isActive: command.targetActive, governanceVersion: version },
          include: { parent: true },
        })
        const payload = ledgerAccountStateChangedEventPayloadSchema.parse({
          ledgerAccountId: updated.id,
          code: updated.code,
          fromActive: account.isActive,
          toActive: updated.isActive,
          version,
          reason: command.reason,
        })
        await Promise.all([
          transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: command.actor,
              ...(command.actorId && { actorId: command.actorId }),
              action: 'financial.ledger_account_state_changed',
              entityType: 'ledger_account',
              entityId: account.id,
              summary: `Ledger account ${account.code} ${updated.isActive ? 'activated' : 'deactivated'}`,
              correlationId,
              metadata: payload,
              occurredAt: now,
            },
          }),
          transaction.domainEventOutbox.create({
            data: {
              tenantId,
              eventId: governance.id,
              name: 'financial.ledger_account_state_changed',
              aggregateType: 'ledger_account',
              aggregateId: account.id,
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
        return mapAccount(updated)
      })
    },
  }
}

async function authorizeGovernanceActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  command: GovernLedgerAccountCommand,
  now: Date,
  options: PrismaFinancialOperationsOptions,
): Promise<void> {
  if (command.actor === 'SYSTEM') {
    if (options.allowSystemGovernance === true && command.actorId === undefined) return
    throw new FinancialOperationsError('FINANCIAL_OPERATION_FORBIDDEN')
  }
  if (!command.actorId) throw new FinancialOperationsError('FINANCIAL_OPERATION_FORBIDDEN')

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
            permissions: {
              some: { permission: { code: LEDGER_ACCOUNT_GOVERN_PERMISSION } },
            },
          },
        },
      },
    },
    select: { id: true },
  })
  if (!authorized) throw new FinancialOperationsError('FINANCIAL_OPERATION_FORBIDDEN')
}

const accountInclude = { parent: true } satisfies Prisma.LedgerAccountInclude
type AccountRecord = Prisma.LedgerAccountGetPayload<{ include: typeof accountInclude }>

async function loadAccount(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
): Promise<AccountRecord> {
  const account = await transaction.ledgerAccount.findFirst({
    where: { id: accountId, tenantId },
    include: accountInclude,
  })
  if (!account) throw new FinancialOperationsError('LEDGER_ACCOUNT_NOT_FOUND')
  return account
}

async function loadBootstrap(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<TenantFinancialBootstrapSummary | null> {
  const bootstrap = await transaction.tenantFinancialBootstrap.findFirst({
    where: { tenantId, templateVersion: 1 },
  })
  if (!bootstrap) return null
  const accounts = await transaction.ledgerAccount.findMany({
    where: { tenantId, isSystem: true, templateVersion: 1 },
    include: accountInclude,
    orderBy: { code: 'asc' },
  })
  if (accounts.length !== bootstrap.accountCount) {
    throw new FinancialOperationsError('FINANCIAL_BOOTSTRAP_INCOMPLETE')
  }
  return {
    id: bootstrap.id,
    tenantId,
    templateVersion: bootstrap.templateVersion,
    accountCount: bootstrap.accountCount,
    correlationId: bootstrap.correlationId,
    completedAt: bootstrap.completedAt.toISOString(),
    accounts: accounts.map((account) => mapAccount(account)),
  }
}

function mapAccount(
  account: AccountRecord,
  replay?: Pick<LedgerAccountSummary, 'isActive' | 'governanceVersion'>,
): LedgerAccountSummary {
  return {
    id: account.id,
    parentId: account.parentId,
    code: account.code,
    name: account.name,
    type: account.type,
    currency: account.currency,
    isSystem: account.isSystem,
    isPostable: account.isPostable,
    isActive: replay?.isActive ?? account.isActive,
    systemKey: account.systemKey,
    templateVersion: account.templateVersion,
    governanceVersion: replay?.governanceVersion ?? account.governanceVersion,
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
          const result = await operation(transaction)
          await assertDeferredConstraints(transaction)
          return result
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (!isRetryableConflict(error) || attempt === maxAttempts) {
        if (isRetryableConflict(error)) {
          throw new FinancialOperationsError('FINANCIAL_CONCURRENCY_CONFLICT')
        }
        throw error
      }
    }
  }
  throw new FinancialOperationsError('FINANCIAL_CONCURRENCY_CONFLICT')
}

export function isRetryableFinancialOperationsConflict(error: unknown): boolean {
  return isRetryableConflict(error)
}

function isRetryableConflict(error: unknown): boolean {
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
  if (code !== 'P2002' || !meta || typeof meta !== 'object') return false
  const target = Reflect.get(meta, 'target')
  const constraint = Reflect.get(meta, 'constraint')
  const normalized = Array.isArray(target)
    ? target
        .filter((value): value is string => typeof value === 'string')
        .sort()
        .join('|')
    : target
  return (
    normalized === 'idempotencyKey|tenantId' ||
    normalized === 'ledgerAccountId|version' ||
    normalized === 'LedgerGovernance_tenant_idempotency_key' ||
    normalized === 'LedgerGovernance_account_version_key' ||
    constraint === 'LedgerGovernance_tenant_idempotency_key' ||
    constraint === 'LedgerGovernance_account_version_key'
  )
}
