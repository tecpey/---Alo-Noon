import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  pushDeviceRegisterSchema,
  expoPushTokenSchema,
  webPushSubscriptionSchema,
  type ErrorEnvelope,
  type PushDeviceRegister,
  type PushDeviceSummary,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import { pushFailureIsPermanent, type PushDeviceRecord } from '@alo-noon/domain'

import { authenticatedCustomer } from './commerce.js'
import { resolveTenantId, type AuthDependencies } from './auth.js'

/**
 * The handsets a customer can be reached on.
 *
 * Registration is a PUT rather than a POST because it is not a creation: the
 * app calls it on every sign-in and every cold start, and the right answer to
 * "this token again" is to move the row's clock forward, not to accumulate a
 * row per launch. That also makes it the repair path — a device the push
 * service retired comes back the next time the app opens, which is exactly when
 * we know the app exists again.
 *
 * A token addresses an installation, not a person, so registering one that
 * belongs to another customer takes it over. Two people signing in on the same
 * handset must not both be reachable on it: the second would receive the
 * first's order notifications on a phone they do not own.
 *
 * All of that is equally true of a browser, whose subscription endpoint plays
 * the part the token plays. The two live in one table because they are the same
 * fact — a place this customer can be reached — and because the dispatch path
 * tries them in one last-seen order, so somebody with the app on their phone
 * and the shop on their tablet is reached on whichever they last opened.
 */
export interface PushDeviceService {
  register(
    tenantId: string,
    customerId: string,
    input: PushDeviceRegister,
    now: Date,
  ): Promise<PushDeviceSummary>
  /**
   * Called on sign-out. Silent when the address is not ours to forget.
   *
   * Takes whichever address the client holds. A browser knows its endpoint and
   * has never seen an Expo token, and the reverse for a handset.
   */
  forget(tenantId: string, customerId: string, address: PushDeviceAddress): Promise<void>
  /** The devices a notification may try, newest registration first. */
  listForCustomer(tenantId: string, customerId: string): Promise<PushDeviceRecord[]>
  /**
   * Records what the push service said about a device.
   *
   * A permanent refusal retires the token; anything else only moves the success
   * clock, because a device is not dead for having been unreachable once.
   */
  recordOutcome(
    tenantId: string,
    deviceId: string,
    outcome: { delivered: boolean; code?: string | undefined },
    now: Date,
  ): Promise<void>
}

/** Whichever address the client holds. */
export type PushDeviceAddress =
  | { readonly transport: 'EXPO'; readonly expoPushToken: string }
  | { readonly transport: 'WEB_PUSH'; readonly endpoint: string }

export function createPrismaPushDeviceService(prisma: PrismaClient): PushDeviceService {
  return {
    async register(tenantId, customerId, input, now) {
      return withTenant(prisma, tenantId, async (transaction) =>
        input.platform === 'WEB'
          ? registerBrowser(transaction, tenantId, customerId, input.subscription, now)
          : registerHandset(transaction, tenantId, customerId, input, now),
      )
    },

    async forget(tenantId, customerId, address) {
      await withTenant(prisma, tenantId, async (transaction) => {
        // Scoped to the customer as well as the address: signing out must not
        // let a caller unregister a device that is no longer theirs.
        await transaction.customerPushDevice.deleteMany({
          where: {
            tenantId,
            customerId,
            ...(address.transport === 'EXPO'
              ? { expoPushToken: address.expoPushToken }
              : { webPushEndpoint: address.endpoint }),
          },
        })
      })
    },

    async listForCustomer(tenantId, customerId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const devices = await transaction.customerPushDevice.findMany({
          where: { tenantId, customerId },
          orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            transport: true,
            expoPushToken: true,
            webPushEndpoint: true,
            webPushP256dh: true,
            webPushAuth: true,
            platform: true,
            enabled: true,
            lastSeenAt: true,
          },
        })
        // The database CHECK guarantees each row's columns match its transport,
        // so a row that does not map is a row that could not have been written.
        // Dropped rather than thrown over: one impossible row must not cost a
        // customer every other device they own.
        return devices.flatMap((device): PushDeviceRecord[] => {
          if (device.transport === 'EXPO') {
            return device.expoPushToken
              ? [
                  {
                    transport: 'EXPO',
                    id: device.id,
                    expoPushToken: device.expoPushToken,
                    platform: device.platform,
                    enabled: device.enabled,
                    lastSeenAt: device.lastSeenAt,
                  },
                ]
              : []
          }
          return device.webPushEndpoint && device.webPushP256dh && device.webPushAuth
            ? [
                {
                  transport: 'WEB_PUSH',
                  id: device.id,
                  subscription: {
                    endpoint: device.webPushEndpoint,
                    p256dh: device.webPushP256dh,
                    auth: device.webPushAuth,
                  },
                  platform: device.platform,
                  enabled: device.enabled,
                  lastSeenAt: device.lastSeenAt,
                },
              ]
            : []
        })
      })
    },

    async recordOutcome(tenantId, deviceId, outcome, now) {
      await withTenant(prisma, tenantId, async (transaction) => {
        await transaction.customerPushDevice.updateMany({
          where: { id: deviceId, tenantId },
          data: outcome.delivered
            ? { lastSuccessAt: now }
            : pushFailureIsPermanent(outcome.code)
              ? {
                  enabled: false,
                  disabledReason: (outcome.code ?? 'PUSH_REJECTED').slice(0, 64),
                  disabledAt: now,
                }
              : {},
        })
      })
    },
  }
}

