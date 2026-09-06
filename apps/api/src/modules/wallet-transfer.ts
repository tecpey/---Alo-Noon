import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  walletTransferConfirmSchema,
  walletTransferCreateSchema,
  type ErrorEnvelope,
  type ResponseMeta,
  type WalletTransferSummary,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  evaluateTransferConfirmation,
  generateSecureOtp,
  maskMobile,
  maskName,
  normalizeIranianMobile,
  renderMessageTemplate,
  TRANSFER_CODE_TTL_MS,
  transferRefusalMessage,
  validateTransferAmount,
} from '@alo-noon/domain'

import type { AdminMessagingService } from './admin-messaging.js'
import type { AuthDependencies } from './auth.js'
import { authenticationOtpDigest } from './auth-delivery.js'
import { authenticatedCustomer } from './commerce.js'
import { assertDeferredConstraints } from './deferred-constraints.js'
import { sendTextMessage, type TextMessageSenderOptions } from './text-messages.js'
import { WalletError, type WalletService } from './wallet.js'

/**
 * Sending part of a balance to somebody else's.
 *
 * Two acts, deliberately. The first names a recipient and an amount and gets a
 * code; the second types the code back and moves the money. They are separate
 * because the recipient is chosen by typing a phone number, where one wrong key
 * sends real money to a real stranger and nothing bounces — so between deciding
 * and doing, the sender is shown who they are about to pay, and has to prove on
 * their own handset that they meant it.
 *
 * The code is not proof of identity; the session already established that. It
 * is what makes a stolen unlocked phone or a hijacked session unable to empty a
 * balance quietly, and what puts a sentence in front of somebody whose balance
 * is being spent by someone else.
 *
 * Nothing is held while a transfer waits. Moving the money at request time and
 * putting it back on expiry would invent a balance belonging to neither party
 * and appearing in neither statement. The sender's balance is checked again at
 * confirmation, which is the only moment the answer has to be true.
 */
export interface WalletTransferService {
  /**
   * Opens a transfer and texts the sender a code.
   *
   * Refuses rather than throws for the things a customer causes: an amount out
   * of range, a number nobody has registered, their own number, a balance that
   * does not cover it. Each is a sentence the app has to show.
   */
  open(
    tenantId: string,
    senderCustomerId: string,
    input: { recipientMobile: string; amount: bigint; idempotencyKey: string },
    now: Date,
    correlationId: string,
  ): Promise<
    | { ok: true; transfer: WalletTransferSummary }
    | { ok: false; reason: string; shortfall?: bigint }
  >
  /** Types the code back and moves the money, or says why not. */
  confirm(
    tenantId: string,
    senderCustomerId: string,
    input: { transferId: string; code: string },
    now: Date,
    correlationId: string,
  ): Promise<
    | { ok: true; transfer: WalletTransferSummary }
    | { ok: false; reason: string; attemptsLeft?: number; shortfall?: bigint }
  >
  /** The sender's own transfers, newest first. */
  list(tenantId: string, customerId: string, limit: number): Promise<WalletTransferSummary[]>
}

export interface WalletTransferOptions {
  wallet: WalletService
  messagingService: AdminMessagingService
  text: TextMessageSenderOptions
  /**
   * Peppers the stored code digest. The same secret the sign-in codes use: a
   * transfer code is an OTP with a different purpose string, and a second
   * pepper would be a second secret to rotate for no security gained.
   */
  otpPepper: string
  generateCode?: () => string
  textTimeoutMs?: number
}

const DEFAULT_TEXT_TIMEOUT_MS = 10_000

