import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  captureJournal,
  evaluateSettlement,
  PaymentAggregateState,
  SettlementDecision,
  type PaymentAttemptState,
  type PaymentProviderAdapter,
  type PaymentProviderAdapterRegistry,
  type PaymentProviderAdapterSpiVersion,
  type ProviderSecretResolver,
  type ProviderVerificationResult,
} from '@alo-noon/domain'

import type { PaymentLedgerService } from './payment-ledger.js'
import type { PaymentProviderService } from './payment-provider.js'

/**
 * Turns a recorded gateway callback into money, or refuses to.
 *
 * The callback route deliberately concludes nothing: everything in a customer's
 * return redirect is attacker-controllable. This is where the truth is
 * established, by asking the gateway directly over a server-to-server call, and
 * where the answer is checked against what the payment is actually for before
 * anything is captured.
 *
 * Structure follows ADR-0010: the external call happens outside every database
 * transaction, with durable state on both sides of it. Nothing here is
 * exactly-once — a crash mid-flight leaves work for the next attempt — so every
 * step is keyed and replay-safe, and the sequence converges on re-run.
 *
 * Ordering is chosen so that a crash between steps is recoverable rather than
 * corrupting. The money-moving step (capture) runs before the bookkeeping that
 * records it as done: a crash after capture leaves an attempt not yet marked
 * VERIFIED, which the next run fixes, whereas the reverse order could leave a
 * payment marked settled that was never captured.
 */
export type SettlementStatus = 'SETTLED' | 'REJECTED' | 'PENDING' | 'QUARANTINED'

export interface SettlementResult {
  status: SettlementStatus
  reasonCode: string
  callbackReceiptId: string
  paymentAttemptId: string | null
  paymentId: string | null
  /** Only present when the payment was captured by this run or an earlier one. */
  capturedAmount: bigint | null
}

export interface SettleCallbackCommand {
  callbackReceiptId: string
}

export interface PaymentSettlementService {
  settle(
    tenantId: string,
    command: SettleCallbackCommand,
    now: Date,
    correlationId: string,
  ): Promise<SettlementResult>
  /**
   * Settles every receipt still awaiting a verdict, oldest first. A customer who
   * closes the tab before the redirect completes, or a callback that arrived
   * while the gateway was unreachable, is only ever recovered by this sweep.
   */
  settlePending(
    tenantId: string,
    limit: number,
    now: Date,
    correlationId: string,
  ): Promise<SettlementResult[]>
}

export class PaymentSettlementError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PaymentSettlementError'
  }
}

export interface PrismaPaymentSettlementOptions {
  adapterRegistry: PaymentProviderAdapterRegistry
  secretResolver: ProviderSecretResolver
  ledgerService: PaymentLedgerService
  /**
   * Used only to drive the attempt to its settled state. That write needs audit
   * and outbox records a deferred constraint checks at commit, and the provider
   * service is where that pairing is already implemented correctly.
   */
  providerService: PaymentProviderService
  verificationTimeoutMs?: number
  /** Test seam for asserting that a crash between steps stays recoverable. */
  afterVerification?: (result: ProviderVerificationResult) => Promise<void>
}

const DEFAULT_VERIFICATION_TIMEOUT_MS = 15_000
const MAX_SWEEP_LIMIT = 100

const receiptInclude = {
  providerConfiguration: { include: { credentialReference: true } },
} satisfies Prisma.PaymentCallbackReceiptInclude

