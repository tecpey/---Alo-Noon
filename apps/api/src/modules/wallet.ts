import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  walletTopUpCreateSchema,
  type ErrorEnvelope,
  type ResponseMeta,
  type PaymentSummary,
  type WalletEntrySummary,
  type WalletSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  applyWalletMovement,
  PaymentAggregateState,
  topUpRefusalMessage,
  validateTopUpAmount,
  walletSpendJournal,
  walletTopUpJournal,
  type WalletEntryKind,
} from '@alo-noon/domain'

import { authenticatedCustomer } from './commerce.js'
import { assertDeferredConstraints } from './deferred-constraints.js'
import type { AuthDependencies } from './auth.js'
import type { PaymentLedgerService } from './payment-ledger.js'

/**
 * The balance a customer charges and spends.
 *
 * Every movement is two writes that must not come apart: the balance on the
 * wallet, and the entry that says what it became. They happen in one
 * transaction with the row locked, because a balance read in one statement and
 * written in another is a balance two concurrent orders can both spend.
 *
 * The lock is `SELECT ... FOR UPDATE` rather than an optimistic version check.
 * Both are correct; this one is chosen because the contended case here is a
 * customer double-tapping, and a retry loop would turn that into two attempts
 * that both eventually succeed. Waiting is the behaviour that matches what a
 * person meant.
 *
 * Four things move a balance and they are all here: money arriving from a
 * gateway, money leaving for an order, and the two halves of a transfer. Each
 * one either commits with whatever else it belongs to — a ledger posting, a
 * capture, the other half of a transfer — or does not happen.
 */
export interface WalletService {
  /** The customer's balance, opening a wallet the first time they look. */
  read(tenantId: string, customerId: string, now: Date): Promise<WalletSummary>
  /** Their statement, newest first. */
  listEntries(tenantId: string, customerId: string, limit: number): Promise<WalletEntrySummary[]>
  /**
   * Credits a balance from a captured top-up payment.
   *
   * Called by settlement, not by a customer: the money is only theirs once the
   * gateway says so. Idempotent on the payment, so a callback that arrives
   * twice credits once.
   */
  creditTopUp(
    tenantId: string,
    input: { customerId: string; paymentId: string; amount: bigint },
    now: Date,
    correlationId: string,
  ): Promise<WalletSummary>
  /**
   * The same credit, inside a transaction the caller already holds.
   *
   * Settlement uses this: the payment reaching CAPTURED, the posting that says
   * the platform is holding the money, and the balance that says whose it is
   * all commit together. It does not post — the capture it rides along with
   * already did, as a WALLET_TOP_UP journal.
   */
  creditTopUpWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    input: { customerId: string; paymentId: string; amount: bigint },
    now: Date,
    correlationId: string,
  ): Promise<void>
  /**
   * Pays for an order out of the balance, start to finish.
   *
   * The gateway path exists because a bank has to be asked and can take its
   * time. A balance has nobody to ask: the money is already here, and the only
   * question is whether there is enough. So this walks the payment the whole
   * way in one call rather than leaving it for a callback that will never
   * arrive.
   *
   * Refuses rather than throws when the balance is short, and says by how much.
   * That is not an error — it is a sentence the checkout has to show, and
   * "you need another ۴۰٬۰۰۰ ریال" is one a customer can act on.
   *
   * Idempotent on the key, and resumable: a crash between steps leaves a
   * half-walked payment that the next call with the same key finishes, which is
   * the same contract the gateway path has.
   */
  /**
   * Gives an order's money back as a balance, inside the refund's transaction.
   *
   * Idempotent on the order, so a cancellation retried by an operator or by the
   * caller's own retry credits once.
   */
  creditRefundWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    input: { customerId: string; paymentId: string; orderId: string; amount: bigint },
    now: Date,
    correlationId: string,
  ): Promise<void>
  /**
   * Moves money between two balances, inside a transaction the caller holds.
   *
   * Both halves under one lock apiece and one commit: a debit that lands
   * without its credit is money that left one customer and reached nobody.
   *
   * Nothing is posted to the general ledger, and that is correct rather than an
   * omission. Both balances sit under one control account — what the platform
   * owes its customers — and moving money between two of them does not change
   * that total. A journal whose debit and credit named the same account would
   * record nothing, and the double-entry guard would refuse it.
   */
  transferWithin(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    input: {
      transferId: string
      senderCustomerId: string
      recipientCustomerId: string
      amount: bigint
    },
    now: Date,
    correlationId: string,
  ): Promise<{ ok: true } | { ok: false; shortfall: bigint }>
  payForOrder(
    tenantId: string,
    customerId: string,
    input: { orderId: string; idempotencyKey: string },
    now: Date,
    correlationId: string,
  ): Promise<
    { ok: true; payment: PaymentSummary } | { ok: false; shortfall: bigint; balance: bigint }
  >
}

