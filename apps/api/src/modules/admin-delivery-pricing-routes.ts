import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  publishDeliveryTariffCommandSchema,
  setAreaMotorcycleCommandSchema,
  setCityVehicleThresholdsCommandSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import {
  AdminDeliveryPricingError,
  type AdminDeliveryPricingService,
} from './admin-delivery-pricing.js'

/**
 * Staff routes for delivery tariffs, city thresholds and car-only areas.
 *
 * One permission across all three, because an operator setting one is almost
 * always about to set another: tightening a city's motorcycle range and
 * publishing the car tariff that catches what falls outside it are two halves
 * of a single decision, and a role that could do only one half would leave the
 * city refusing orders between the two saves.
 */
const DELIVERY_PRICING_PERMISSION = ADMIN_PERMISSIONS.deliveryPricingManage

// Deliberate, human-paced acts — a handful of tariffs across a handful of
// cities. Generous enough to correct a mistake immediately, small enough that a
// stolen session cannot rewrite every fare in the country.
const DELIVERY_PRICING_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export interface AdminDeliveryPricingDependencies extends AdminAuthDependencies {
  service: AdminDeliveryPricingService
}

export function registerAdminDeliveryPricingRoutes(
  app: FastifyInstance,
  dependencies: AdminDeliveryPricingDependencies,
): void {
  const now = (): Date => dependencies.now?.() ?? new Date()

  app.get('/api/v1/admin/delivery/cities', DELIVERY_PRICING_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      DELIVERY_PRICING_PERMISSION,
    )
    if (!actor) return reply
    try {
      return reply.send({
        success: true,
        data: await dependencies.service.listCities(actor.tenantId),
        meta: adminResponseMeta(),
      })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.get('/api/v1/admin/delivery/tariffs', DELIVERY_PRICING_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      DELIVERY_PRICING_PERMISSION,
    )
    if (!actor) return reply
    const cityId = readCityId(request.query)
    try {
      return reply.send({
        success: true,
        data: await dependencies.service.listTariffs(actor.tenantId, cityId),
        meta: adminResponseMeta(),
      })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/delivery/tariffs', DELIVERY_PRICING_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      DELIVERY_PRICING_PERMISSION,
    )
    if (!actor) return reply
    const parsed = publishDeliveryTariffCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_TARIFF_COMMAND', 'The delivery tariff is invalid.'))
    }
    try {
      const tariff = await dependencies.service.publishTariff(
        actor.tenantId,
        {
          cityId: parsed.data.cityId,
          ...(parsed.data.operationalZoneId && {
            operationalZoneId: parsed.data.operationalZoneId,
          }),
          vehicleProfile: parsed.data.vehicleProfile,
          calculationMode: parsed.data.calculationMode,
          baseFeeAmount: BigInt(parsed.data.baseFeeAmount),
          perKilometerFeeAmount: BigInt(parsed.data.perKilometerFeeAmount),
          ...(parsed.data.minimumOrderAmount !== undefined && {
            minimumOrderAmount: BigInt(parsed.data.minimumOrderAmount),
          }),
          ...(parsed.data.freeDeliveryThreshold !== undefined && {
            freeDeliveryThreshold: BigInt(parsed.data.freeDeliveryThreshold),
          }),
        },
        now(),
      )
      return reply.code(201).send({ success: true, data: tariff, meta: adminResponseMeta() })
    } catch (error) {
      return failure(request, reply, error)
    }
  })

  app.post(
    '/api/v1/admin/delivery/cities/:cityId/thresholds',
    DELIVERY_PRICING_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        DELIVERY_PRICING_PERMISSION,
      )
      if (!actor) return reply
      const { cityId } = request.params as { cityId: string }
      const parsed = setCityVehicleThresholdsCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_THRESHOLDS', 'The thresholds are invalid.'))
      }
      try {
        const city = await dependencies.service.setCityThresholds(
          actor.tenantId,
          cityId,
          parsed.data,
        )
        return reply.send({ success: true, data: city, meta: adminResponseMeta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )

  app.post(
    '/api/v1/admin/delivery/areas/:areaId/motorcycle',
    DELIVERY_PRICING_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        DELIVERY_PRICING_PERMISSION,
      )
      if (!actor) return reply
      const { areaId } = request.params as { areaId: string }
      const parsed = setAreaMotorcycleCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_AREA_COMMAND', 'The request is invalid.'))
      }
      try {
        const area = await dependencies.service.setAreaMotorcycleAllowed(
          actor.tenantId,
          areaId,
          parsed.data.motorcycleAllowed,
        )
        return reply.send({ success: true, data: area, meta: adminResponseMeta() })
      } catch (error) {
        return failure(request, reply, error)
      }
    },
  )
}

function readCityId(query: unknown): string | undefined {
  if (!query || typeof query !== 'object') return undefined
  const value = (query as Record<string, unknown>)['cityId']
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AdminDeliveryPricingError) {
    const messages: Record<string, string> = {
      CITY_NOT_FOUND: 'The city was not found.',
      AREA_NOT_FOUND: 'The service area was not found.',
      ZONE_NOT_IN_CITY: 'That operational zone does not belong to that city.',
      DISTANCE_TARIFF_NEEDS_RATE: 'A distance tariff needs a per-kilometre rate above zero.',
      FREE_THRESHOLD_BELOW_MINIMUM: 'Free delivery cannot start below the minimum order amount.',
      THRESHOLD_NOT_POSITIVE: 'A threshold must be a positive number, or empty for the default.',
    }
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, messages[error.code] ?? 'The request was rejected.'))
  }
  request.log.error({ err: error }, 'Admin delivery pricing request failed')
  return reply
    .code(503)
    .send(errorEnvelope('DELIVERY_PRICING_UNAVAILABLE', 'Delivery pricing is unavailable.'))
}