export function createPrismaPaymentSettlementService(
  prisma: PrismaClient,
  options: PrismaPaymentSettlementOptions,
): PaymentSettlementService {
  const timeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS

  async function settleOne(
    tenantId: string,
    callbackReceiptId: string,
    now: Date,
    correlationId: string,
  ): Promise<SettlementResult> {
    const context = await loadContext(prisma, tenantId, callbackReceiptId)

    // Already decided. Returning the recorded verdict rather than asking the
    // gateway again keeps a refreshing customer, a retrying gateway, and the
    // recovery sweep from racing each other over one receipt.
    if (context.settled) return context.settled

    const verifyCallback = resolveAdapter(options.adapterRegistry, context)
    const credential = await options.secretResolver
      .resolve(
        context.receipt.providerConfiguration.credentialReference.reference,
        tenantId,
        context.receipt.providerConfiguration.providerCode,
      )
      .catch(() => {
        throw new PaymentSettlementError('SETTLEMENT_CREDENTIAL_UNAVAILABLE')
      })

    let verification: ProviderVerificationResult
    try {
      verification = await verifyCallback({
        canonicalBody: new TextEncoder().encode(JSON.stringify(context.receipt.safePayload)),
        approvedHeaders: {},
        receivedAt: context.receipt.receivedAt,
        configuration: configurationView(tenantId, context),
        credential,
        ...(context.attempt?.providerReference && {
          providerReference: context.attempt.providerReference,
        }),
        ...(context.payment && { expectedAmount: context.payment.amount }),
        ...(context.attempt && { paymentAttemptId: context.attempt.id }),
        timeoutMs,
      })
    } catch {
      // An unreachable gateway is not a verdict. Leaving the receipt untouched
      // is what lets the sweep try again instead of stranding a real payment.
      throw new PaymentSettlementError('SETTLEMENT_PROVIDER_UNREACHABLE')
    } finally {
      credential.dispose()
    }
    await options.afterVerification?.(verification)

    if (!context.attempt || !context.payment) {
      // A callback we cannot tie to an attempt is not evidence of anything, and
      // must never be allowed to reach the capture path.
      return recordVerdict(options.providerService, tenantId, context, {
        status: 'QUARANTINED',
        reasonCode: 'SETTLEMENT_ATTEMPT_NOT_FOUND',
        now,
        correlationId,
      })
    }

    const evaluation = evaluateSettlement({
      expectedAmount: context.payment.amount,
      expectedProviderReference: context.attempt.providerReference,
      verification,
    })

    if (evaluation.decision === SettlementDecision.RETRY) {
      // Deliberately writes nothing: the receipt stays unprocessed so the sweep
      // picks it up again.
      return {
        status: 'PENDING',
        reasonCode: evaluation.reasonCode,
        callbackReceiptId: context.receipt.id,
        paymentAttemptId: context.attempt.id,
        paymentId: context.payment.id,
        capturedAmount: null,
      }
    }

    if (evaluation.decision === SettlementDecision.SETTLE) {
      const amount = evaluation.settledAmount!
      await capturePayment(options.ledgerService, tenantId, context, amount, now, correlationId)
      await settleAttempt(
        options.providerService,
        tenantId,
        context,
        'VERIFIED',
        now,
        correlationId,
      )
      return recordVerdict(options.providerService, tenantId, context, {
        status: 'SETTLED',
        reasonCode: evaluation.reasonCode,
        capturedAmount: amount,
        now,
        correlationId,
      })
    }

    // REJECT and QUARANTINE both stop here without capturing. They differ in
    // what they mean: REJECT is the gateway's own verdict and is terminal for
    // the attempt; QUARANTINE means the gateway's answer could not be
    // reconciled, which is an operator problem, not a customer one.
    await settleAttempt(options.providerService, tenantId, context, 'REJECTED', now, correlationId)
    return recordVerdict(options.providerService, tenantId, context, {
      status: evaluation.decision === SettlementDecision.REJECT ? 'REJECTED' : 'QUARANTINED',
      reasonCode: evaluation.reasonCode,
      now,
      correlationId,
    })
  }

  return {
    async settle(tenantId, command, now, correlationId) {
      return settleOne(tenantId, command.callbackReceiptId, now, correlationId)
    },

    async settlePending(tenantId, limit, now, correlationId) {
      const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_SWEEP_LIMIT)
      const pending = await withTenantRead(prisma, tenantId, async (transaction) =>
        transaction.paymentCallbackReceipt.findMany({
          where: { tenantId, processingStatus: 'RECEIVED', processingIdempotencyKey: null },
          orderBy: { receivedAt: 'asc' },
          take: bounded,
          select: { id: true },
        }),
      )

      const results: SettlementResult[] = []
      for (const receipt of pending) {
        try {
          results.push(await settleOne(tenantId, receipt.id, now, correlationId))
        } catch (error) {
          // One unreachable gateway or one poisoned receipt must not stop the
          // sweep from settling everything else that is waiting.
          results.push({
            status: 'PENDING',
            reasonCode:
              error instanceof PaymentSettlementError ? error.code : 'SETTLEMENT_SWEEP_FAILED',
            callbackReceiptId: receipt.id,
            paymentAttemptId: null,
            paymentId: null,
            capturedAmount: null,
          })
        }
      }
      return results
    },
  }
}

