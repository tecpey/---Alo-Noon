import {
  financialTransactionPostedEventPayloadSchema,
  paymentCreatedEventPayloadSchema,
  paymentStateChangedEventPayloadSchema,
  type FinancialTransactionSummary,
  type PaymentSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  evaluateRefund,
  FinancialTransactionType,
  initializePayment,
  orderPaymentStateFor,
  PaymentAggregateState,
  postDoubleEntry,
  RefundDecision,
  refundJournal,
  transitionPayment,
  type LedgerEntrySide,
  type PaymentTransitionActor,
} from '@alo-noon/domain'

import { assertDeferredConstraints } from './deferred-constraints.js'

// A payment carries at most two postings now: the capture, and the refund that
// reverses it. Ordered so the capture reads first, which is the order they
// happened in.
const paymentInclude = {
  financialTransactions: {
    include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
    orderBy: { postedAt: 'asc' },
  },
} satisfies Prisma.PaymentInclude
type PaymentRecord = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>
type FinancialTransactionRecord = PaymentRecord['financialTransactions'][number]

function postingOf(
  payment: PaymentRecord,
  type: 'PAYMENT_CAPTURE' | 'PAYMENT_REFUND',
): FinancialTransactionRecord | undefined {
  return payment.financialTransactions.find((posting) => posting.type === type)
}

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

export interface RefundPaymentCommand {
  paymentId: string
  /**
   * What the operator asked to send back. Checked against what was actually
   * captured rather than trusted: a refund is the one place where a number
   * typed by a person moves money out.
   */
  requestedAmount: bigint
  actorId: string
  idempotencyKey: string
}

export interface PaymentRefundResult {
  decision: RefundDecision
  reasonCode: string
  payment: PaymentSummary
  /** Present only when this run posted the reversal. */
  transaction: FinancialTransactionSummary | null
}

/** A balanced journal somebody else authored, and what it is a posting of. */
export interface LedgerPostingCommand {
  paymentId: string
  orderId?: string
  type: FinancialTransactionType
  amount: bigint
  lines: readonly { accountCode: string; side: 'DEBIT' | 'CREDIT'; amount: bigint }[]
  idempotencyKey: string
  correlationId: string
  occurredAt: Date
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
  /**
   * Sends a captured payment back to the customer.
   *
   * Never automatic: only staff reach this, and the domain refuses anything but
   * the exact captured amount. Returns a decision rather than throwing when
   * there is nothing to refund, because cancelling an unpaid order is a normal
   * thing to do and costs nothing.
   */
  refund(
    tenantId: string,
    command: RefundPaymentCommand,
    now: Date,
    correlationId: string,
  ): Promise<PaymentRefundResult>
  /**
   * Posts a balanced journal that this service does not itself author.
   *
   * The wallet needs it: a top-up and a spend are double-entry postings against
   * a payment, but neither is a capture or a refund, and neither belongs to the
   * payment state machine above. Reimplementing the posting elsewhere would
   * mean a second place that has to resolve accounts, respect tenant scoping
   * and satisfy the database's balance guard — and the second place is the one
   * that eventually posts into an inactive account.
   *
   * The caller owns the journal and its idempotency key. This owns getting it
   * into the ledger correctly, or refusing.
   */
  post(tenantId: string, command: LedgerPostingCommand): Promise<void>
  /**
   * The same posting, inside a transaction the caller already holds.
   *
   * For a caller whose other write must not be separable from this one: the
   * wallet credits a balance in the same breath as recording the money that
   * funded it, and a balance credited without a posting is money the platform
   * is holding that its books do not mention.
   *
   * The caller is responsible for having set `app.tenant_id` on that
   * transaction, which is what row-level security reads.
   */
  postWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: LedgerPostingCommand,
  ): Promise<void>
  /**
   * Reads a payment back for the customer who owns it.
   *
   * The screen a gateway returns to needs this: the return redirect proves
   * nothing — settlement decides from the gateway's own answer — so the app
   * asks what actually happened rather than trusting the URL it landed on.
   */
  findForCustomer(
    tenantId: string,
    customerId: string,
    paymentId: string,
  ): Promise<PaymentSummary | null>
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