export class WalletError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

export function createPrismaWalletService(
  prisma: PrismaClient,
  options: { ledger: PaymentLedgerService },
): WalletService {
  return {
    async read(tenantId, customerId, now) {
      return withTenant(prisma, tenantId, async (transaction) =>
        toSummary(await openWallet(transaction, tenantId, customerId, now)),
      )
    },

    async listEntries(tenantId, customerId, limit) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: scoped to the wallet of the authenticated
        // customer, which is looked up by that customer's own id.
        const wallet = await transaction.customerWallet.findFirst({
          where: { tenantId, customerId },
          select: { id: true },
        })
        if (!wallet) return []
        // By sequence, not by time. Two movements can share a millisecond, and
        // the first line of a statement is the one whose balance the customer
        // reads as theirs — it cannot be whichever row the index returned first.
        const entries = await transaction.walletEntry.findMany({
          where: { tenantId, walletId: wallet.id },
          orderBy: { sequence: 'desc' },
          take: limit,
        })
        return entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          amount: { amount: entry.amount.toString(), currency: entry.currency },
          balanceAfter: { amount: entry.balanceAfter.toString(), currency: entry.currency },
          ...(entry.orderId && { orderId: entry.orderId }),
          ...(entry.transferId && { transferId: entry.transferId }),
          createdAt: entry.createdAt.toISOString(),
        }))
      })
    },

    async creditTopUp(tenantId, input, now, correlationId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const moved = await move(transaction, tenantId, {
          customerId: input.customerId,
          kind: 'TOP_UP',
          amount: input.amount,
          paymentId: input.paymentId,
          // Keyed on the payment: the same capture arriving twice replays onto
          // the entry it already wrote instead of crediting again.
          idempotencyKey: `top-up:${input.paymentId}`,
          now,
          correlationId,
        })
        if (!moved.ok) {
          // Unreachable — a credit cannot be short — but a silent `ok` here
          // would be a lie about money.
          throw new WalletError('WALLET_MOVEMENT_REFUSED', 409)
        }
        // In the same transaction as the credit, deliberately. A balance raised
        // by one transaction and posted by another is, for the window between
        // them, money the platform is holding that its books do not mention —
        // and if the posting is the half that fails, that window never closes.
        if (moved.created) {
          await options.ledger.postWithin(transaction, tenantId, {
            paymentId: input.paymentId,
            type: 'WALLET_TOP_UP',
            amount: input.amount,
            lines: walletTopUpJournal(input.amount),
            idempotencyKey: `wallet-top-up:${input.paymentId}`,
            correlationId,
            occurredAt: now,
          })
        }
        return moved.wallet
      })
    },

    async payForOrder(tenantId, customerId, input, now, correlationId) {
      // ownership-established: scoped to the authenticated customer, so an
      // order id from a request body can only ever reach its owner's order.
      const order = await prisma.order.findFirst({
        where: { id: input.orderId, tenantId, customerId },
        select: { id: true, totalAmount: true, paymentState: true },
      })
      if (!order) throw new WalletError('ORDER_NOT_FOUND', 404)

      // Asked before anything is written, so a customer who cannot afford the
      // order is told what to do instead of watching a payment be opened and
      // then stranded. The authoritative check is under the row lock below;
      // this one is the answer, not the guard.
      const balance = await withTenant(
        prisma,
        tenantId,
        async (transaction) =>
          (await openWallet(transaction, tenantId, customerId, now)).balanceAmount,
      )
      if (balance < order.totalAmount && order.paymentState !== 'PAID') {
        return { ok: false as const, shortfall: order.totalAmount - balance, balance }
      }

      const step = (name: string) => `${input.idempotencyKey}:${name}`.slice(0, 128)
      const payment = await options.ledger.initialize(
        tenantId,
        customerId,
        { orderId: input.orderId, idempotencyKey: input.idempotencyKey, method: 'WALLET' },
        now,
        correlationId,
      )

      // A balance needs no authorization from anyone, but the aggregate's
      // history does: the database refuses a state that no contiguous chain of
      // transitions reaches. These two hops are that chain, keyed so a resumed
      // call replays them rather than repeating them.
      for (const to of [PaymentAggregateState.PENDING, PaymentAggregateState.AUTHORIZED] as const) {
        if (statesBefore(payment.state, to)) {
          await options.ledger.transition(
            tenantId,
            { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: step(to.toLowerCase()) },
            now,
            correlationId,
          )
        }
      }

      const captured = await options.ledger.capture(
        tenantId,
        {
          paymentId: payment.id,
          idempotencyKey: step('capture'),
          entries: walletSpendJournal(order.totalAmount),
          // The debit rides inside the capture. An order marked paid whose
          // balance was never taken is the platform giving bread away; a
          // balance taken for an order never marked paid is the reverse.
          within: (transaction) =>
            spendWithin(
              transaction,
              tenantId,
              {
                customerId,
                orderId: input.orderId,
                paymentId: payment.id,
                amount: order.totalAmount,
              },
              now,
              correlationId,
            ),
        },
        now,
        correlationId,
      )
      return { ok: true as const, payment: captured.payment }
    },

    async creditTopUpWithin(transaction, tenantId, input, now, correlationId) {
      const moved = await move(transaction, tenantId, {
        customerId: input.customerId,
        kind: 'TOP_UP',
        amount: input.amount,
        paymentId: input.paymentId,
        idempotencyKey: `top-up:${input.paymentId}`,
        now,
        correlationId,
      })
      if (!moved.ok) throw new WalletError('WALLET_MOVEMENT_REFUSED', 409)
    },

    async creditRefundWithin(transaction, tenantId, input, now, correlationId) {
      const moved = await move(transaction, tenantId, {
        customerId: input.customerId,
        kind: 'REFUND',
        amount: input.amount,
        orderId: input.orderId,
        paymentId: input.paymentId,
        idempotencyKey: `refund:${input.orderId}`,
        now,
        correlationId,
      })
      // Unreachable — a credit cannot be short — but a silent success here
      // would be the books saying money was handed back that was not.
      if (!moved.ok) throw new WalletError('WALLET_MOVEMENT_REFUSED', 409)
    },

    async transferWithin(transaction, tenantId, input, now, correlationId) {
      const sent = await move(transaction, tenantId, {
        customerId: input.senderCustomerId,
        kind: 'TRANSFER_OUT',
        amount: input.amount,
        transferId: input.transferId,
        idempotencyKey: `transfer-out:${input.transferId}`,
        now,
        correlationId,
      })
      if (!sent.ok) return { ok: false as const, shortfall: sent.shortfall }

      const received = await move(transaction, tenantId, {
        customerId: input.recipientCustomerId,
        kind: 'TRANSFER_IN',
        amount: input.amount,
        transferId: input.transferId,
        idempotencyKey: `transfer-in:${input.transferId}`,
        now,
        correlationId,
      })
      if (!received.ok) {
        // Unreachable — a credit cannot be short — but returning `ok` here
        // would be the caller believing money arrived somewhere it did not.
        throw new WalletError('WALLET_MOVEMENT_REFUSED', 409)
      }
      return { ok: true as const }
    },
  }
}

