import {
  financialTransactionPostedEventPayloadSchema,
  paymentCreatedEventPayloadSchema,
  paymentStateChangedEventPayloadSchema,
  type FinancialTransactionSummary,
  type PaymentSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  FinancialTransactionType,
  initializePayment,
  orderPaymentStateFor,
  PaymentAggregateState,
  postDoubleEntry,
  transitionPayment,
  type LedgerEntrySide,
  type PaymentTransitionActor,
} from '@alo-noon/domain'

const paymentInclude = {
  financialTransaction: {
    include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
  },
} satisfies Prisma.PaymentInclude
type PaymentRecord = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>
type FinancialTransactionRecord = NonNullable<PaymentRecord['financialTransaction']>

export interface InitializePaymentCommand {
  orderId: string
  idempotencyKey: string
}

export interface TransitionPaymentCommand {
  paymentId: string
  to: PaymentAggregateState
  actor: PaymentTransitionActor
  actorId?: string
  idempotencyKey: string
}

export interface CapturePaymentCommand {
  paymentId: string
  idempotencyKey: string
  entries: readonly {
    accountCode: string
    side: LedgerEntrySide
    amount: bigint
  }[]
}

export interface PaymentCaptureResult {
  payment: PaymentSummary
  transaction: FinancialTransactionSummary
}