async function registerHandset(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  input: { expoPushToken: string; platform: 'IOS' | 'ANDROID' },
  now: Date,
): Promise<PushDeviceSummary> {
  const device = await transaction.customerPushDevice.upsert({
    where: {
      // ownership-established: the row is addressed by tenant and token, and
      // the customerId written below comes from the authenticated session
      // rather than from the request body.
      tenantId_expoPushToken: { tenantId, expoPushToken: input.expoPushToken },
    },
    create: {
      tenantId,
      customerId,
      transport: 'EXPO',
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      lastSeenAt: now,
    },
    update: {
      // The takeover. A handset that another account signed out of and this one
      // signed into belongs to this one now.
      customerId,
      platform: input.platform,
      lastSeenAt: now,
      // Re-registering is the device saying it is alive, which is the only
      // evidence that would overturn a retirement.
      enabled: true,
      disabledReason: null,
      disabledAt: null,
    },
    select: { id: true, platform: true, enabled: true, lastSeenAt: true },
  })
  return summary(device)
}

/**
 * The browser equivalent, written as SQL for one reason.
 *
 * The endpoint's unique index is partial — it covers only the rows where the
 * column is not null, because it is null for every handset and a plain unique
 * index over a nullable column permits everything it appears to prevent.
 * Prisma cannot express a partial index, so it does not know this one exists
 * and `upsert` cannot be pointed at it. `ON CONFLICT` can, by repeating the
 * index's own predicate, which is what makes concurrent registrations of the
 * same browser collapse into one row instead of one losing to a unique
 * violation.
 */
async function registerBrowser(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  now: Date,
): Promise<PushDeviceSummary> {
  const rows = await transaction.$queryRaw<
    Array<{ id: string; platform: 'IOS' | 'ANDROID' | 'WEB'; enabled: boolean; lastSeenAt: Date }>
  >`
    INSERT INTO "CustomerPushDevice" (
      "id", "tenantId", "customerId", "transport",
      "webPushEndpoint", "webPushP256dh", "webPushAuth",
      "platform", "enabled", "lastSeenAt", "updatedAt"
    )
    VALUES (
      gen_random_uuid(), ${tenantId}::uuid, ${customerId}::uuid, 'WEB_PUSH',
      ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth},
      'WEB', true, ${now}, ${now}
    )
    ON CONFLICT ("tenantId", "webPushEndpoint") WHERE "webPushEndpoint" IS NOT NULL
    DO UPDATE SET
      -- The takeover, exactly as for a handset: a browser the previous account
      -- signed out of belongs to whoever signed in after them.
      "customerId" = EXCLUDED."customerId",
      -- A browser may hand back the same endpoint with rotated keys. Sending to
      -- the old ones produces a payload it silently discards.
      "webPushP256dh" = EXCLUDED."webPushP256dh",
      "webPushAuth" = EXCLUDED."webPushAuth",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "updatedAt" = EXCLUDED."updatedAt",
      -- Subscribing again is the browser saying it is alive, which is the only
      -- evidence that would overturn a retirement.
      "enabled" = true,
      "disabledReason" = NULL,
      "disabledAt" = NULL
    RETURNING "id", "platform", "enabled", "lastSeenAt"
  `
  const device = rows[0]
  if (!device) {
    // `DO UPDATE` always returns its row, so an empty result is not a conflict
    // that was skipped — it is a shape this code does not understand, and
    // answering 503 is better than reporting a registration that did not
    // happen.
    throw new Error('Registering a browser returned no row')
  }
  return summary(device)
}