/**
 * Takes the money for an order, inside the capture's own transaction.
 *
 * Throws rather than returning a refusal, unlike everything else that spends a
 * balance: by here the capture is half written, and the only correct answer to
 * a balance that turned out to be short is to undo all of it. The friendly
 * refusal happened before any of this started.
 */
async function spendWithin(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  input: { customerId: string; orderId: string; paymentId: string; amount: bigint },
  now: Date,
  correlationId: string,
): Promise<void> {
  const moved = await move(transaction, tenantId, {
    customerId: input.customerId,
    kind: 'ORDER_PAYMENT',
    amount: input.amount,
    orderId: input.orderId,
    paymentId: input.paymentId,
    idempotencyKey: `order-payment:${input.orderId}`,
    now,
    correlationId,
  })
  if (!moved.ok) throw new WalletError('WALLET_INSUFFICIENT_BALANCE', 422)
}

/** Whether the aggregate still has to make this hop. */
function statesBefore(current: string, target: PaymentAggregateState): boolean {
  const order = ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED']
  return order.indexOf(current) < order.indexOf(target)
}

type MoveResult =
  { ok: true; wallet: WalletSummary; created: boolean } | { ok: false; shortfall: bigint }

/**
 * One movement, balance and entry together, under a row lock.
 *
 * The idempotency key is checked inside the lock rather than before it. Outside
 * it, two concurrent retries of the same request would both find no entry, both
 * proceed, and one would lose to the unique index after having already read a
 * balance it then acts on.
 */
