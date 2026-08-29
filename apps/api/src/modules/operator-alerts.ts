import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  composeOperatorAlert,
  decideOperatorAlert,
  selectEmailConfiguration,
  type EmailRegistry,
  type OperatorAlertKind,
  type OperatorAlertObservation,
} from '@alo-noon/domain'

/**
 * Turns things the system already knows into something a person is told.
 *
 * Every condition here was already detected and already written to the server
 * log. That is where they stayed. A gateway that went unhealthy overnight was
 * found by a customer failing to pay; events that exhausted their retries were
 * found never, because nothing looks at them again.
 *
 * Three properties this deliberately has:
 *
 * - It never invents a condition. Each observation is a count of rows that are
 *   already wrong by the system's own rules, so an alert cannot fire for
 *   something an operator would look at and see as fine.
 * - It never sends an all-clear. An operator who receives one learns to skim,
 *   and the next real alert arrives looking like the last four that meant
 *   nothing. The panel shows current state; email is for what needs a person.
 * - A failure to alert never fails the thing it was watching. This runs on its
 *   own sweep and swallows its own errors, because a mail server being down
 *   must not stop payments settling.
 */

/** How long a payment may sit collected-but-unrecorded before it is worth saying. */
const SETTLEMENT_GRACE_MS = 30 * 60_000

export interface OperatorAlertSweepSummary {
  readonly evaluated: number
  readonly sent: number
  readonly suppressed: number
  readonly failed: number
  /** No recipients, or no healthy email service. Not an error — a state. */
  readonly skippedNoChannel: boolean
}

export interface OperatorAlertService {
  sweep(tenantId: string, now: Date, correlationId: string): Promise<OperatorAlertSweepSummary>
}

export interface OperatorAlertOptions {
  readonly registry: EmailRegistry
  /** Resolves a configuration's credential reference to its value. */
  readonly credentialResolver: (reference: string) => string | undefined
  readonly environment: 'TEST' | 'PRODUCTION'
  /** Where the alert tells the operator to go. */
  readonly panelUrl: string
  readonly sendTimeoutMs?: number
}

export function createPrismaOperatorAlertService(
  prisma: PrismaClient,
  options: OperatorAlertOptions,
): OperatorAlertService {
  const sendTimeoutMs = options.sendTimeoutMs ?? 10_000

  return {
    async sweep(tenantId, now, correlationId) {
      const observations = await observe(prisma, tenantId, now)
      const empty: OperatorAlertSweepSummary = {
        evaluated: observations.length,
        sent: 0,
        suppressed: 0,
        failed: 0,
        skippedNoChannel: false,
      }

      // Nothing is wrong. Do not open a mail connection to say so.
      if (!observations.some((observation) => observation.count > 0)) return empty

      const channel = await resolveChannel(prisma, tenantId, options)
      if (!channel) return { ...empty, skippedNoChannel: true }

      let sent = 0
      let suppressed = 0
      let failed = 0

      for (const observation of observations) {
        // Each kind is claimed in its own SERIALIZABLE transaction, so two
        // processes evaluating the same sweep cannot both decide to send.
        const claim = await claimSend(prisma, tenantId, observation, now)
        if (!claim.send) {
          if (claim.counted) suppressed += 1
          continue
        }

        const { subject, body } = composeOperatorAlert(
          observation,
          channel.tenantName,
          options.panelUrl,
        )
        const audience =
          claim.severity === 'CRITICAL'
            ? channel.recipients
            : channel.recipients.filter((recipient) => !recipient.criticalOnly)
        if (audience.length === 0) {
          // Everybody asked for critical only and this is a warning. Releasing
          // the claim keeps the quiet period honest: nothing was said, so the
          // next sweep should be free to say it if the audience changes.
          await releaseClaim(prisma, tenantId, observation.kind, now)
          suppressed += 1
          continue
        }

        try {
          const result = await channel.provider.send({
            message: {
              to: audience.map((recipient) => ({
                address: recipient.address,
                name: recipient.displayName,
              })),
              subject,
              body,
            },
            sender: { address: channel.senderAddress, name: channel.senderName },
            credential: channel.credential,
            environment: options.environment,
            timeoutMs: sendTimeoutMs,
          })
          await recordOutcome(prisma, tenantId, observation.kind, result.outcome, now)
          if (result.outcome === 'SENT') sent += 1
          else failed += 1
        } catch {
          // The adapter should not throw, but a broken one must not take the
          // sweep — or the caller — down with it.
          await recordOutcome(prisma, tenantId, observation.kind, 'PERMANENT_FAILURE', now)
          failed += 1
        }
      }

      void correlationId
      return { evaluated: observations.length, sent, suppressed, failed, skippedNoChannel: false }
    },
  }
}

