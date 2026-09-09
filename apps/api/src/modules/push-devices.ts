import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  pushDeviceRegisterSchema,
  expoPushTokenSchema,
  type ErrorEnvelope,
  type PushDeviceSummary,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import { pushFailureIsPermanent, type PushDeviceRecord } from '@alo-noon/domain'

import { authenticatedCustomer } from './commerce.js'
import type { AuthDependencies } from './auth.js'

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
 */
export interface PushDeviceService {
  register(
    tenantId: string,
    customerId: string,
    input: { expoPushToken: string; platform: 'IOS' | 'ANDROID' },
    now: Date,
  ): Promise<PushDeviceSummary>
  /** Called on sign-out. Silent when the token is not ours to forget. */
  forget(tenantId: string, customerId: string, expoPushToken: string): Promise<void>
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

export function createPrismaPushDeviceService(prisma: PrismaClient): PushDeviceService {
  return {
    async register(tenantId, customerId, input, now) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const device = await transaction.customerPushDevice.upsert({
          where: {
            // ownership-established: the row is addressed by tenant and token,
            // and the customerId written below comes from the authenticated
            // session rather than from the request body.
            tenantId_expoPushToken: { tenantId, expoPushToken: input.expoPushToken },
          },
          create: {
            tenantId,
            customerId,
            expoPushToken: input.expoPushToken,
            platform: input.platform,
            lastSeenAt: now,
          },
          update: {
            // The takeover. A handset that another account signed out of and
            // this one signed into belongs to this one now.
            customerId,
            platform: input.platform,
            lastSeenAt: now,
            // Re-registering is the device saying it is alive, which is the
            // only evidence that would overturn a retirement.
            enabled: true,
            disabledReason: null,
            disabledAt: null,
          },
          select: { id: true, platform: true, enabled: true, lastSeenAt: true },
        })
        return {
          id: device.id,
          platform: device.platform,
          enabled: device.enabled,
          lastSeenAt: device.lastSeenAt.toISOString(),
        }
      })
    },

    async forget(tenantId, customerId, expoPushToken) {
      await withTenant(prisma, tenantId, async (transaction) => {
        // Scoped to the customer as well as the token: signing out must not let
        // a caller unregister a handset that is no longer theirs.
        await transaction.customerPushDevice.deleteMany({
          where: { tenantId, customerId, expoPushToken },
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
            expoPushToken: true,
            platform: true,
            enabled: true,
            lastSeenAt: true,
          },
        })
        return devices
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

export interface PushDeviceDependencies {
  service: PushDeviceService
  auth: AuthDependencies
  now?: () => Date
}

export function registerPushDeviceRoutes(
  app: FastifyInstance,
  dependencies: PushDeviceDependencies,
): void {
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

    const token = expoPushTokenSchema.safeParse(
      (request.body as { expoPushToken?: unknown } | null)?.expoPushToken,
    )
    // Forgetting something that was never registered is the state the caller
    // wanted, so a token this API would never have issued is not an error.
    if (!token.success) return reply.code(204).send()

    try {
      await dependencies.service.forget(customer.tenantId, customer.customerId, token.data)
      return reply.code(204).send()
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