async function move(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  input: {
    customerId: string
    kind: WalletEntryKind
    amount: bigint
    orderId?: string
    paymentId?: string
    transferId?: string
    idempotencyKey: string
    now: Date
    correlationId: string
  },
): Promise<MoveResult> {
  const wallet = await openWallet(transaction, tenantId, input.customerId, input.now)

  // The lock. Everything below reads a balance nobody else can be changing.
  const locked = await transaction.$queryRaw<Array<{ balanceAmount: bigint; version: number }>>`
    SELECT "balanceAmount", "version" FROM "CustomerWallet"
    WHERE "id" = ${wallet.id}::uuid AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE
  `
  const current = locked[0]
  if (!current) throw new WalletError('WALLET_NOT_FOUND', 404)

  const replay = await transaction.walletEntry.findFirst({
    where: { tenantId, walletId: wallet.id, idempotencyKey: input.idempotencyKey },
    select: { balanceAfter: true },
  })
  if (replay) {
    return {
      ok: true as const,
      created: false,
      wallet: {
        id: wallet.id,
        balance: { amount: current.balanceAmount.toString(), currency: 'IRR' },
        updatedAt: input.now.toISOString(),
      },
    }
  }

  const movement = applyWalletMovement({
    balance: current.balanceAmount,
    kind: input.kind,
    amount: input.amount,
  })
  if (!movement.ok) return { ok: false as const, shortfall: movement.shortfall }

  await transaction.walletEntry.create({
    data: {
      tenantId,
      walletId: wallet.id,
      kind: input.kind,
      amount: input.amount,
      balanceAfter: movement.balanceAfter,
      // The wallet's version is the count of movements it has had, starting at
      // one before any. Read under the same lock that produced the balance, so
      // the number cannot be handed out twice.
      sequence: current.version,
      ...(input.paymentId && { paymentId: input.paymentId }),
      ...(input.orderId && { orderId: input.orderId }),
      ...(input.transferId && { transferId: input.transferId }),
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      createdAt: input.now,
    },
  })
  await transaction.customerWallet.update({
    where: { id: wallet.id },
    data: {
      balanceAmount: movement.balanceAfter,
      version: { increment: 1 },
      updatedAt: input.now,
    },
  })

  return {
    ok: true as const,
    created: true,
    wallet: {
      id: wallet.id,
      balance: { amount: movement.balanceAfter.toString(), currency: 'IRR' },
      updatedAt: input.now.toISOString(),
    },
  }
}

