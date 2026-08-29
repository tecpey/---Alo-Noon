import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  composePushMessage,
  notificationPurposeForEvent,
  renderMessageTemplate,
  selectAuthenticationProvider,
  selectPushDevices,
  type AuthenticationCredentialResolver,
  type AuthenticationDeliveryEnvironment,
  type MessageTemplatePurpose,
  type PushMessageProvider,
  type TextMessageProvider,
} from '@alo-noon/domain'

import type { AdminMessagingService } from './admin-messaging.js'
import type { PushDeviceService } from './push-devices.js'

/**
 * Telling a customer what happened to their order.
 *
 * Driven by the domain outbox rather than called from the order routes, for one
 * reason that matters: an order transition and its notification must not share a
 * fate. If sending were inline, a gateway that was slow or down would either
 * fail the transition an operator just made — leaving the order where it was
 * while the bakery has already put the bread in a bag — or be swallowed, in
 * which case nothing would ever retry it. The event is committed with the
 * transition; the send is a separate act that can fail and be tried again.
 *
 * At-least-once delivery of an event would be at-least-once delivery of a text
 * message, which the customer experiences as being pestered. `CustomerNotification`
 * is what fixes that: its unique key over tenant, order and purpose means the
 * second attempt to say the same thing loses the race and sends nothing.
 */
export type NotificationOutcome =
  'SENT' | 'ALREADY_HANDLED' | 'NOT_APPLICABLE' | 'SUPPRESSED' | 'FAILED'

export interface OutboxEvent {
  readonly name: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly correlationId: string
}

export interface CustomerNotificationService {
  notify(tenantId: string, event: OutboxEvent, now: Date): Promise<NotificationOutcome>
}

export interface CustomerNotificationOptions {
  readonly providers: readonly TextMessageProvider[]
  readonly credentialResolver: AuthenticationCredentialResolver
  readonly environment: AuthenticationDeliveryEnvironment
  readonly messagingService: AdminMessagingService
  readonly timeoutMs?: number
  /**
   * The free channel, when one is configured.
   *
   * Optional so that a deployment without push behaves exactly as it did
   * before: every message goes by SMS and nothing here is reached. Push is an
   * improvement to the cost of a working system, not a dependency of it.
   */
  readonly push?: {
    readonly provider: PushMessageProvider
    readonly devices: PushDeviceService
  }
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * A push is given less time than an SMS.
 *
 * It is the first of two attempts, and the customer is waiting on the result of
 * the second. Ten seconds spent on a push service that has stopped answering is
 * ten seconds added to a message that was always going to be a text.
 */
const PUSH_TIMEOUT_MS = 4_000

export function createPrismaCustomerNotificationService(
  prisma: PrismaClient,
  options: CustomerNotificationOptions,
): CustomerNotificationService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async notify(tenantId, event, now) {
      const purpose = notificationPurposeForEvent(event.name, event.payload)
      if (!purpose) return 'NOT_APPLICABLE'
      // A delivery event is about an order without being keyed on one, so it
      // names the order in its payload. Anything else is not ours.
      const orderId =
        event.aggregateType === 'order'
          ? event.aggregateId
          : typeof event.payload['orderId'] === 'string'
            ? event.payload['orderId']
            : null
      if (!orderId) return 'NOT_APPLICABLE'

      const order = await readOrder(prisma, tenantId, orderId)
      if (!order) return 'NOT_APPLICABLE'

      const template = await options.messagingService.resolve(tenantId, 'SMS', purpose)
      const body = renderMessageTemplate(template.body, {
        orderCode: order.publicId,
        customerName: order.recipientNameSnapshot,
        bakeryName: order.bakeryNameSnapshot,
        total: new Intl.NumberFormat('fa-IR').format(order.totalAmount),
        ...(typeof event.payload['reason'] === 'string' && {
          reason: event.payload['reason'],
        }),
      })

      // A row is claimed before anything is sent, and a claim that loses to a
      // unique index means someone else already dealt with this step.
      const claimed = await claim(prisma, tenantId, {
        orderId: order.id,
        purpose,
        body,
        mobileE164: order.recipientPhoneSnapshot,
        templateVersion: template.version,
        correlationId: event.correlationId,
        state: template.enabled ? 'PENDING' : 'SUPPRESSED',
      })
      if (!claimed) return 'ALREADY_HANDLED'
      if (!template.enabled) return 'SUPPRESSED'

      // Push first, because it is free and lands on the handset the customer is
      // already holding. A refusal is not the end of the message — the SMS
      // below carries it, and the row records which channel actually did.
      const pushed = await tryPush(options, tenantId, {
        customerId: order.customerId,
        purpose,
        body,
        orderId: order.id,
        orderCode: order.publicId,
        now,
      })
      if (pushed) {
        await settle(prisma, tenantId, claimed.id, pushed.result, {
          channel: 'PUSH',
          pushDeviceId: pushed.deviceId,
        })
        return 'SENT'
      }

      const result = await send(prisma, options, tenantId, {
        mobileE164: order.recipientPhoneSnapshot,
        body,
        idempotencyKey: claimed.id,
        timeoutMs,
        now,
      })

      await settle(prisma, tenantId, claimed.id, result)
      return result.outcome === 'DELIVERED' ? 'SENT' : 'FAILED'
    },
  }
}

