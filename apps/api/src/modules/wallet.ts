import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  walletTopUpCreateSchema,
  type ErrorEnvelope,
  type ResponseMeta,
  type WalletEntrySummary,
  type WalletSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  applyWalletMovement,
  topUpRefusalMessage,
  validateTopUpAmount,
  walletTopUpJournal,
  type WalletEntryKind,
} from '@alo-noon/domain'

import { authenticatedCustomer } from './commerce.js'
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
 * Spending a balance on an order is deliberately not here yet. It has to move
 * the payment state machine and the order's paid flag in the same transaction
 * as the balance — the database refuses a paid order that has no capture
 * posting, and refuses a capture posting whose order is not paid — so it is a
 * change to the capture path rather than a method beside it.
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
          createdAt: entry.createdAt.toISOString(),
        }))
      })
    },

    async creditTopUp(tenantId, input, now, correlationId) {
      const moved = await move(prisma, tenantId, {
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
        // Unreachable — a credit cannot be short — but a silent `ok` here would
        // be a lie about money.
        throw new WalletError('WALLET_MOVEMENT_REFUSED', 409)
      }
      if (moved.created) {
        await options.ledger.post(tenantId, {
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
    },
  }
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
  prisma: PrismaClient,
  tenantId: string,
  input: {
    customerId: string
    kind: WalletEntryKind
    amount: bigint
    orderId?: string
    paymentId?: string
    idempotencyKey: string
    now: Date
    correlationId: string
  },
): Promise<MoveResult> {
  return withTenant(prisma, tenantId, async (transaction) => {
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
        // The wallet's version is the count of movements it has had, starting
        // at one before any. Read under the same lock that produced the
        // balance, so the number cannot be handed out twice.
        sequence: current.version,
        ...(input.paymentId && { paymentId: input.paymentId }),
        ...(input.orderId && { orderId: input.orderId }),
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
  })
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
    return operation(transaction)
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