/**
 * The customer's wallet, created empty if this is the first time.
 *
 * Opened on demand rather than at sign-up: a row per customer who never charges
 * one is a table that grows with registrations instead of with use, and the
 * first movement is the earliest moment the wallet means anything.
 */
async function openWallet(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  now: Date,
) {
  // ownership-established: the customerId comes from the authenticated session
  // or from a payment this system wrote, never from a request body.
  const existing = await transaction.customerWallet.findFirst({
    where: { tenantId, customerId },
  })
  if (existing) return existing
  return transaction.customerWallet.create({
    data: { tenantId, customerId, createdAt: now, updatedAt: now },
  })
}

function toSummary(wallet: {
  id: string
  balanceAmount: bigint
  currency: string
  updatedAt: Date
}): WalletSummary {
  return {
    id: wallet.id,
    balance: { amount: wallet.balanceAmount.toString(), currency: wallet.currency as 'IRR' },
    updatedAt: wallet.updatedAt.toISOString(),
  }
}

export interface WalletDependencies {
  service: WalletService
  auth: AuthDependencies
  /** Opens a gateway payment for a top-up. Absent means top-ups are unavailable. */
  startTopUp?: (input: {
    tenantId: string
    customerId: string
    amount: bigint
    idempotencyKey: string
    now: Date
  }) => Promise<{ paymentId: string }>
  now?: () => Date
}

const WALLET_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export function registerWalletRoutes(app: FastifyInstance, dependencies: WalletDependencies): void {
  const currentTime = () => dependencies.now?.() ?? new Date()

  app.get('/api/v1/wallet', WALLET_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    try {
      const wallet = await dependencies.service.read(
        customer.tenantId,
        customer.customerId,
        currentTime(),
      )
      return reply.send({ success: true, data: wallet, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.get('/api/v1/wallet/entries', WALLET_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    try {
      const entries = await dependencies.service.listEntries(
        customer.tenantId,
        customer.customerId,
        50,
      )
      return reply.send({ success: true, data: entries, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.post('/api/v1/wallet/top-ups', WALLET_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const parsed = walletTopUpCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(envelope('INVALID_TOP_UP', 'مبلغ شارژ معتبر نیست.'))
    }
    const amount = BigInt(parsed.data.amount)
    const refusal = validateTopUpAmount(amount)
    if (refusal) {
      return reply.code(422).send(envelope(`TOP_UP_${refusal}`, topUpRefusalMessage(refusal)))
    }
    if (!dependencies.startTopUp) {
      return reply
        .code(503)
        .send(envelope('TOP_UP_UNAVAILABLE', 'شارژ کیف پول موقتاً در دسترس نیست.'))
    }

    try {
      const started = await dependencies.startTopUp({
        tenantId: customer.tenantId,
        customerId: customer.customerId,
        amount,
        idempotencyKey: parsed.data.idempotencyKey,
        now: currentTime(),
      })
      return reply.code(201).send({ success: true, data: started, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })
}

function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const result = await operation(transaction)
    await assertDeferredConstraints(transaction)
    return result
  })
}

function meta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function envelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: meta() }
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send(envelope('SESSION_REQUIRED', 'ابتدا وارد شوید.'))
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof WalletError) {
    return reply.code(error.status).send(envelope(error.code, 'درخواست کیف پول انجام نشد.'))
  }
  request.log.error({ err: error }, 'wallet request failed')
  return reply.code(503).send(envelope('WALLET_UNAVAILABLE', 'کیف پول موقتاً در دسترس نیست.'))
}