async function readOrder(prisma: PrismaClient, tenantId: string, orderId: string) {
  // ownership-established: the id comes from a committed domain event this
  // system wrote about that order, not from any request, so there is no caller
  // whose ownership could be in question. The message goes *to* whoever the
  // order says it belongs to — its own phone snapshot decides that, below.
  return readTransaction(prisma, tenantId, (transaction) =>
    transaction.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        publicId: true,
        customerId: true,
        recipientNameSnapshot: true,
        recipientPhoneSnapshot: true,
        bakeryNameSnapshot: true,
        totalAmount: true,
      },
    }),
  )
}

interface Claim {
  orderId: string
  purpose: MessageTemplatePurpose
  body: string
  mobileE164: string
  templateVersion: number
  correlationId: string
  state: 'PENDING' | 'SUPPRESSED'
}

async function claim(
  prisma: PrismaClient,
  tenantId: string,
  input: Claim,
): Promise<{ id: string } | null> {
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return transaction.customerNotification.create({
        data: {
          tenantId,
          orderId: input.orderId,
          channel: 'SMS',
          purpose: input.purpose,
          state: input.state,
          body: input.body,
          mobileE164: input.mobileE164,
          templateVersion: input.templateVersion,
          correlationId: input.correlationId,
          attempts: input.state === 'PENDING' ? 1 : 0,
        },
        select: { id: true },
      })
    })
  } catch (error) {
    // The only expected collision is the identity key, which is exactly the
    // outcome this design wants: the message was already dealt with.
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'P2002') return null
    throw error
  }
}

interface PushAttempt {
  customerId: string
  purpose: MessageTemplatePurpose
  body: string
  orderId: string
  orderCode: string
  now: Date
}

/**
 * Tries the customer's handsets, and reports only an actual delivery.
 *
 * Returns null for every other outcome — no push configured, no live device,
 * a service that would not answer, a token the service has retired — because
 * the caller's next move is the same in all of them: send the text message.
 * Distinguishing "no device" from "device refused" here would give the caller a
 * choice it does not have.
 *
 * Devices are tried in order and the loop stops at the first success. It does
 * not stop at the first failure: somebody whose old tablet is retired but whose
 * phone works should be reached on the phone rather than sent an SMS because
 * the tablet was tried first.
 *
 * Every verdict is written back to the device, which is what stops a retired
 * token being tried again on the next order.
 */
async function tryPush(
  options: CustomerNotificationOptions,
  tenantId: string,
  input: PushAttempt,
): Promise<{
  result: { outcome: string; providerReference?: string; code: string }
  deviceId: string
} | null> {
  const push = options.push
  if (!push) return null

  const message = composePushMessage({
    purpose: input.purpose,
    body: input.body,
    orderId: input.orderId,
    orderCode: input.orderCode,
  })
  // A purpose the domain will not put on a lock screen — a sign-in code above
  // all. Not an error, and not something to work around here.
  if (!message) return null

  let devices
  try {
    devices = selectPushDevices(
      await push.devices.listForCustomer(tenantId, input.customerId),
      input.now,
    )
  } catch {
    // A device registry that will not answer must not stop the SMS.
    return null
  }

  for (const device of devices) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
    let sent
    try {
      sent = await push.provider.sendPush({
        token: device.expoPushToken,
        message,
        timeoutMs: PUSH_TIMEOUT_MS,
        signal: controller.signal,
      })
    } catch {
      sent = { outcome: 'UNKNOWN' as const, normalizedCode: 'PROVIDER_OUTCOME_UNKNOWN' }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }

    // Recorded before the loop continues, so a token the service retired is
    // disabled even when a later device carries the message.
    await push.devices
      .recordOutcome(
        tenantId,
        device.id,
        { delivered: sent.outcome === 'DELIVERED', code: sent.normalizedCode },
        input.now,
      )
      .catch(() => undefined)

    if (sent.outcome === 'DELIVERED') {
      return {
        deviceId: device.id,
        result: {
          outcome: 'DELIVERED',
          ...(sent.providerReference !== undefined && {
            providerReference: sent.providerReference,
          }),
          code: sent.normalizedCode ?? 'UNSPECIFIED',
        },
      }
    }
  }

  return null
}

interface SendInput {
  mobileE164: string
  body: string
  idempotencyKey: string
  timeoutMs: number
  now: Date
}

async function send(
  prisma: PrismaClient,
  options: CustomerNotificationOptions,
  tenantId: string,
  input: SendInput,
): Promise<{ outcome: string; providerReference?: string | undefined; code: string }> {
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

async function settle(
  prisma: PrismaClient,
  tenantId: string,
  notificationId: string,
  result: { outcome: string; providerReference?: string | undefined; code: string },
  /**
   * Set when a push carried the message. The row was claimed as SMS because
   * that is what would have happened, so the channel is corrected here by the
   * attempt that actually succeeded rather than guessed at claim time — a claim
   * that named PUSH and then fell back to SMS would leave the record lying
   * about which one the customer received.
   */
  via?: { channel: 'PUSH'; pushDeviceId: string },
): Promise<void> {
  // A provider that accepted the message without naming it leaves nothing to
  // point at when a customer says it never arrived, so the reference falls back
  // to the reason. The database requires one on a sent row.
  const sent = result.outcome === 'DELIVERED'
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.customerNotification.update({
      where: { id: notificationId },
      data: sent
        ? {
            state: 'SENT',
            providerReference: result.providerReference ?? result.code,
            ...(via && { channel: via.channel, pushDeviceId: via.pushDeviceId }),
          }
        : { state: 'FAILED', failureCode: result.code.slice(0, 64) },
    })
  })
}

async function readTransaction<T>(
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