/**
 * The order a payment is for, or a refusal.
 *
 * Every operation below — transition, capture, refund — moves an order's
 * payment state alongside the payment's own. A wallet top-up has no order to
 * move, and reaching these paths with one would mean a top-up silently marking
 * somebody's last order paid. Refusing here is what makes the assertions that
 * follow honest rather than hopeful.
 */
function orderOf(payment: { orderId: string | null }): string {
  if (!payment.orderId) throw new PaymentLedgerError('PAYMENT_NOT_FOR_ORDER')
  return payment.orderId
}

/**
 * The posting itself, inside whatever transaction the caller is already in.
 *
 * Separated from `post` so a caller with more to do in the same breath — the
 * wallet, crediting a balance the moment it records the money that funded it —
 * can have both writes commit or neither.
 */
async function postJournal(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  command: LedgerPostingCommand,
): Promise<void> {
  if (command.amount <= 0n) {
    throw new PaymentLedgerError('INVALID_LEDGER_POSTING')
  }
  const debits = command.lines
    .filter((line) => line.side === 'DEBIT')
    .reduce((total, line) => total + line.amount, 0n)
  const credits = command.lines
    .filter((line) => line.side === 'CREDIT')
    .reduce((total, line) => total + line.amount, 0n)
  // Checked here as well as by the database. The trigger is the guarantee; this
  // is the error message somebody can act on, raised before a row is written
  // rather than as a constraint violation on the way out.
  if (debits !== credits || debits !== command.amount) {
    throw new PaymentLedgerError('INVALID_LEDGER_POSTING')
  }

  const replay = await transaction.financialTransaction.findFirst({
    where: { tenantId, idempotencyKey: command.idempotencyKey },
    select: { id: true },
  })
  if (replay) return

  const codes = [...new Set(command.lines.map((line) => line.accountCode))]
  const accounts = await transaction.ledgerAccount.findMany({
    where: { tenantId, code: { in: codes }, isActive: true, isPostable: true, currency: 'IRR' },
  })
  const accountsByCode = new Map(accounts.map((account) => [account.code, account]))
  // An account that is missing, retired or not postable means the chart is not
  // what this journal assumes. Refused rather than improvised: the alternative
  // is money posted somewhere nobody expects.
  if (accountsByCode.size !== codes.length) {
    throw new PaymentLedgerError('LEDGER_ACCOUNT_NOT_FOUND')
  }

  await transaction.financialTransaction.create({
    data: {
      tenantId,
      // Connected rather than assigned: the nested entry creates put Prisma in
      // checked mode, where a relation is named by connect and a bare foreign
      // key is rejected.
      payment: { connect: { id: command.paymentId } },
      ...(command.orderId && { order: { connect: { id: command.orderId } } }),
      type: command.type,
      amount: command.amount,
      currency: 'IRR',
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
      occurredAt: command.occurredAt,
      postedAt: command.occurredAt,
      entries: {
        create: command.lines.map((line, index) => ({
          tenantId,
          ledgerAccountId: accountsByCode.get(line.accountCode)!.id,
          sequence: index + 1,
          side: line.side,
          amount: line.amount,
          currency: 'IRR' as const,
        })),
      },
    },
  })
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
            // Read from the order, never from the request. How an order is paid
            // for is settled when the customer priced their basket against a
            // city that allows cash; letting a payment declare its own method
            // would let anyone opt out of the gateway by asking.
            method: order.paymentMethod,
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
            where: { id: orderOf(payment) },
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

    async findForCustomer(tenantId, customerId, paymentId) {
      // A read, so ReadCommitted: polling the return screen must never contend
      // with the settlement that is trying to capture the same payment.
      return prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          // ownership-established: filtered on the session's customerId, so a
          // payment belonging to anyone else reads as absent rather than as a
          // refusal that confirms it exists.
          const payment = await transaction.payment.findFirst({
            where: { id: paymentId, tenantId, customerId },
            include: paymentInclude,
          })
          return payment ? mapPayment(payment) : null
        },
        { isolationLevel: 'ReadCommitted' },
      )
    },

    async post(tenantId, command) {
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        await postJournal(transaction, tenantId, command)
        await assertDeferredConstraints(transaction)
      })
    },

    async postWithin(transaction, tenantId, command) {
      await postJournal(transaction, tenantId, command)
    },

    async refund(tenantId, command, now, correlationId) {
      return serializableWithRetry(prisma, tenantId, maxAttempts, async (transaction) => {
        await lockPayment(transaction, tenantId, command.paymentId)
        const payment = await loadPayment(transaction, tenantId, command.paymentId)
        const capture = postingOf(payment, 'PAYMENT_CAPTURE')

        // The domain decides, from what was captured rather than from what was
        // asked for. Everything below simply carries out its answer.
        const evaluation = evaluateRefund({
          paymentState: payment.state,
          capturedAmount: capture?.amount ?? 0n,
          requestedAmount: command.requestedAmount,
        })
        if (evaluation.decision !== RefundDecision.REFUND || evaluation.amount === null) {
          return {
            decision: evaluation.decision,
            reasonCode: evaluation.reasonCode,
            payment: mapPayment(payment),
            transaction: null,
          }
        }

        const amount = evaluation.amount
        const lines = refundJournal(amount)
        const codes = [...new Set(lines.map((line) => line.accountCode))]
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

        // Both rules run before anything is written: the transition the payment
        // is allowed to make, and the balance of the journal that records it.
        transitionPayment({
          paymentId: payment.id,
          from: payment.state,
          to: PaymentAggregateState.REFUNDED,
          actor: 'STAFF',
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
        })
        postDoubleEntry({
          paymentId: payment.id,
          orderId: orderOf(payment),
          type: FinancialTransactionType.PAYMENT_REFUND,
          amount,
          currency: payment.currency,
          idempotencyKey: command.idempotencyKey,
          correlationId,
          occurredAt: now,
          lines: lines.map((line) => ({
            accountId: accountsByCode.get(line.accountCode)!.id,
            side: line.side,
            amount: line.amount,
            currency: 'IRR' as const,
          })),
        })

        const nextVersion = payment.version + 1
        await transaction.paymentStateTransition.create({
          data: {
            tenantId,
            paymentId: payment.id,
            fromState: payment.state,
            toState: 'REFUNDED',
            actorType: 'STAFF',
            actorId: command.actorId,
            version: nextVersion,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
          },
        })
        // ownership-established: a staff refund on a payment already loaded
        // tenant-scoped and locked; authority is the permission check the
        // caller made before reaching this service.
        await transaction.payment.update({
          where: { id: payment.id },
          data: { state: 'REFUNDED', version: nextVersion },
        })
        // ownership-established: the order backing that same staff-refunded payment.
        await transaction.order.update({
          where: { id: orderOf(payment) },
          data: { paymentState: 'REFUNDED' },
        })

        const posting = await transaction.financialTransaction.create({
          data: {
            tenantId,
            paymentId: payment.id,
            orderId: orderOf(payment),
            type: 'PAYMENT_REFUND',
            amount,
            currency: payment.currency,
            idempotencyKey: command.idempotencyKey,
            correlationId,
            occurredAt: now,
            postedAt: now,
            entries: {
              create: lines.map((line, index) => ({
                tenantId,
                ledgerAccountId: accountsByCode.get(line.accountCode)!.id,
                sequence: index + 1,
                side: line.side,
                amount: line.amount,
                currency: 'IRR' as const,
              })),
            },
          },
          include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
        })

        return {
          decision: evaluation.decision,
          reasonCode: evaluation.reasonCode,
          payment: mapPayment(await loadPayment(transaction, tenantId, payment.id)),
          transaction: mapFinancialTransaction(posting),
        }
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
        if (postingOf(payment, 'PAYMENT_CAPTURE')) {
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
          orderId: orderOf(payment),
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
          where: { id: orderOf(payment) },
          data: { paymentState: 'PAID' },
        })
        const financialTransaction = await transaction.financialTransaction.create({
          data: {
            tenantId,
            paymentId: payment.id,
            orderId: orderOf(payment),
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
    ...(payment.orderId && { orderId: payment.orderId }),
    purpose: payment.purpose,
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
    ...(transaction.orderId && { orderId: transaction.orderId }),
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
          await assertDeferredConstraints(transaction)
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