interface SettlementContext {
  receipt: Prisma.PaymentCallbackReceiptGetPayload<{ include: typeof receiptInclude }>
  attempt: {
    id: string
    state: PaymentAttemptState
    version: number
    providerReference: string | null
  } | null
  payment: { id: string; amount: bigint; state: PaymentAggregateState } | null
  /** Set when this receipt already carries a verdict from an earlier run. */
  settled: SettlementResult | null
}

async function loadContext(
  prisma: PrismaClient,
  tenantId: string,
  callbackReceiptId: string,
): Promise<SettlementContext> {
  return withTenantRead(prisma, tenantId, async (transaction) => {
    const receipt = await transaction.paymentCallbackReceipt.findFirst({
      where: { id: callbackReceiptId, tenantId },
      include: receiptInclude,
    })
    if (!receipt) throw new PaymentSettlementError('CALLBACK_RECEIPT_NOT_FOUND')

    // The gateway's own transaction reference is what we stored on the attempt
    // at initialization, and what the redirect carries back. It is the only
    // link between a callback and a payment, and it is unique per configuration.
    const attemptRecord = receipt.paymentAttemptId
      ? await transaction.paymentAttempt.findFirst({
          where: { id: receipt.paymentAttemptId, tenantId },
          include: { payment: true },
        })
      : await transaction.paymentAttempt.findFirst({
          where: {
            tenantId,
            providerConfigurationId: receipt.providerConfigurationId,
            providerReference: receipt.externalEventId,
          },
          include: { payment: true },
        })

    const attempt = attemptRecord
      ? {
          id: attemptRecord.id,
          state: attemptRecord.state,
          version: attemptRecord.version,
          providerReference: attemptRecord.providerReference,
        }
      : null
    const payment = attemptRecord
      ? {
          id: attemptRecord.payment.id,
          amount: attemptRecord.payment.amount,
          state: attemptRecord.payment.state as PaymentAggregateState,
        }
      : null

    return {
      receipt,
      attempt,
      payment,
      settled: priorVerdict(receipt, attemptRecord?.payment.state, payment),
    }
  })
}

/**
 * The verdict already recorded for this receipt, if any.
 *
 * A processed receipt is authoritative even when the payment shows as captured
 * and vice versa: both are written by the same run, and reporting either alone
 * would let a retry re-ask the gateway for a decision already made.
 */
function priorVerdict(
  receipt: { id: string; processingStatus: string; processingFingerprint: string | null },
  paymentState: string | undefined,
  payment: SettlementContext['payment'],
): SettlementResult | null {
  if (paymentState === PaymentAggregateState.CAPTURED) {
    return {
      status: 'SETTLED',
      reasonCode: 'SETTLEMENT_ALREADY_CONFIRMED',
      callbackReceiptId: receipt.id,
      paymentAttemptId: null,
      paymentId: payment?.id ?? null,
      capturedAmount: payment?.amount ?? null,
    }
  }
  if (receipt.processingStatus === 'RECEIVED') return null
  return {
    status: receipt.processingStatus === 'PROCESSED' ? 'SETTLED' : 'REJECTED',
    // The original reason is on the audit event; repeating a generic code here
    // is honest about the fact that this run did not re-derive one.
    reasonCode: 'SETTLEMENT_ALREADY_DECIDED',
    callbackReceiptId: receipt.id,
    paymentAttemptId: null,
    paymentId: payment?.id ?? null,
    capturedAmount: null,
  }
}

/**
 * Walks the Payment aggregate to CAPTURED and posts the journal.
 *
 * Initialization leaves the aggregate at CREATED — a provider accepting a
 * request is not authorization — so the hops to PENDING and AUTHORIZED happen
 * here, each keyed off this receipt so a re-run replays instead of double
 * posting. `capture` itself refuses a second posting for the same payment.
 */
async function capturePayment(
  ledger: PaymentLedgerService,
  tenantId: string,
  context: SettlementContext,
  amount: bigint,
  now: Date,
  correlationId: string,
): Promise<void> {
  const paymentId = context.payment!.id
  const key = (step: string) => settlementKey(context.receipt.id, step)

  for (const target of [PaymentAggregateState.PENDING, PaymentAggregateState.AUTHORIZED] as const) {
    await ledger.transition(
      tenantId,
      { paymentId, to: target, actor: 'SYSTEM', idempotencyKey: key(target.toLowerCase()) },
      now,
      correlationId,
    )
  }

  await ledger.capture(
    tenantId,
    { paymentId, idempotencyKey: key('capture'), entries: captureJournal(amount) },
    now,
    correlationId,
  )
}