export interface PaymentLedgerService {
  initialize(
    tenantId: string,
    customerId: string,
    command: InitializePaymentCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentSummary>
  transition(
    tenantId: string,
    command: TransitionPaymentCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentSummary>
  capture(
    tenantId: string,
    command: CapturePaymentCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentCaptureResult>
}

export interface PrismaPaymentLedgerOptions {
  maxSerializationAttempts?: number
  beforeCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
}

export class PaymentLedgerError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function createPrismaPaymentLedgerService(
  prisma: PrismaClient,
  options: PrismaPaymentLedgerOptions = {},
): PaymentLedgerService {
  const maxAttempts = options.maxSerializationAttempts ?? 3

  return {
    async initialize(tenantId, customerId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.payment.findFirst({
          where: { tenantId, customerId, idempotencyKey: command.idempotencyKey },
          include: paymentInclude,
        })
        if (replay) {
          if (replay.orderId !== command.orderId) {
            throw new PaymentLedgerError('IDEMPOTENCY_KEY_CONFLICT')
          }
          return mapPayment(replay)
        }

        await transaction.$queryRaw`
          SELECT "id" FROM "Order"
          WHERE "id" = ${command.orderId}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE
        `
        const order = await transaction.order.findFirst({
          where: { id: command.orderId, tenantId, customerId },
          include: { payment: true },
        })
        if (!order) throw new PaymentLedgerError('ORDER_NOT_FOUND')
        if (order.payment) throw new PaymentLedgerError('PAYMENT_ALREADY_EXISTS')
        if (
          order.state !== 'PENDING_CONFIRMATION' ||
          order.paymentState !== 'NOT_STARTED' ||
          order.currency !== 'IRR' ||
          order.totalAmount <= 0n
        ) {
          throw new PaymentLedgerError('ORDER_NOT_PAYABLE')
        }

        initializePayment({
          orderId: order.id,
          customerId,
          amount: order.totalAmount,
          currency: order.currency,
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
        })
        const payment = await transaction.payment.create({
          data: {
            tenantId,
            orderId: order.id,
            customerId,
            amount: order.totalAmount,
            currency: order.currency,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            transitions: {
              create: {
                tenantId,
                fromState: null,
                toState: 'CREATED',
                actorType: 'SYSTEM',
                version: 1,
                idempotencyKey: command.idempotencyKey,
                correlationId,
                occurredAt: now,
              },
            },
          },
          include: paymentInclude,
        })
        const eventPayload = paymentCreatedEventPayloadSchema.parse({
          paymentId: payment.id,
          orderId: order.id,
          customerId,
          state: 'CREATED',
          amount: order.totalAmount.toString(),
          currency: order.currency,
        })
        await Promise.all([
          transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: 'SYSTEM',
              action: 'payment.created',
              entityType: 'payment',
              entityId: payment.id,
              summary: 'Payment initialized from the authoritative order total',
              correlationId,
              metadata: { orderId: order.id },
              occurredAt: now,
            },
          }),
          transaction.domainEventOutbox.create({
            data: {
              tenantId,
              eventId: payment.id,
              name: 'payment.created',
              aggregateType: 'payment',
              aggregateId: payment.id,
              actorType: 'SYSTEM',
              correlationId,
              consentBasis: 'TRANSACTIONAL',
              payload: eventPayload,
              occurredAt: now,
            },
          }),
        ])
        await options.beforeCommit?.(transaction)
        return mapPayment(payment)
      })
    },

    async transition(tenantId, command, now, correlationId) {
      if (command.to === PaymentAggregateState.CAPTURED) {
        throw new PaymentLedgerError('CAPTURE_REQUIRES_LEDGER_POSTING')
      }
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.paymentStateTransition.findFirst({
          where: {
            tenantId,
            paymentId: command.paymentId,
            idempotencyKey: command.idempotencyKey,
          },
        })
        if (replay) {
          if (
            replay.toState !== command.to ||
            replay.actorType !== command.actor ||
            replay.actorId !== (command.actorId ?? null)
          ) {
            throw new PaymentLedgerError('IDEMPOTENCY_KEY_CONFLICT')
          }
          const payment = await loadPayment(transaction, tenantId, command.paymentId)
          return mapPayment(payment)
        }

        await lockPayment(transaction, tenantId, command.paymentId)
        const payment = await loadPayment(transaction, tenantId, command.paymentId)
        transitionPayment({
          paymentId: payment.id,
          from: payment.state,
          to: command.to,
          actor: command.actor,
          ...(command.actorId && { actorId: command.actorId }),
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
        })
        const nextVersion = payment.version + 1
        const transition = await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: payment.id,
            fromState: payment.state,
            toState: command.to,
            actorType: command.actor,
            ...(command.actorId && { actorId: command.actorId }),
            version: nextVersion,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
          },
        })
        // ownership-established: staff/system financial operation on a payment
        // already loaded tenant-scoped; authority is the actor check at the
        // service entry, not customer scoping.
        await Promise.all([
          transaction.payment.update({
            where: { id: payment.id },
            data: { state: command.to, version: nextVersion },
          }),
          transaction.order.update({
            where: { id: payment.orderId },
            data: { paymentState: orderPaymentStateFor(command.to) },
          }),
        ])
        await writeStateChangeRecords(
          transaction,
          tenantId,
          payment,
          transition.id,
          command.to,
          nextVersion,
          command.actor,
          command.actorId,
          correlationId,
          now,
        )
        await options.beforeCommit?.(transaction)
        return mapPayment(await loadPayment(transaction, tenantId, payment.id))
      })
    },

    async capture(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        const replay = await transaction.financialTransaction.findFirst({
          where: { tenantId, idempotencyKey: command.idempotencyKey },
          include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
        })
        if (replay) {
          if (!samePosting(replay, command)) {
            throw new PaymentLedgerError('IDEMPOTENCY_KEY_CONFLICT')
          }
          return {
            payment: mapPayment(await loadPayment(transaction, tenantId, replay.paymentId)),
            transaction: mapFinancialTransaction(replay),
          }
        }

        await lockPayment(transaction, tenantId, command.paymentId)
        const payment = await loadPayment(transaction, tenantId, command.paymentId)
        if (payment.financialTransaction) {
          throw new PaymentLedgerError('PAYMENT_ALREADY_CAPTURED')
        }
        transitionPayment({
          paymentId: payment.id,
          from: payment.state,
          to: PaymentAggregateState.CAPTURED,
          actor: 'SYSTEM',
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
        })

        const codes = [...new Set(command.entries.map((entry) => entry.accountCode))]
        const accounts = await transaction.ledgerAccount.findMany({
          where: {
            tenantId,
            code: { in: codes },
            isActive: true,
            isPostable: true,
            currency: 'IRR',
          },
        })
        const accountsByCode = new Map(accounts.map((account) => [account.code, account]))
        if (accounts.length !== codes.length) {
          throw new PaymentLedgerError('LEDGER_ACCOUNT_NOT_FOUND')
        }
        const journalLines = command.entries.map((entry) => ({
          accountId: accountsByCode.get(entry.accountCode)!.id,
          side: entry.side,
          amount: entry.amount,
          currency: 'IRR' as const,
        }))
        postDoubleEntry({
          paymentId: payment.id,
          orderId: payment.orderId,
          type: FinancialTransactionType.PAYMENT_CAPTURE,
          amount: payment.amount,
          currency: payment.currency,
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
          lines: journalLines,
        })

        const nextVersion = payment.version + 1
        const stateTransition = await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: payment.id,
            fromState: payment.state,
            toState: 'CAPTURED',
            actorType: 'SYSTEM',
            version: nextVersion,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
          },
        })
        // ownership-established: staff/system capture on a payment already loaded
        // tenant-scoped; authority is the actor check at the service entry.
        await transaction.payment.update({
          where: { id: payment.id },
          data: { state: 'CAPTURED', version: nextVersion },
        })
        // ownership-established: the order backing that same staff/system-captured payment.
        await transaction.order.update({
          where: { id: payment.orderId },
          data: { paymentState: 'PAID' },
        })
        const financialTransaction = await transaction.financialTransaction.create({
          data: {
            tenantId,
            paymentId: payment.id,
            orderId: payment.orderId,
            type: 'PAYMENT_CAPTURE',
            amount: payment.amount,
            currency: payment.currency,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
            postedAt: now,
            entries: {
              create: command.entries.map((entry, index) => ({
                tenantId,
                ledgerAccountId: accountsByCode.get(entry.accountCode)!.id,
                sequence: index + 1,
                side: entry.side,
                amount: entry.amount,
                currency: 'IRR',
              })),
            },
          },
          include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
        })
        await writeStateChangeRecords(
          transaction,
          tenantId,
          payment,
          stateTransition.id,
          'CAPTURED',
          nextVersion,
          'SYSTEM',
          undefined,
          correlationId,
          now,
        )
        const postingPayload = financialTransactionPostedEventPayloadSchema.parse({
          financialTransactionId: financialTransaction.id,
          paymentId: payment.id,
          orderId: payment.orderId,
          type: financialTransaction.type,
          amount: financialTransaction.amount.toString(),
          currency: financialTransaction.currency,
          entryCount: financialTransaction.entries.length,
        })
        await Promise.all([
          transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: 'SYSTEM',
              action: 'financial_transaction.posted',
              entityType: 'financial_transaction',
              entityId: financialTransaction.id,
              summary: 'Balanced payment capture journal posted',
              correlationId,
              metadata: { paymentId: payment.id, orderId: payment.orderId },
              occurredAt: now,
            },
          }),
          transaction.domainEventOutbox.create({
            data: {
              tenantId,
              eventId: financialTransaction.id,
              name: 'financial.transaction_posted',
              aggregateType: 'financial_transaction',
              aggregateId: financialTransaction.id,
              actorType: 'SYSTEM',
              correlationId,
              consentBasis: 'TRANSACTIONAL',
              payload: postingPayload,
              occurredAt: now,
            },
          }),
        ])
        await options.beforeCommit?.(transaction)
        return {
          payment: mapPayment(await loadPayment(transaction, tenantId, payment.id)),
          transaction: mapFinancialTransaction(financialTransaction),
        }
      })
    },
  }
}

