import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { TRANSFER_CODE_TTL_MS, TRANSFER_MAX_ATTEMPTS } from '@alo-noon/domain'

import { createPrismaAdminMessagingService } from './modules/admin-messaging'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaWalletService, type WalletService } from './modules/wallet'
import {
  createPrismaWalletTransferService,
  type WalletTransferService,
} from './modules/wallet-transfer'

/**
 * Money moving between two customers, against PostgreSQL.
 *
 * The claims worth testing here are all about what does *not* happen: a code
 * that is wrong moves nothing, a code that is late moves nothing, a code used
 * twice moves money once, and a transfer that is settled cannot be reopened.
 * None of those survive being tested against a mock, because each is enforced
 * by a lock, a unique index or a trigger.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-30T09:00:00.000Z')
const CODE = '424242'

interface Fixture {
  tenantId: string
  senderId: string
  senderMobile: string
  recipientId: string
  recipientMobile: string
}

let fixture: Fixture
let wallet: WalletService
let transfers: WalletTransferService
/** Every text this run would have sent, so nothing reaches a real gateway. */
const sent: { mobileE164: string; body: string }[] = []

afterAll(async () => prisma.$disconnect())

databaseDescribe('wallet transfers over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
    wallet = createPrismaWalletService(prisma, {
      ledger: createPrismaPaymentLedgerService(prisma),
    })
    transfers = createPrismaWalletTransferService(prisma, {
      wallet,
      messagingService: createPrismaAdminMessagingService(prisma),
      text: {
        providers: [
          {
            code: 'STUBSMS',
            sendText: async (request) => {
              sent.push({ mobileE164: request.mobileE164, body: request.body })
              return { outcome: 'DELIVERED', providerReference: randomUUID() }
            },
          },
        ],
        credentialResolver: {
          testOnly: true,
          resolve: async () => ({
            material: new TextEncoder().encode('stub-credential'),
            dispose: () => {},
          }),
        },
        environment: 'TEST',
      },
      otpPepper: 'transfer-test-pepper',
      generateCode: () => CODE,
    })
  }, 60_000)

  it('opens a transfer, texts the sender, and moves nothing yet', async () => {
    const before = await wallet.read(fixture.tenantId, fixture.senderId, now)
    const result = await transfers.open(
      fixture.tenantId,
      fixture.senderId,
      { recipientMobile: fixture.recipientMobile, amount: 300_000n, idempotencyKey: key('open') },
      now,
      randomUUID(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.transfer.state).toBe('PENDING')
    expect(result.transfer.amount.amount).toBe('300000')
    // Masked, so the sender can recognise the number they meant without the
    // screen becoming a directory lookup on a stranger.
    expect(result.transfer.recipientMobileMasked).toMatch(/^\*+\d{4}$/)
    expect(result.transfer.recipientMobileMasked).not.toContain(fixture.recipientMobile.slice(4, 8))

    // The code goes to the sender's own handset, never the recipient's. That is
    // the whole control: a stolen session cannot read it.
    const message = sent.at(-1)
    expect(message?.mobileE164).toBe(fixture.senderMobile)
    expect(message?.body).toContain(CODE)

    // And nothing moved. The money waits for the code.
    const after = await wallet.read(fixture.tenantId, fixture.senderId, now)
    expect(after.balance.amount).toBe(before.balance.amount)
    expect(await prisma.walletEntry.count({ where: { transferId: result.transfer.id } })).toBe(0)
  })

  it('moves the money when the code comes back', async () => {
    const opened = await open(500_000n, 'move')
    const senderBefore = await balanceOf(fixture.senderId)
    const recipientBefore = await balanceOf(fixture.recipientId)
    const postingsBefore = await prisma.financialTransaction.count({
      where: { tenantId: fixture.tenantId },
    })

    const confirmed = await transfers.confirm(
      fixture.tenantId,
      fixture.senderId,
      { transferId: opened.id, code: CODE },
      now,
      randomUUID(),
    )

    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.transfer.state).toBe('COMPLETED')
    expect(await balanceOf(fixture.senderId)).toBe(senderBefore - 500_000n)
    expect(await balanceOf(fixture.recipientId)).toBe(recipientBefore + 500_000n)

    // Two statement lines, one on each side, both naming the transfer.
    const entries = await prisma.walletEntry.findMany({
      where: { transferId: opened.id },
      orderBy: { kind: 'asc' },
    })
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['TRANSFER_IN', 'TRANSFER_OUT'])
    expect(entries.every((entry) => entry.amount === 500_000n)).toBe(true)

    // And nothing new in the general ledger. The platform owes its customers
    // exactly what it owed before — only which customer changed — so a transfer
    // has no journal at all.
    expect(await prisma.financialTransaction.count({ where: { tenantId: fixture.tenantId } })).toBe(
      postingsBefore,
    )
  })

  it('moves nothing for a wrong code, and counts the attempt', async () => {
    const opened = await open(200_000n, 'wrong')
    const before = await balanceOf(fixture.senderId)

    const result = await transfers.confirm(
      fixture.tenantId,
      fixture.senderId,
      { transferId: opened.id, code: '999999' },
      now,
      randomUUID(),
    )

    expect(result).toEqual({
      ok: false,
      reason: 'INVALID_CODE',
      attemptsLeft: TRANSFER_MAX_ATTEMPTS - 1,
    })
    expect(await balanceOf(fixture.senderId)).toBe(before)
    const row = await prisma.walletTransfer.findFirstOrThrow({ where: { id: opened.id } })
    expect(row.failedAttempts).toBe(1)
    expect(row.state).toBe('PENDING')
  })

  /** Guessing is bounded, and the bound is written down when it is reached. */
  it('gives up after the last attempt and marks the transfer over', async () => {
    const opened = await open(200_000n, 'exhaust')

    let last
    for (let attempt = 0; attempt < TRANSFER_MAX_ATTEMPTS; attempt += 1) {
      last = await transfers.confirm(
        fixture.tenantId,
        fixture.senderId,
        { transferId: opened.id, code: '111111' },
        now,
        randomUUID(),
      )
    }

    expect(last).toEqual({ ok: false, reason: 'EXHAUSTED' })
    const row = await prisma.walletTransfer.findFirstOrThrow({ where: { id: opened.id } })
    expect(row.state).toBe('EXPIRED')

    // Even the right code is worth nothing now.
    expect(
      await transfers.confirm(
        fixture.tenantId,
        fixture.senderId,
        { transferId: opened.id, code: CODE },
        now,
        randomUUID(),
      ),
    ).toEqual({ ok: false, reason: 'NOT_PENDING' })
  })

  it('refuses a code that arrived after its window', async () => {
    const opened = await open(200_000n, 'late')
    const later = new Date(now.getTime() + TRANSFER_CODE_TTL_MS + 1_000)

    expect(
      await transfers.confirm(
        fixture.tenantId,
        fixture.senderId,
        { transferId: opened.id, code: CODE },
        later,
        randomUUID(),
      ),
    ).toEqual({ ok: false, reason: 'EXHAUSTED' })
    expect(await prisma.walletEntry.count({ where: { transferId: opened.id } })).toBe(0)
  })

  /** A customer tapping twice sends once. */
  it('confirms the same transfer only once', async () => {
    const opened = await open(150_000n, 'twice')
    await transfers.confirm(
      fixture.tenantId,
      fixture.senderId,
      { transferId: opened.id, code: CODE },
      now,
      randomUUID(),
    )
    const between = await balanceOf(fixture.senderId)

    const second = await transfers.confirm(
      fixture.tenantId,
      fixture.senderId,
      { transferId: opened.id, code: CODE },
      now,
      randomUUID(),
    )

    expect(second).toEqual({ ok: false, reason: 'NOT_PENDING' })
    expect(await balanceOf(fixture.senderId)).toBe(between)
    expect(await prisma.walletEntry.count({ where: { transferId: opened.id } })).toBe(2)
  })

  it('refuses to send more than the balance holds, before charging for a text', async () => {
    const balance = await balanceOf(fixture.senderId)
    const messages = sent.length

    const result = await transfers.open(
      fixture.tenantId,
      fixture.senderId,
      {
        recipientMobile: fixture.recipientMobile,
        amount: balance + 100_000n,
        idempotencyKey: key('short'),
      },
      now,
      randomUUID(),
    )

    expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_BALANCE', shortfall: 100_000n })
    expect(sent).toHaveLength(messages)
    expect(
      await prisma.walletTransfer.count({
        where: { tenantId: fixture.tenantId, idempotencyKey: key('short') },
      }),
    ).toBe(0)
  })

  it('refuses a number nobody has registered, and the sender’s own', async () => {
    expect(
      await transfers.open(
        fixture.tenantId,
        fixture.senderId,
        { recipientMobile: '09350000000', amount: 50_000n, idempotencyKey: key('nobody') },
        now,
        randomUUID(),
      ),
    ).toEqual({ ok: false, reason: 'RECIPIENT_NOT_FOUND' })

    expect(
      await transfers.open(
        fixture.tenantId,
        fixture.senderId,
        { recipientMobile: fixture.senderMobile, amount: 50_000n, idempotencyKey: key('self') },
        now,
        randomUUID(),
      ),
    ).toEqual({ ok: false, reason: 'SELF_TRANSFER' })
  })

  it('refuses an amount outside what a transfer may be', async () => {
    expect(
      await transfers.open(
        fixture.tenantId,
        fixture.senderId,
        { recipientMobile: fixture.recipientMobile, amount: 1n, idempotencyKey: key('tiny') },
        now,
        randomUUID(),
      ),
    ).toEqual({ ok: false, reason: 'BELOW_MINIMUM' })
  })

  /**
   * A code that cannot be sent is not a transfer waiting for one.
   *
   * Left PENDING, it would sit on the sender's screen counting down towards a
   * text nobody sent, and the idempotency key would hand them the same dead row
   * every time they asked again. Closed here, the next request is a fresh
   * transfer with a fresh code — and no money was ever at risk, because none
   * moves until a code comes back.
   */
  it('closes a transfer whose code the gateway would not take', async () => {
    const mute = createPrismaWalletTransferService(prisma, {
      wallet,
      messagingService: createPrismaAdminMessagingService(prisma),
      text: {
        // No adapter matching the tenant's configured provider, which is what a
        // misconfigured deployment looks like from here.
        providers: [],
        credentialResolver: {
          testOnly: true,
          resolve: async () => ({ material: new Uint8Array(), dispose: () => {} }),
        },
        environment: 'TEST',
      },
      otpPepper: 'transfer-test-pepper',
      generateCode: () => CODE,
    })

    const before = await balanceOf(fixture.senderId)
    const result = await mute.open(
      fixture.tenantId,
      fixture.senderId,
      { recipientMobile: fixture.recipientMobile, amount: 90_000n, idempotencyKey: key('mute') },
      now,
      randomUUID(),
    )

    expect(result).toEqual({ ok: false, reason: 'CODE_NOT_SENT' })
    const row = await prisma.walletTransfer.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, idempotencyKey: key('mute') },
    })
    expect(row.state).toBe('CANCELLED')
    expect(await balanceOf(fixture.senderId)).toBe(before)
  })

  /** The last line of defence, below every service that could be wrong. */
  it('refuses to reopen a settled transfer at the database', async () => {
    const settled = await prisma.walletTransfer.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, state: 'COMPLETED' },
    })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.walletTransfer.update({
          where: { id: settled.id },
          data: { state: 'PENDING' },
        })
      }),
    ).rejects.toThrow(/cannot change state/)
  })

  it('refuses to rewrite who or how much, even while pending', async () => {
    const opened = await open(120_000n, 'immutable')
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.walletTransfer.update({
          where: { id: opened.id },
          data: { amount: 1n },
        })
      }),
    ).rejects.toThrow(/who or how much/)
  })
})