/**
 * What is currently wrong, counted from rows rather than inferred.
 *
 * Each of these is a condition the system already treats as a problem
 * somewhere else, so an alert can never disagree with what the panel shows.
 */
async function observe(
  prisma: PrismaClient,
  tenantId: string,
  now: Date,
): Promise<readonly OperatorAlertObservation[]> {
  return withTenant(prisma, tenantId, async (transaction) => {
    const [gateways, sms, parked, unsettled] = await Promise.all([
      // Configured to be used, and not usable. A gateway nobody enabled is not
      // a problem; one that is enabled and default and unhealthy is.
      transaction.paymentProviderConfiguration.count({
        where: { tenantId, isActive: true, isDefault: true, healthStatus: { not: 'HEALTHY' } },
      }),
      // Nothing selectable at all means nobody can sign in, which for this
      // product means nobody new can order.
      transaction.authDeliveryProviderConfiguration.count({
        where: { tenantId, enabled: true, healthStatus: 'HEALTHY' },
      }),
      transaction.domainEventOutbox.count({ where: { tenantId, status: 'FAILED' } }),
      // Collected from a customer, past the grace period, still not recorded.
      transaction.paymentCallbackReceipt.count({
        where: {
          tenantId,
          processingStatus: 'RECEIVED',
          receivedAt: { lt: new Date(now.getTime() - SETTLEMENT_GRACE_MS) },
        },
      }),
    ])

    return [
      {
        kind: 'PAYMENT_GATEWAY_UNHEALTHY' as const,
        count: gateways,
        detailFa: `${toFa(gateways)} درگاه پرداختِ فعال و پیش‌فرض، سالم نیست.`,
      },
      {
        // Inverted on purpose: the alert fires on the *absence* of a healthy
        // provider, so the count is 1 when there are none.
        kind: 'SMS_PROVIDER_UNAVAILABLE' as const,
        count: sms === 0 ? 1 : 0,
        detailFa: 'هیچ سرویس پیامکِ سالمی برای ارسال کد ورود ثبت نشده است.',
      },
      {
        kind: 'OUTBOX_EVENTS_PARKED' as const,
        count: parked,
        detailFa: `${toFa(parked)} رویداد بعد از تمام‌شدن تلاش‌ها کنار گذاشته شده.`,
      },
      {
        kind: 'PAYMENTS_AWAITING_SETTLEMENT' as const,
        count: unsettled,
        detailFa: `${toFa(unsettled)} بازگشت پرداخت بیش از نیم ساعت است که تسویه نشده.`,
      },
    ]
  })
}

interface ResolvedChannel {
  readonly provider: Awaited<ReturnType<EmailRegistry['resolve']>>
  readonly credential: string
  readonly senderAddress: string
  readonly senderName: string
  readonly tenantName: string
  readonly recipients: readonly { address: string; displayName: string; criticalOnly: boolean }[]
}

/**
 * The service, the credential, and the people — or nothing.
 *
 * Returns undefined rather than throwing for every ordinary reason it might not
 * work: no configuration, none healthy, no adapter, no credential in the
 * environment, nobody listening. A tenant that has not set up email should
 * simply not be alerted, and that is not a fault to report.
 */