async function writeStateChangeRecords(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  payment: PaymentRecord,
  transitionId: string,
  toState: PaymentAggregateState,
  version: number,
  actor: PaymentTransitionActor,
  actorId: string | undefined,
  correlationId: string,
  now: Date,
): Promise<void> {
  const payload = paymentStateChangedEventPayloadSchema.parse({
    paymentId: payment.id,
    orderId: payment.orderId,
    fromState: payment.state,
    toState,
    version,
  })
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId,
        actorType: actor,
        ...(actorId && { actorId }),
        action: 'payment.state_changed',
        entityType: 'payment',
        entityId: payment.id,
        summary: `Payment transitioned from ${payment.state} to ${toState}`,
        correlationId,
        metadata: { orderId: payment.orderId, fromState: payment.state, toState, version },
        occurredAt: now,
      },
    }),
    transaction.domainEventOutbox.create({
      data: {
        tenantId,
        eventId: transitionId,
        name: 'payment.state_changed',
        aggregateType: 'payment',
        aggregateId: payment.id,
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

async function lockPayment(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  paymentId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT "id" FROM "Payment"
    WHERE "id" = ${paymentId}::uuid AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE
  `
}

async function loadPayment(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  paymentId: string,
): Promise<PaymentRecord> {
  // ownership-established: internal helper for staff/system financial services,
  // which are authorized by actor rather than by customer ownership. Do not reuse
  // it for a customer-facing read without adding a customerId filter.
  const payment = await transaction.payment.findFirst({
    where: { id: paymentId, tenantId },
    include: paymentInclude,
  })
  if (!payment) throw new PaymentLedgerError('PAYMENT_NOT_FOUND')
  return payment
}

function samePosting(
  transaction: FinancialTransactionRecord,
  command: CapturePaymentCommand,
): boolean {
  return (
    transaction.paymentId === command.paymentId &&
    transaction.entries.length === command.entries.length &&
    transaction.entries.every((entry, index) => {
      const expected = command.entries[index]
      return (
        expected !== undefined &&
        entry.ledgerAccount.code === expected.accountCode &&
        entry.side === expected.side &&
        entry.amount === expected.amount
      )
    })
  )
}

function mapPayment(payment: PaymentRecord): PaymentSummary {
  return {
    id: payment.id,
    publicId: payment.publicId,
    orderId: payment.orderId,
    customerId: payment.customerId,
    state: payment.state,
    amount: { amount: payment.amount.toString(), currency: payment.currency },
    version: payment.version,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  }
}

function mapFinancialTransaction(
  transaction: FinancialTransactionRecord,
): FinancialTransactionSummary {
  return {
    id: transaction.id,
    paymentId: transaction.paymentId,
    orderId: transaction.orderId,
    type: transaction.type,
    amount: { amount: transaction.amount.toString(), currency: transaction.currency },
    correlationId: transaction.correlationId,
    occurredAt: transaction.occurredAt.toISOString(),
    postedAt: transaction.postedAt.toISOString(),
    entries: transaction.entries.map((entry) => ({
      id: entry.id,
      accountId: entry.ledgerAccountId,
      accountCode: entry.ledgerAccount.code,
      sequence: entry.sequence,
      side: entry.side,
      amount: { amount: entry.amount.toString(), currency: entry.currency },
    })),
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
          // Prisma 5 can resolve an interactive transaction callback even when a
          // deferred PostgreSQL constraint subsequently rejects COMMIT. Evaluate
          // all financial guards before returning a result to the caller.
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
          return result
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (!isRetryableConflict(error) || attempt === maxAttempts) {
        if (isRetryableConflict(error)) {
          throw new PaymentLedgerError('PAYMENT_CONCURRENCY_CONFLICT')
        }
        throw error
      }
    }
  }
  throw new PaymentLedgerError('PAYMENT_CONCURRENCY_CONFLICT')
}

export function isRetryablePaymentConflict(error: unknown): boolean {
  return isRetryableConflict(error)
}

function isRetryableConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  if (code === 'P2034' || code === '40001') return true
  if (code === 'P2002') return isRetryablePaymentUniqueRace(error)
  const meta = Reflect.get(error, 'meta')
  return (
    code === 'P2010' &&
    typeof meta === 'object' &&
    meta !== null &&
    Reflect.get(meta, 'code') === '40001'
  )
}

const retryablePaymentUniqueTargets = new Set([
  'customerId|idempotencyKey|tenantId',
  'idempotencyKey|paymentId|tenantId',
  'idempotencyKey|tenantId',
  'orderId',
  'paymentId',
  'paymentId|version',
])

const retryablePaymentUniqueConstraints = new Set([
  'Payment_orderId_key',
  'Payment_tenant_customer_idempotency_key',
  'PaymentTransition_scoped_idempotency_key',
  'PaymentTransition_payment_version_key',
  'FinancialTransaction_paymentId_key',
  'FinancialTransaction_tenant_idempotency_key',
])

function isRetryablePaymentUniqueRace(error: object): boolean {
  const meta = Reflect.get(error, 'meta')
  if (!meta || typeof meta !== 'object') return false

  const target = Reflect.get(meta, 'target')
  if (Array.isArray(target) && target.every((field) => typeof field === 'string')) {
    return retryablePaymentUniqueTargets.has([...target].sort().join('|'))
  }
  if (typeof target === 'string') {
    return retryablePaymentUniqueConstraints.has(target)
  }

  const constraint = Reflect.get(meta, 'constraint')
  return typeof constraint === 'string' && retryablePaymentUniqueConstraints.has(constraint)
}
