import { randomUUID } from 'node:crypto'

import type { ResponseMeta } from '@alo-noon/contracts'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { orderRatingInputSchema, uuidSchema } from '@alo-noon/contracts'

import { authenticatedCustomer, type CommerceDependencies } from './commerce.js'
import { EngagementError, type EngagementService } from './engagement.js'

/**
 * Coming back: ordering again, saying how it was, keeping a favourite.
 *
 * Every route here is scoped to the session's own customer and takes no
 * identifier it does not then re-resolve under that customer. There is nothing
 * to authorise beyond being signed in, because there is nothing here a customer
 * can name that is not already theirs.
 */

export interface EngagementDependencies {
  service: EngagementService
  auth: CommerceDependencies['auth']
  now?: () => Date
}

const ENGAGEMENT_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export function registerEngagementRoutes(
  app: FastifyInstance,
  dependencies: EngagementDependencies,
): void {
  /**
   * Order it again.
   *
   * Rebuilds the basket from a past order at today's prices — never the prices
   * that order was placed at — and replaces whatever was in the basket rather
   * than merging into it. "Order again" means yesterday's order, and quietly
   * mixing it with something else produces a basket the customer never chose.
   */
  app.post<{ Params: { orderId: string } }>(
    '/api/v1/orders/:orderId/reorder',
    ENGAGEMENT_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = await authenticatedCustomer(request, dependencies.auth)
      if (!session) return unauthorized(reply)
      if (!uuidSchema.safeParse(request.params.orderId).success) {
        return reply.code(404).send(envelope('ORDER_NOT_FOUND', 'سفارش یافت نشد.'))
      }

      try {
        const result = await dependencies.service.reorder(
          session.tenantId,
          session.customerId,
          request.params.orderId,
          dependencies.now?.() ?? new Date(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: result, meta: meta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { orderId: string } }>(
    '/api/v1/orders/:orderId/rating',
    ENGAGEMENT_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = await authenticatedCustomer(request, dependencies.auth)
      if (!session) return unauthorized(reply)
      const parsed = orderRatingInputSchema.safeParse(request.body)
      if (!uuidSchema.safeParse(request.params.orderId).success || !parsed.success) {
        return reply.code(400).send(envelope('INVALID_RATING', 'امتیاز معتبر نیست.'))
      }

      try {
        const rating = await dependencies.service.rateOrder(
          session.tenantId,
          session.customerId,
          request.params.orderId,
          // Rebuilt rather than passed through: zod leaves optional keys
          // present-and-undefined, which `exactOptionalPropertyTypes` treats as
          // a different thing from absent — and the domain reads absence.
          {
            breadScore: parsed.data.breadScore,
            ...(parsed.data.deliveryScore !== undefined && {
              deliveryScore: parsed.data.deliveryScore,
            }),
            ...(parsed.data.comment !== undefined && { comment: parsed.data.comment }),
          },
          dependencies.now?.() ?? new Date(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: rating, meta: meta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )

  app.get<{ Params: { orderId: string } }>(
    '/api/v1/orders/:orderId/rating',
    ENGAGEMENT_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = await authenticatedCustomer(request, dependencies.auth)
      if (!session) return unauthorized(reply)
      if (!uuidSchema.safeParse(request.params.orderId).success) {
        return reply.code(404).send(envelope('RATING_NOT_FOUND', 'امتیازی ثبت نشده است.'))
      }

      try {
        const rating = await dependencies.service.findRating(
          session.tenantId,
          session.customerId,
          request.params.orderId,
        )
        if (!rating) {
          return reply.code(404).send(envelope('RATING_NOT_FOUND', 'امتیازی ثبت نشده است.'))
        }
        return reply.send({ success: true, data: rating, meta: meta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )

  app.get('/api/v1/favourites', ENGAGEMENT_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticatedCustomer(request, dependencies.auth)
    if (!session) return unauthorized(reply)

    try {
      const favourites = await dependencies.service.listFavourites(
        session.tenantId,
        session.customerId,
      )
      return reply.send({ success: true, data: favourites, meta: meta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.put<{ Params: { offeringId: string } }>(
    '/api/v1/favourites/:offeringId',
    ENGAGEMENT_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = await authenticatedCustomer(request, dependencies.auth)
      if (!session) return unauthorized(reply)
      if (!uuidSchema.safeParse(request.params.offeringId).success) {
        return reply.code(404).send(envelope('OFFERING_NOT_FOUND', 'این نان یافت نشد.'))
      }

      try {
        await dependencies.service.addFavourite(
          session.tenantId,
          session.customerId,
          request.params.offeringId,
        )
        return reply.code(204).send()
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )

  app.delete<{ Params: { offeringId: string } }>(
    '/api/v1/favourites/:offeringId',
    ENGAGEMENT_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = await authenticatedCustomer(request, dependencies.auth)
      if (!session) return unauthorized(reply)
      if (!uuidSchema.safeParse(request.params.offeringId).success) {
        // Removing something that was never there is the state the caller
        // wanted, so it is not a failure.
        return reply.code(204).send()
      }

      try {
        await dependencies.service.removeFavourite(
          session.tenantId,
          session.customerId,
          request.params.offeringId,
        )
        return reply.code(204).send()
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )
}

/**
 * What each refusal means, in words a customer can act on.
 *
 * Each of these sends somebody somewhere different — wait until it arrives, you
 * already did this, that was too long ago, pick something else — which is the
 * whole reason they are separate codes rather than one.
 */
const ENGAGEMENT_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_NOT_FOUND: 'سفارش یافت نشد.',
  OFFERING_NOT_FOUND: 'این نان یافت نشد.',
  RATING_ORDER_NOT_DELIVERED: 'پس از تحویل سفارش می‌توانید امتیاز بدهید.',
  RATING_ALREADY_SUBMITTED: 'برای این سفارش قبلاً امتیاز ثبت کرده‌اید.',
  RATING_WINDOW_CLOSED: 'مهلت امتیازدهی به این سفارش گذشته است.',
  RATING_INVALID_SCORE: 'امتیاز باید عددی بین ۱ تا ۵ باشد.',
  RATING_COMMENT_TOO_LONG: 'یادداشت طولانی‌تر از حد مجاز است.',
  REORDER_EMPTY: 'این سفارش قلمی برای تکرار ندارد.',
  REORDER_NOTHING_AVAILABLE: 'هیچ‌کدام از نان‌های این سفارش الان موجود نیست.',
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EngagementError) {
    return reply
      .code(error.status)
      .send(envelope(error.code, ENGAGEMENT_MESSAGES[error.code] ?? 'درخواست انجام نشد.'))
  }
  request.log.error({ err: error }, 'engagement request failed')
  return reply.code(500).send(envelope('ENGAGEMENT_UNAVAILABLE', 'این بخش در دسترس نیست.'))
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send(envelope('SESSION_UNAUTHORIZED', 'برای ادامه وارد شوید.'))
}

function envelope(code: string, message: string) {
  return { success: false as const, error: { code, message }, meta: meta() }
}

/**
 * The published envelope shape, which is `version` and not `apiVersion`.
 *
 * These routes shipped with the wrong key. Nothing noticed because the web
 * client does not validate the responses it receives — the mobile one does, and
 * every reorder from the phone failed with "the service reply was not valid"
 * while the server happily returned 201.
 */
function meta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}