const key = (name: string) => `wallet-transfer-${suffix}-${name}`

async function open(amount: bigint, name: string) {
  const result = await transfers.open(
    fixture.tenantId,
    fixture.senderId,
    { recipientMobile: fixture.recipientMobile, amount, idempotencyKey: key(name) },
    now,
    randomUUID(),
  )
  if (!result.ok) throw new Error(`the fixture could not open a transfer: ${result.reason}`)
  return result.transfer
}

async function balanceOf(customerId: string): Promise<bigint> {
  const row = await prisma.customerWallet.findFirstOrThrow({
    where: { tenantId: fixture.tenantId, customerId },
  })
  return row.balanceAmount
}

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `xfer-${suffix.toLowerCase()}`, name: `Transfer ${suffix}` },
  })
  const tenantId = tenant.id

  const digits = suffix.replace(/\D/g, '').padEnd(6, '7').slice(0, 6)
  const senderMobile = `+98912${digits}1`
  const recipientMobile = `+98912${digits}2`

  const sender = await prisma.customer.create({
    data: { tenantId, mobileE164: senderMobile, firstName: 'مریم', lastName: 'کریمی' },
  })
  const recipient = await prisma.customer.create({
    data: { tenantId, mobileE164: recipientMobile, firstName: 'زهرا', lastName: 'محمدی' },
  })

  // A balance to send from, put there the way a real one gets there: a captured
  // top-up payment credited through the wallet service.
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      customerId: sender.id,
      purpose: 'WALLET_TOP_UP',
      method: 'ONLINE_GATEWAY',
      state: 'CAPTURED',
      amount: 5_000_000n,
      currency: 'IRR',
      idempotencyKey: `xfer-topup-${suffix}`,
      correlationId: randomUUID(),
    },
  })
  const service = createPrismaWalletService(prisma, {
    ledger: createPrismaPaymentLedgerService(prisma),
  })
  await service.creditTopUp(
    tenantId,
    { customerId: sender.id, paymentId: payment.id, amount: 5_000_000n },
    now,
    randomUUID(),
  )
  // The recipient's wallet has to exist before it can be credited by a
  // transfer; opening it is what the first look at a balance does.
  await service.read(tenantId, recipient.id, now)

  // The tenant's SMS gateway. Without one, a transfer cannot send its code and
  // is refused — which is a case of its own below, not the default here.
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.authDeliveryProviderConfiguration.create({
      data: {
        tenantId,
        providerCode: 'STUBSMS',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
        credentialReference: `env://XFER_STUB_${suffix}`,
        senderReference: 'test-sender',
        templateReference: 'test-template',
        enabled: true,
        isDefault: true,
        priority: 100,
      },
    })
  })

  return {
    tenantId,
    senderId: sender.id,
    senderMobile,
    recipientId: recipient.id,
    recipientMobile,
  }
}