function summary(device: {
  id: string
  platform: 'IOS' | 'ANDROID' | 'WEB'
  enabled: boolean
  lastSeenAt: Date
}): PushDeviceSummary {
  return {
    id: device.id,
    platform: device.platform,
    enabled: device.enabled,
    lastSeenAt: device.lastSeenAt.toISOString(),
  }
}

export interface PushDeviceDependencies {
  service: PushDeviceService
  auth: AuthDependencies
  /**
   * The VAPID public key, when this deployment has one.
   *
   * Undefined is a real answer and means no web push is configured. The shop
   * then never asks a browser for notification permission, which matters more
   * than it sounds: on most browsers a refused permission is refused for good,
   * so a prompt that could not have worked costs the customer the chance to say
   * yes later.
   */
  webPushPublicKey?: string | undefined
  now?: () => Date
}

export function registerPushDeviceRoutes(
  app: FastifyInstance,
  dependencies: PushDeviceDependencies,
): void {
  /**
   * The key a browser needs before it can subscribe at all.
   *
   * Public by definition and useless on its own — it identifies this
   * application server to a push service and is what the browser binds its
   * subscription to. Served rather than built into the page because the page is
   * cached and the key is deployment configuration: a shop that rotates its
   * pair must not wait for every installed copy of the site to be
   * re-downloaded before anybody can subscribe again.
   *
   * Not authenticated, because a browser needs it before there is anybody to
   * authenticate. It is still resolved by host: the key is the same for every
   * tenant this deployment serves — it identifies the server to Google, Mozilla
   * and Apple rather than identifying a shop — but a request arriving under a
   * host that is nobody's shop should be answered the way every other request
   * under that host is, rather than this one route being the exception that
   * replies to anyone.
   *
   * Because the value does not vary by tenant, `Vary` is not needed and the
   * response is cacheable by a shared cache.
   */
  app.get('/api/v1/push/web-key', async (request, reply) => {
    const tenantId = await resolveTenantId(request, dependencies.auth)
    if (!tenantId) {
      reply.header('Cache-Control', 'no-store')
      return reply.code(404).send(envelope('TENANT_NOT_FOUND', 'No shop is served from this host.'))
    }
    // An hour. Long enough that this is not a request per page load, short
    // enough that a rotation reaches every installed copy within the morning.
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.send({
      success: true,
      data: { publicKey: dependencies.webPushPublicKey ?? null },
      meta: meta(),
    })
  })

  app.put('/api/v1/push/devices', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const parsed = pushDeviceRegisterSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope('INVALID_PUSH_DEVICE', 'Push device registration is invalid.'))
    }

    try {
      const device = await dependencies.service.register(
        customer.tenantId,
        customer.customerId,
        parsed.data,
        dependencies.now?.() ?? new Date(),
      )
      return reply.send({ success: true, data: device, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.delete('/api/v1/push/devices', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const address = readAddress(request.body)
    // Forgetting something that was never registered is the state the caller
    // wanted, so an address this API would never have issued is not an error.
    if (!address) return reply.code(204).send()

    try {
      await dependencies.service.forget(customer.tenantId, customer.customerId, address)
      return reply.code(204).send()
    } catch (error) {
      return failure(request, reply, error)
    }
  })
}

/**
 * Whichever address the sign-out carried, or nothing.
 *
 * A handset knows its Expo token and has never seen an endpoint; a browser
 * knows its endpoint and has never seen a token. Both are read rather than a
 * transport being demanded, so the shipped mobile apps keep sending the body
 * they already send.
 *
 * The endpoint is checked against the same schema that accepted it, so a
 * caller cannot pass a pattern here and delete devices that were never theirs
 * — `forget` is scoped to the customer as well, which is the second lock on
 * the same door.
 */
function readAddress(body: unknown): PushDeviceAddress | undefined {
  const payload = (body ?? {}) as { expoPushToken?: unknown; endpoint?: unknown }
  const token = expoPushTokenSchema.safeParse(payload.expoPushToken)
  if (token.success) return { transport: 'EXPO', expoPushToken: token.data }
  const endpoint = webPushSubscriptionSchema.shape.endpoint.safeParse(payload.endpoint)
  if (endpoint.success) return { transport: 'WEB_PUSH', endpoint: endpoint.data }
  return undefined
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
  return { requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function envelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: meta() }
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send(envelope('SESSION_REQUIRED', 'Sign in first.'))
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  request.log.error({ err: error }, 'push device registration failed')
  return reply
    .code(503)
    .send(envelope('PUSH_DEVICES_UNAVAILABLE', 'Push registration is temporarily unavailable.'))
}