export function createPrismaWalletTransferService(
  prisma: PrismaClient,
  options: WalletTransferOptions,
): WalletTransferService {
  const timeoutMs = options.textTimeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS

  return {
    async open(tenantId, senderCustomerId, input, now, correlationId) {
      const refusal = validateTransferAmount(input.amount)
      if (refusal) return { ok: false as const, reason: refusal }

      let mobile: string
      try {
        mobile = normalizeIranianMobile(input.recipientMobile)
      } catch {
        return { ok: false as const, reason: 'RECIPIENT_NOT_FOUND' }
      }

      const opened = await withTenant(prisma, tenantId, async (transaction) => {
        const replay = await transaction.walletTransfer.findFirst({
          where: { tenantId, senderCustomerId, idempotencyKey: input.idempotencyKey },
          include: { recipient: { select: { mobileE164: true, firstName: true, lastName: true } } },
        })
        if (replay) return { kind: 'replay' as const, transfer: replay }

        // ownership-established: a lookup by mobile number, which is how one
        // customer names another. Nothing about the recipient is returned
        // except what `maskMobile` and `maskName` allow.
        const recipient = await transaction.customer.findFirst({
          where: { tenantId, mobileE164: mobile },
          select: { id: true, mobileE164: true },
        })
        // A number nobody has registered and a number belonging to the sender
        // are told apart, because they are different mistakes with different
        // fixes — and neither reveals anything: the sender already knows their
        // own number, and "not found" is what an unregistered number is.
        if (!recipient) return { kind: 'refused' as const, reason: 'RECIPIENT_NOT_FOUND' }
        if (recipient.id === senderCustomerId) {
          return { kind: 'refused' as const, reason: 'SELF_TRANSFER' }
        }

        const balance = await transaction.customerWallet.findFirst({
          where: { tenantId, customerId: senderCustomerId },
          select: { balanceAmount: true },
        })
        const available = balance?.balanceAmount ?? 0n
        // Asked before a code is sent, so a customer who cannot afford it is
        // told what to top up instead of paying for an SMS to find out. The
        // authoritative check is under the row lock at confirmation.
        if (available < input.amount) {
          return {
            kind: 'refused' as const,
            reason: 'INSUFFICIENT_BALANCE',
            shortfall: input.amount - available,
          }
        }

        const code = options.generateCode?.() ?? generateSecureOtp(secureBelow)
        const transferId = randomUUID()
        const transfer = await transaction.walletTransfer.create({
          data: {
            id: transferId,
            tenantId,
            senderCustomerId,
            recipientCustomerId: recipient.id,
            amount: input.amount,
            state: 'PENDING',
            // Digested with the transfer's own id in the purpose, so a code is
            // worth nothing against any other transfer even if two collide.
            codeDigest: authenticationOtpDigest(options.otpPepper, tenantId, transferId, code),
            codeExpiresAt: new Date(now.getTime() + TRANSFER_CODE_TTL_MS),
            idempotencyKey: input.idempotencyKey,
            correlationId,
            createdAt: now,
          },
          include: { recipient: { select: { mobileE164: true, firstName: true, lastName: true } } },
        })
        return { kind: 'created' as const, transfer, code }
      })

      if (opened.kind === 'refused') {
        return {
          ok: false as const,
          reason: opened.reason,
          ...(opened.shortfall !== undefined && { shortfall: opened.shortfall }),
        }
      }
      if (opened.kind === 'created') {
        const delivered = await sendCode(prisma, options, tenantId, {
          senderCustomerId,
          transfer: opened.transfer,
          code: opened.code,
          timeoutMs,
          now,
        })
        // A transfer whose code never left is not a transfer waiting for one.
        // Left PENDING it would sit on the sender's screen counting down
        // towards a text that is never coming, and the idempotency key would
        // make asking again return the same dead row. Closed here, the next
        // request is a fresh transfer with a fresh code.
        if (!delivered) {
          await withTenant(prisma, tenantId, (transaction) =>
            transaction.walletTransfer.update({
              where: { id: opened.transfer.id },
              data: { state: 'CANCELLED', settledAt: now },
            }),
          )
          return { ok: false as const, reason: 'CODE_NOT_SENT' }
        }
      }
      return { ok: true as const, transfer: toSummary(opened.transfer) }
    },

    async confirm(tenantId, senderCustomerId, input, now, correlationId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // Locked for the whole decision. Two tabs typing the same code would
        // otherwise both read PENDING and both move the money.
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "WalletTransfer"
          WHERE "id" = ${input.transferId}::uuid
            AND "tenantId" = ${tenantId}::uuid
            AND "senderCustomerId" = ${senderCustomerId}::uuid
          FOR UPDATE
        `
        if (!locked[0]) throw new WalletError('TRANSFER_NOT_FOUND', 404)

        // ownership-established: scoped to the authenticated sender above, so a
        // transfer id from elsewhere reads as absent rather than as somebody
        // else's.
        const transfer = await transaction.walletTransfer.findFirstOrThrow({
          where: { id: input.transferId, tenantId, senderCustomerId },
          include: { recipient: { select: { mobileE164: true, firstName: true, lastName: true } } },
        })

        const decision = evaluateTransferConfirmation({
          state: transfer.state,
          expiresAt: transfer.codeExpiresAt,
          failedAttempts: transfer.failedAttempts,
          codeMatches: safeEqual(
            transfer.codeDigest,
            authenticationOtpDigest(options.otpPepper, tenantId, transfer.id, input.code),
          ),
          now,
        })

        if (!decision.ok) {
          if (decision.reason === 'INVALID_CODE') {
            await transaction.walletTransfer.update({
              where: { id: transfer.id },
              data: { failedAttempts: { increment: 1 } },
            })
            return {
              ok: false as const,
              reason: 'INVALID_CODE',
              attemptsLeft: decision.attemptsLeft,
            }
          }
          if (decision.reason === 'EXHAUSTED' && transfer.state === 'PENDING') {
            // Written down rather than left to be re-evaluated. A transfer that
            // is over should read as over on the sender's screen, not as one
            // still waiting for a code that can never work.
            await transaction.walletTransfer.update({
              where: { id: transfer.id },
              data: { state: 'EXPIRED', settledAt: now },
            })
          }
          return { ok: false as const, reason: decision.reason }
        }

        const moved = await options.wallet.transferWithin(
          transaction,
          tenantId,
          {
            transferId: transfer.id,
            senderCustomerId,
            recipientCustomerId: transfer.recipientCustomerId,
            amount: transfer.amount,
          },
          now,
          correlationId,
        )
        if (!moved.ok) {
          // The balance was enough when the code was sent and is not now — the
          // customer spent it in between. The transfer stays open: they can top
          // up and confirm again while the code lasts.
          return { ok: false as const, reason: 'INSUFFICIENT_BALANCE', shortfall: moved.shortfall }
        }

        const settled = await transaction.walletTransfer.update({
          where: { id: transfer.id },
          data: { state: 'COMPLETED', settledAt: now },
          include: { recipient: { select: { mobileE164: true, firstName: true, lastName: true } } },
        })
        await assertDeferredConstraints(transaction)
        return { ok: true as const, transfer: toSummary(settled) }
      })
    },

    async list(tenantId, customerId, limit) {
      return withTenant(prisma, tenantId, async (transaction) => {
        // ownership-established: the sender's own transfers, by their own id.
        const transfers = await transaction.walletTransfer.findMany({
          where: { tenantId, senderCustomerId: customerId },
          include: { recipient: { select: { mobileE164: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
        return transfers.map(toSummary)
      })
    },
  }
}

type TransferRecord = Prisma.WalletTransferGetPayload<{
  include: { recipient: { select: { mobileE164: true; firstName: true; lastName: true } } }
}>

/** The recipient's name as one string, or nothing if they never gave one. */
function fullName(customer: { firstName: string | null; lastName: string | null }): string | null {
  const joined = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim()
  return joined || null
}

function toSummary(transfer: TransferRecord): WalletTransferSummary {
  const name = maskName(fullName(transfer.recipient))
  return {
    id: transfer.id,
    state: transfer.state,
    amount: { amount: transfer.amount.toString(), currency: transfer.currency },
    recipientMobileMasked: maskMobile(transfer.recipient.mobileE164),
    ...(name && { recipientName: name }),
    // Only while it means something. A finished transfer showing a countdown
    // reads like it is still waiting for one.
    ...(transfer.state === 'PENDING' && {
      codeExpiresAt: transfer.codeExpiresAt.toISOString(),
    }),
    createdAt: transfer.createdAt.toISOString(),
    ...(transfer.settledAt && { settledAt: transfer.settledAt.toISOString() }),
  }
}

/**
 * Texts the sender their code, and says whether it went.
 *
 * By SMS and never by push, which is the opposite of every other message this
 * platform sends. A push lands in the app the session is already inside, so a
 * stolen session would confirm its own transfer — the whole point is a second
 * channel the thief does not have.
 *
 * Returns false rather than throwing when the gateway will not take it. The
 * caller closes the transfer: an unsendable code is a transfer that cannot be
 * confirmed, and pretending otherwise leaves a customer waiting for a text
 * nobody sent.
 */
async function sendCode(
  prisma: PrismaClient,
  options: WalletTransferOptions,
  tenantId: string,
  input: {
    senderCustomerId: string
    transfer: TransferRecord
    code: string
    timeoutMs: number
    now: Date
  },
): Promise<boolean> {
  const sender = await withTenant(prisma, tenantId, (transaction) =>
    // ownership-established: the authenticated sender's own row, by their id.
    transaction.customer.findFirst({
      where: { id: input.senderCustomerId, tenantId },
      select: { mobileE164: true },
    }),
  )
  if (!sender) return false

  const template = await options.messagingService.resolve(tenantId, 'SMS', 'WALLET_TRANSFER_CODE')
  // A tenant that has switched this message off has switched transfers off.
  // Opening one anyway would be opening a door with no handle.
  if (!template.enabled) return false

  const recipientName = maskName(fullName(input.transfer.recipient))
  const body = renderMessageTemplate(template.body, {
    code: input.code,
    amount: new Intl.NumberFormat('fa-IR').format(input.transfer.amount),
    recipient: recipientName ?? maskMobile(input.transfer.recipient.mobileE164),
    minutes: String(Math.round(TRANSFER_CODE_TTL_MS / 60_000)),
  })

  const result = await sendTextMessage(prisma, options.text, tenantId, {
    mobileE164: sender.mobileE164,
    body,
    idempotencyKey: `wallet-transfer:${input.transfer.id}`,
    timeoutMs: input.timeoutMs,
    now: input.now,
  })
  // UNKNOWN counts as sent. The gateway stopped answering after it was handed
  // the message, so the text may well be on its way — cancelling a transfer
  // whose code then arrives is worse than letting it expire unused.
  return result.outcome === 'DELIVERED' || result.outcome === 'UNKNOWN'
}

/**
 * Constant-time comparison of two digests.
 *
 * Both are hex of the same length, so a plain `===` would leak how much of a
 * guess was right through how long the comparison took. That is a thin channel
 * and a real one.
 */
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/** Uniform below `maximum`, from the platform's CSPRNG. */
function secureBelow(maximum: number): number {
  const limit = Math.floor(0x100000000 / maximum) * maximum
  for (;;) {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    if (value[0]! < limit) return value[0]! % maximum
  }
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

export interface WalletTransferDependencies {
  service: WalletTransferService
  auth: AuthDependencies
  now?: () => Date
}

/**
 * Tighter than the wallet's other routes.
 *
 * Opening a transfer sends an SMS the platform pays for, and confirming one is
 * where a code would be guessed. The per-transfer attempt limit is the real
 * defence; this keeps somebody from opening a thousand transfers to get a
 * thousand chances at five guesses each.
 */
const TRANSFER_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

export function registerWalletTransferRoutes(
  app: FastifyInstance,
  dependencies: WalletTransferDependencies,
): void {
  const currentTime = () => dependencies.now?.() ?? new Date()

  app.get('/api/v1/wallet/transfers', TRANSFER_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    try {
      const transfers = await dependencies.service.list(customer.tenantId, customer.customerId, 50)
      return reply.send({ success: true, data: transfers, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.post('/api/v1/wallet/transfers', TRANSFER_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const parsed = walletTransferCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(envelope('INVALID_TRANSFER', 'درخواست انتقال معتبر نیست.'))
    }

    try {
      const result = await dependencies.service.open(
        customer.tenantId,
        customer.customerId,
        {
          recipientMobile: parsed.data.recipientMobile,
          amount: BigInt(parsed.data.amount),
          idempotencyKey: parsed.data.idempotencyKey,
        },
        currentTime(),
        randomUUID(),
      )
      if (!result.ok) return refusal(reply, result.reason, result.shortfall)
      return reply.code(201).send({ success: true, data: result.transfer, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.post<{ Params: { transferId: string } }>(
    '/api/v1/wallet/transfers/:transferId/confirm',
    TRANSFER_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const customer = await authenticatedCustomer(request, dependencies.auth)
      if (!customer) return unauthorized(reply)

      const parsed = walletTransferConfirmSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send(envelope('INVALID_TRANSFER_CODE', 'کد تأیید معتبر نیست.'))
      }

      try {
        const result = await dependencies.service.confirm(
          customer.tenantId,
          customer.customerId,
          { transferId: request.params.transferId, code: parsed.data.code },
          currentTime(),
          randomUUID(),
        )
        if (!result.ok) {
          return reply.code(422).send({
            success: false,
            error: {
              code: result.reason,
              message: CONFIRM_MESSAGES[result.reason] ?? 'انتقال انجام نشد.',
              ...((result.attemptsLeft !== undefined || result.shortfall !== undefined) && {
                details: {
                  ...(result.attemptsLeft !== undefined && { attemptsLeft: result.attemptsLeft }),
                  ...(result.shortfall !== undefined && {
                    shortfall: { amount: result.shortfall.toString(), currency: 'IRR' },
                  }),
                },
              }),
            },
            meta: meta(),
          })
        }
        return reply.send({ success: true, data: result.transfer, meta: meta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )
}

const CONFIRM_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_CODE: 'کد تأیید درست نیست.',
  EXHAUSTED: 'این انتقال منقضی شده است. دوباره شروع کنید.',
  NOT_PENDING: 'این انتقال قبلاً بسته شده است.',
  INSUFFICIENT_BALANCE: 'موجودی کیف پول کافی نیست.',
  RECIPIENT_NOT_FOUND: 'شماره‌ای که وارد کردید در الو نون ثبت نشده است.',
  CODE_NOT_SENT: 'ارسال کد تأیید ممکن نشد. کمی بعد دوباره تلاش کنید.',
}

function refusal(reply: FastifyReply, reason: string, shortfall?: bigint) {
  const message = transferRefusalMessage(reason) ?? CONFIRM_MESSAGES[reason] ?? 'انتقال انجام نشد.'
  return reply.code(422).send({
    success: false,
    error: {
      code: reason,
      message,
      ...(shortfall !== undefined && {
        details: { shortfall: { amount: shortfall.toString(), currency: 'IRR' } },
      }),
    },
    meta: meta(),
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
    return reply.code(error.status).send(envelope(error.code, 'انتقال انجام نشد.'))
  }
  request.log.error({ err: error }, 'wallet transfer failed')
  return reply.code(503).send(envelope('TRANSFER_UNAVAILABLE', 'انتقال موقتاً در دسترس نیست.'))
}