/**
 * Drives the attempt to its settled state through the provider service, which is
 * the only path allowed to assert VERIFIED and the only one that writes the
 * audit and outbox records the attempt's deferred constraint requires.
 *
 * An attempt with no linked payment is skipped: there is nothing to settle.
 */
async function settleAttempt(
  providerService: PaymentProviderService,
  tenantId: string,
  context: SettlementContext,
  outcome: 'VERIFIED' | 'REJECTED',
  now: Date,
  correlationId: string,
): Promise<void> {
  if (!context.attempt) return
  await providerService.settleAttempt(
    tenantId,
    {
      paymentAttemptId: context.attempt.id,
      outcome,
      normalizedOutcome: outcome === 'VERIFIED' ? 'VERIFIED' : 'REJECTED',
      idempotencyKey: settlementKey(context.receipt.id, `attempt-${outcome.toLowerCase()}`),
    },
    now,
    correlationId,
  )
}

interface VerdictInput {
  status: SettlementStatus
  reasonCode: string
  capturedAmount?: bigint
  now: Date
  correlationId: string
}

/**
 * Records the verdict on the receipt through the provider service, which owns
 * that aggregate and writes the audit and outbox records its deferred constraint
 * checks at commit.
 *
 * Runs after capture rather than with it, because capture opens its own
 * transaction. A crash in between leaves a captured payment whose receipt is not
 * yet marked; the next run sees the payment already captured, reports SETTLED,
 * and finishes the bookkeeping. The reverse order could mark a payment settled
 * that no journal backs.
 */
async function recordVerdict(
  providerService: PaymentProviderService,
  tenantId: string,
  context: SettlementContext,
  input: VerdictInput,
): Promise<SettlementResult> {
  await providerService.concludeCallback(
    tenantId,
    {
      callbackReceiptId: context.receipt.id,
      verified: input.status === 'SETTLED',
      reasonCode: input.reasonCode,
      idempotencyKey: settlementKey(context.receipt.id, 'verdict'),
    },
    input.now,
    input.correlationId,
  )

  return {
    status: input.status,
    reasonCode: input.reasonCode,
    callbackReceiptId: context.receipt.id,
    paymentAttemptId: context.attempt?.id ?? null,
    paymentId: context.payment?.id ?? null,
    capturedAmount: input.capturedAmount ?? null,
  }
}

/**
 * Resolves the adapter's verification entry point, narrowed to a callable so the
 * rest of the flow cannot reach a configuration no adapter can actually settle.
 */
function resolveAdapter(
  registry: PaymentProviderAdapterRegistry,
  context: SettlementContext,
): NonNullable<PaymentProviderAdapter['verifyCallback']> {
  const configuration = context.receipt.providerConfiguration
  let adapter: PaymentProviderAdapter
  try {
    adapter = registry.resolve({
      providerCode: configuration.providerCode,
      adapterVersion: configuration.adapterVersion,
      adapterSpiVersion: configuration.adapterSpiVersion as PaymentProviderAdapterSpiVersion,
      environment: configuration.environment,
      capability: 'CALLBACK_VERIFICATION',
    })
  } catch {
    throw new PaymentSettlementError('SETTLEMENT_ADAPTER_UNAVAILABLE')
  }
  if (!adapter.verifyCallback) throw new PaymentSettlementError('SETTLEMENT_ADAPTER_UNAVAILABLE')
  return adapter.verifyCallback.bind(adapter)
}

function configurationView(tenantId: string, context: SettlementContext) {
  const configuration = context.receipt.providerConfiguration
  return {
    id: configuration.id,
    tenantId,
    providerCode: configuration.providerCode,
    adapterVersion: configuration.adapterVersion,
    adapterSpiVersion: configuration.adapterSpiVersion as PaymentProviderAdapterSpiVersion,
    environment: configuration.environment,
    merchantReference: configuration.merchantReference,
    callbackPolicy: 'SIGNED_ONLY' as const,
    capabilities: configuration.capabilities,
    credentialReference: configuration.credentialReference.reference,
  }
}

/**
 * Derives a stable idempotency key for one step of settling one receipt. The
 * receipt id is the natural anchor: every step of a settlement belongs to
 * exactly one callback, and re-running produces the same keys.
 */
function settlementKey(receiptId: string, step: string): string {
  return createHash('sha256').update(`settlement:${receiptId}:${step}`).digest('hex')
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