async function resolveChannel(
  prisma: PrismaClient,
  tenantId: string,
  options: OperatorAlertOptions,
): Promise<ResolvedChannel | undefined> {
  return withTenant(prisma, tenantId, async (transaction) => {
    const [configurations, recipients, tenant] = await Promise.all([
      transaction.emailProviderConfiguration.findMany({ where: { tenantId } }),
      transaction.operatorAlertRecipient.findMany({ where: { tenantId, enabled: true } }),
      transaction.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
    ])
    if (recipients.length === 0) return undefined

    const chosen = selectEmailConfiguration(
      configurations.map((configuration) => ({
        id: configuration.id,
        providerCode: configuration.providerCode,
        adapterVersion: configuration.adapterVersion,
        adapterSpiVersion: configuration.adapterSpiVersion,
        environment: configuration.environment,
        enabled: configuration.enabled,
        isDefault: configuration.isDefault,
        priority: configuration.priority,
        healthStatus: configuration.healthStatus,
      })),
      options.environment,
    )
    if (!chosen) return undefined

    const credential = options.credentialResolver(
      configurations.find((configuration) => configuration.id === chosen.id)?.credentialReference ??
        '',
    )
    if (!credential) return undefined

    let provider
    try {
      provider = options.registry.resolve({
        providerCode: chosen.providerCode,
        adapterVersion: chosen.adapterVersion,
        adapterSpiVersion: chosen.adapterSpiVersion,
        environment: options.environment,
      })
    } catch {
      // A configuration naming an adapter this build does not carry. Nothing to
      // do about it here; the panel shows the configuration and the operator
      // can see the code they typed.
      return undefined
    }

    const configuration = configurations.find((entry) => entry.id === chosen.id)
    if (!configuration) return undefined

    return {
      provider,
      credential,
      senderAddress: configuration.senderAddress,
      senderName: configuration.senderName,
      tenantName: tenant?.name ?? 'الو نون',
      recipients: recipients.map((recipient) => ({
        address: recipient.address,
        displayName: recipient.displayName,
        criticalOnly: recipient.criticalOnly,
      })),
    }
  })
}

/**
 * Take the right to send this kind, or find it already taken.
 *
 * The dispatch row is claimed and stamped inside one SERIALIZABLE transaction,
 * before the message goes out. That ordering matters: stamping afterwards would
 * let two sweeps both read "not sent recently", both send, and both then record
 * a send that the other had already made.
 */
async function claimSend(
  prisma: PrismaClient,
  tenantId: string,
  observation: OperatorAlertObservation,
  now: Date,
): Promise<{ send: boolean; counted: boolean; severity: 'WARNING' | 'CRITICAL' }> {
  return withTenant(prisma, tenantId, async (transaction) => {
    const existing = await transaction.operatorAlertDispatch.findFirst({
      where: { tenantId, kind: observation.kind },
    })
    const decision = decideOperatorAlert(observation, existing?.lastSentAt ?? null, now)

    if (!decision.send) {
      if (decision.reason === 'QUIET_PERIOD' && existing) {
        await transaction.operatorAlertDispatch.update({
          where: { id: existing.id },
          data: {
            lastObservedCount: observation.count,
            suppressedSinceLastSend: { increment: 1 },
            updatedAt: now,
          },
        })
      }
      return {
        send: false,
        counted: decision.reason === 'QUIET_PERIOD',
        severity: decision.severity,
      }
    }

    await transaction.operatorAlertDispatch.upsert({
      where: { tenantId_kind: { tenantId, kind: observation.kind } },
      update: {
        lastSentAt: now,
        lastObservedCount: observation.count,
        suppressedSinceLastSend: 0,
        sendCount: { increment: 1 },
        updatedAt: now,
      },
      create: {
        tenantId,
        kind: observation.kind,
        lastSentAt: now,
        lastObservedCount: observation.count,
        sendCount: 1,
        updatedAt: now,
      },
    })
    return { send: true, counted: false, severity: decision.severity }
  })
}

/** Give the claim back when nothing was actually sent under it. */
async function releaseClaim(
  prisma: PrismaClient,
  tenantId: string,
  kind: OperatorAlertKind,
  now: Date,
): Promise<void> {
  await withTenant(prisma, tenantId, async (transaction) => {
    await transaction.operatorAlertDispatch.updateMany({
      where: { tenantId, kind },
      data: {
        lastSentAt: null,
        sendCount: { decrement: 1 },
        lastOutcome: 'NO_AUDIENCE',
        updatedAt: now,
      },
    })
  })
}

async function recordOutcome(
  prisma: PrismaClient,
  tenantId: string,
  kind: OperatorAlertKind,
  outcome: string,
  now: Date,
): Promise<void> {
  await withTenant(prisma, tenantId, async (transaction) => {
    await transaction.operatorAlertDispatch.updateMany({
      where: { tenantId, kind },
      // A send that failed releases its claim, so the next sweep tries again
      // rather than waiting out a quiet period for a message nobody received.
      data: {
        lastOutcome: outcome.slice(0, 32),
        ...(outcome === 'SENT' ? {} : { lastSentAt: null }),
        updatedAt: now,
      },
    })
  })
}

async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'Serializable' },
  )
}

function toFa(value: number): string {
  return value.toLocaleString('fa-IR')
}
