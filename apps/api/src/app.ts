import { createHash } from 'node:crypto'

import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance } from 'fastify'

import type {
  ErrorEnvelope,
  HealthResponse,
  ReadyResponse,
  ResponseMeta,
} from '@alo-noon/contracts'

import {
  registerDiscoveryRoutes,
  type CatalogRepository,
  type CityRepository,
  type DeliveryEstimateRepository,
  type ServiceabilityRepository,
} from './modules/discovery.js'
import {
  registerAuthRoutes,
  sessionTokenFromRequest,
  type AuthDependencies,
} from './modules/auth.js'
import {
  registerCommerceRoutes,
  type CommerceDependencies,
  type CommerceRepository,
} from './modules/commerce.js'
import { registerAddressRoutes, type AddressRepository } from './modules/addresses.js'
import type { RoutingService } from './modules/routing.js'
import { registerPushDeviceRoutes, type PushDeviceDependencies } from './modules/push-devices.js'
import { registerWalletRoutes, type WalletDependencies } from './modules/wallet.js'
import {
  registerWalletTransferRoutes,
  type WalletTransferDependencies,
} from './modules/wallet-transfer.js'
import { registerOrderRoutes, type OrderRepository } from './modules/orders.js'
import {
  registerPaymentExecutionRoutes,
  type PaymentExecutionService,
} from './modules/payment-execution.js'
import {
  registerPaymentCallbackRoutes,
  type PaymentCallbackDependencies,
} from './modules/payment-callback.js'
import {
  registerPaymentCheckoutRoutes,
  type PaymentCheckoutDependencies,
} from './modules/payment-checkout.js'
import {
  registerAdminProviderRoutes,
  type AdminProviderDependencies,
} from './modules/admin-providers.js'
import {
  registerAdminReportingRoutes,
  type AdminReportingDependencies,
} from './modules/admin-reporting.js'
import {
  registerAdminLogisticsRoutes,
  type AdminLogisticsDependencies,
} from './modules/admin-logistics.js'
import {
  registerAdminCatalogRoutes,
  type AdminCatalogDependencies,
} from './modules/admin-catalog-routes.js'
import {
  registerAdminDeliveryPricingRoutes,
  type AdminDeliveryPricingDependencies,
} from './modules/admin-delivery-pricing-routes.js'
import {
  registerAdminAccessRoutes,
  type AdminAccessDependencies,
} from './modules/admin-access-routes.js'
import {
  registerAdminMessagingRoutes,
  type AdminMessagingDependencies,
} from './modules/admin-messaging-routes.js'
import {
  registerCourierAssignmentRoutes,
  type CourierAssignmentDependencies,
} from './modules/courier-assignment-routes.js'
import {
  registerEngagementRoutes,
  type EngagementDependencies,
} from './modules/engagement-routes.js'
import { registerDeliveryRoutes, type DeliveryDependencies } from './modules/delivery-routes.js'
import {
  registerDeliveryTripRoutes,
  type DeliveryTripDependencies,
} from './modules/delivery-trip-routes.js'
import {
  registerOrderOperationsRoutes,
  type OrderOperationsDependencies,
} from './modules/order-operations-routes.js'
import {
  registerPartnerSettlementRoutes,
  type PartnerSettlementDependencies,
} from './modules/partner-settlement-routes.js'
import { registerBranchRoutes, type BranchDependencies } from './modules/branch-routes.js'
import {
  registerWalletWithdrawalRoutes,
  type WalletWithdrawalDependencies,
} from './modules/wallet-withdrawal-routes.js'

export interface AppOptions {
  readinessCheck?: () => Promise<boolean>
  authenticationDeliveryReadinessCheck?: () => Promise<boolean>
  catalogRepository?: CatalogRepository
  cityRepository?: CityRepository
  serviceabilityRepository?: ServiceabilityRepository
  /**
   * The published tariff, for showing the fare beside the bread. Optional
   * because a deployment without it renders no fare line, which is the
   * behaviour this application had before the route existed.
   */
  deliveryEstimateRepository?: DeliveryEstimateRepository
  auth?: AuthDependencies
  commerceRepository?: CommerceRepository
  addressRepository?: AddressRepository
  /**
   * Place search and reverse geocoding for the address form. Optional: a tenant
   * without mapping still takes orders from the satellite position, and the
   * routes answer `available: false` rather than disappearing, so the interface
   * knows to stop offering a search box instead of showing one that fails.
   */
  placesService?: RoutingService
  cityBias?: (
    tenantId: string,
    cityId: string,
  ) => Promise<{ latitude: number; longitude: number } | null>
  pushDevices?: Omit<PushDeviceDependencies, 'auth'>
  wallet?: Omit<WalletDependencies, 'auth'>
  walletTransfers?: Omit<WalletTransferDependencies, 'auth'>
  orderRepository?: OrderRepository
  paymentExecutionService?: PaymentExecutionService
  paymentCallback?: Omit<PaymentCallbackDependencies, 'auth'>
  paymentCheckout?: Omit<PaymentCheckoutDependencies, 'auth'>
  adminProviders?: Omit<AdminProviderDependencies, 'auth'>
  adminReporting?: Omit<AdminReportingDependencies, 'auth'>
  adminLogistics?: Omit<AdminLogisticsDependencies, 'auth'>
  adminCatalog?: Omit<AdminCatalogDependencies, 'auth'>
  adminDeliveryPricing?: Omit<AdminDeliveryPricingDependencies, 'auth'>
  adminAccess?: Omit<AdminAccessDependencies, 'auth'>
  adminMessaging?: Omit<AdminMessagingDependencies, 'auth'>
  orderOperations?: Omit<OrderOperationsDependencies, 'auth'>
  partnerSettlement?: Omit<PartnerSettlementDependencies, 'auth'>
  branch?: Omit<BranchDependencies, 'auth'>
  walletWithdrawals?: Omit<WalletWithdrawalDependencies, 'auth'>
  delivery?: Omit<DeliveryDependencies, 'auth'>
  deliveryTrips?: Omit<DeliveryTripDependencies, 'auth'>
  courierAssignments?: Omit<CourierAssignmentDependencies, 'auth'>
  engagement?: Omit<EngagementDependencies, 'auth'>
  corsOrigins?: string[]
  logger?: boolean
  /**
   * Which upstream addresses may say who the client is: an IP, a CIDR block, a
   * comma-separated list of either, or one of `proxy-addr`'s presets such as
   * `loopback`. Absent means no proxy is trusted.
   *
   * Was a hop count. Fastify 5.12 stopped honouring numbers here — a count
   * cannot identify the immediate peer, so a direct client could forge
   * `X-Forwarded-For` with enough entries and be believed — and now silently
   * trusts nothing when given one. Passing a number would have left this
   * service configured for a proxy, apparently healthy, and attributing every
   * request to the load balancer's address.
   */
  trustProxy?: string
}

const RATE_LIMIT_WINDOW = '1 minute'
const GLOBAL_RATE_LIMIT_MAX = 600

const unavailableCatalogRepository: CatalogRepository = {
  listProducts: async () => {
    throw new Error('Catalog repository unavailable')
  },
  findProduct: async () => {
    throw new Error('Catalog repository unavailable')
  },
}

const unavailableServiceabilityRepository: ServiceabilityRepository = {
  isCityActive: async () => {
    throw new Error('Serviceability repository unavailable')
  },
  listAreas: async () => {
    throw new Error('Serviceability repository unavailable')
  },
}

const unavailableCityRepository: CityRepository = {
  listActiveCities: async () => {
    throw new Error('City repository unavailable')
  },
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: [
              'req.remoteAddress',
              'req.remotePort',
              'req.headers.authorization',
              'req.headers.cookie',
            ],
            censor: '[REDACTED]',
          },
        }
      : false,
    logController: new LogController({ disableRequestLogging: options.logger === true }),
    trustProxy: options.trustProxy ?? false,
  })
  const readinessCheck = options.readinessCheck ?? (async () => true)

  // A forwarding header arriving while proxy trust is off is direct evidence the
  // API sits behind a proxy that was never declared. Every request then reports
  // the proxy's address, so rate limiting and OTP abuse control silently share
  // one bucket across all users. Warn once rather than per request.
  if (!options.trustProxy) {
    let warned = false
    app.addHook('onRequest', async (request) => {
      if (warned || !request.headers['x-forwarded-for']) return
      warned = true
      request.log.warn(
        'Received X-Forwarded-For while proxy trust is disabled: per-IP rate limiting and OTP abuse control are keying on the proxy address, not the client. Set API_TRUST_PROXY to the proxy\'s address — "loopback" when it runs on this host, otherwise its IP or CIDR block.',
      )
    })
  }

  await app.register(helmet, { contentSecurityPolicy: false })
  /**
   * The limiter's refusal, carrying the status it means.
   *
   * `@fastify/rate-limit` does not send this value — it **throws** it, and the
   * error handler below decides the status from `statusCode`. The builder used
   * to return the response envelope, which has no `statusCode`, so every
   * rate-limited request in this API answered **500 `INTERNAL_ERROR`** instead
   * of 429, and every one of them was logged at error level as "Unhandled
   * error".
   *
   * Three things followed, and the first is the worst: a 500 reads as "the shop
   * is broken", and the reasonable response to that is to try again — the exact
   * opposite of backing off, so the limiter added load instead of shedding it.
   * A customer sending money was told the service had failed at the moment it
   * was in fact protecting them. And genuine faults were buried in a log full
   * of "Unhandled error" lines that were nothing of the kind.
   *
   * `context.statusCode` rather than a literal 429: the plugin sets 403 when a
   * key is banned rather than merely over its limit, and that distinction is
   * the plugin's to make.
   */
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    /**
     * A signed-in customer is counted as themselves, not as their carrier.
     *
     * The plugin's default key is `request.ip`, and on a mobile network that is
     * not one person. Carrier-grade NAT puts many subscribers behind one public
     * IPv4 address — it is how mobile operators have coped with IPv4 exhaustion
     * for a decade, and this shop's customers are almost all on a phone. Under
     * an IP key they share one budget: the shop's busiest hour is exactly when
     * the most of them are on the same carrier, so the limiter would start
     * refusing real customers precisely when it must not, and each of them
     * would see a shop that had broken for no reason they could act on.
     *
     * The session cookie is the right key when there is one: it is per person,
     * it survives a changing IP as somebody walks between cells, and it is not
     * something a stranger can set on a victim's behalf to spend their budget.
     * Hashed, because this value is held in the limiter's store for the length
     * of the window and a session token is a credential — the limiter needs to
     * tell two people apart, not to know who they are.
     *
     * Anonymous traffic keeps the IP key. That is the correct trade for the one
     * case an IP key is actually for: somebody hammering the shop before they
     * have an account.
     */
    keyGenerator: (request) => {
      const token = sessionTokenFromRequest(request)
      if (token) return `s:${createHash('sha256').update(token).digest('base64url')}`
      return `i:${request.ip}`
    },
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('Too many requests. Please slow down and retry.'), {
        statusCode: context.statusCode ?? 429,
        code: 'RATE_LIMIT_EXCEEDED',
      }),
  })
  await app.register(cors, {
    origin: options.corsOrigins?.length ? options.corsOrigins : false,
    credentials: true,
    /**
     * The methods this API actually serves.
     *
     * Stated rather than left to the library, whose default is GET, HEAD and
     * POST. Under that default a browser on an allowed origin can read the
     * catalog and place an order but cannot change a basket item or sign out,
     * because the preflight for PUT and DELETE is refused — and refused as a
     * network error with no status, so the client reports "could not reach the
     * service" about a service it is talking to happily.
     *
     * The allow-list is the origin list above. Naming a method here grants
     * nothing to an origin that is not on it.
     */
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  /**
   * The two answers that were escaping the envelope.
   *
   * Every route in this API replies `{ success, data | error, meta }`, and two
   * paths never reached a route to do it: an unmatched URL and a body that is
   * not the JSON its own content-type claims. Fastify answered both in its own
   * shape — `{ statusCode, code, error, message }`, carrying an internal
   * framework code and no requestId — so a client that trusts the envelope met
   * a response it could not read, on the two failures it is most likely to
   * meet. The 404 also echoed the requested path straight back into the body,
   * which is nothing a caller needs to be told.
   *
   * A requestId on every one of them, because a failure a customer reports and
   * a line in the log are only the same event if something connects them.
   */
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send(errorEnvelope('ROUTE_NOT_FOUND', 'The requested endpoint does not exist.')),
  )

  app.setErrorHandler((raw: unknown, request, reply) => {
    // Typed narrowly rather than trusted: anything at all can be thrown, and a
    // handler that assumes an Error is a handler that throws inside itself on
    // the one request where somebody threw a string.
    const error = raw as { statusCode?: unknown; code?: unknown; message?: unknown }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    const code = typeof error.code === 'string' ? error.code : undefined
    const message = typeof error.message === 'string' ? error.message : ''

    // A 4xx is the caller's to fix and is logged at the level it deserves; a
    // 5xx is ours, and is the reason this handler logs at all.
    if (status >= 500) request.log.error({ err: raw }, 'Unhandled error')
    else request.log.warn({ err: raw, statusCode: status }, 'Request refused')

    // Never the thrown message on a 5xx. Whatever raised it was not written to
    // be read by a stranger, and the ones that are — a driver's error, a
    // provider's body — are exactly the ones that carry a hostname, a query or
    // a credential.
    if (status >= 500) {
      return reply
        .code(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'The service could not complete that request.'))
    }

    // Below 500 the message is Fastify's own validation or parsing sentence,
    // which says something true and useful about the request that was sent.
    //
    // The *code* is not: `FST_ERR_CTP_INVALID_JSON_BODY` names the framework
    // rather than the fault, and it is the framework's to rename on any
    // upgrade. Every code this API publishes is one it owns and keeps.
    const published = !code || code.startsWith('FST_ERR') ? 'INVALID_REQUEST' : code
    return reply.code(status).send(errorEnvelope(published, message || 'The request was refused.'))
  })

  registerDiscoveryRoutes(app, {
    catalogRepository: options.catalogRepository ?? unavailableCatalogRepository,
    cityRepository: options.cityRepository ?? unavailableCityRepository,
    serviceabilityRepository:
      options.serviceabilityRepository ?? unavailableServiceabilityRepository,
    ...(options.deliveryEstimateRepository && {
      deliveryEstimateRepository: options.deliveryEstimateRepository,
    }),
    ...(options.auth && { auth: options.auth }),
  })
  if (options.auth) registerAuthRoutes(app, options.auth)
  if (options.auth && options.commerceRepository) {
    const commerce: CommerceDependencies = {
      repository: options.commerceRepository,
      auth: options.auth,
    }
    registerCommerceRoutes(app, commerce)
  }
  if (options.auth && options.addressRepository) {
    registerAddressRoutes(app, {
      repository: options.addressRepository,
      auth: options.auth,
      ...(options.placesService && { places: options.placesService }),
      ...(options.cityBias && { cityBias: options.cityBias }),
    })
  }
  if (options.auth && options.orderRepository) {
    registerOrderRoutes(app, { repository: options.orderRepository, auth: options.auth })
  }
  if (options.auth && options.paymentExecutionService) {
    registerPaymentExecutionRoutes(app, {
      service: options.paymentExecutionService,
      auth: options.auth,
    })
  }
  if (options.auth && options.paymentCheckout) {
    registerPaymentCheckoutRoutes(app, { ...options.paymentCheckout, auth: options.auth })
  }
  if (options.auth && options.paymentCallback) {
    registerPaymentCallbackRoutes(app, { ...options.paymentCallback, auth: options.auth })
  }
  if (options.auth && options.adminProviders) {
    registerAdminProviderRoutes(app, { ...options.adminProviders, auth: options.auth })
  }
  if (options.auth && options.adminReporting) {
    registerAdminReportingRoutes(app, { ...options.adminReporting, auth: options.auth })
  }
  if (options.auth && options.adminLogistics) {
    registerAdminLogisticsRoutes(app, { ...options.adminLogistics, auth: options.auth })
  }
  if (options.auth && options.adminCatalog) {
    registerAdminCatalogRoutes(app, { ...options.adminCatalog, auth: options.auth })
  }
  if (options.auth && options.adminDeliveryPricing) {
    registerAdminDeliveryPricingRoutes(app, { ...options.adminDeliveryPricing, auth: options.auth })
  }
  if (options.auth && options.adminAccess) {
    registerAdminAccessRoutes(app, { ...options.adminAccess, auth: options.auth })
  }
  if (options.auth && options.adminMessaging) {
    registerAdminMessagingRoutes(app, { ...options.adminMessaging, auth: options.auth })
  }
  if (options.auth && options.orderOperations) {
    registerOrderOperationsRoutes(app, { ...options.orderOperations, auth: options.auth })
  }
  if (options.auth && options.partnerSettlement) {
    registerPartnerSettlementRoutes(app, { ...options.partnerSettlement, auth: options.auth })
  }
  if (options.auth && options.branch) {
    registerBranchRoutes(app, { ...options.branch, auth: options.auth })
  }
  if (options.auth && options.delivery) {
    registerDeliveryRoutes(app, { ...options.delivery, auth: options.auth })
  }
  if (options.auth && options.deliveryTrips) {
    registerDeliveryTripRoutes(app, { ...options.deliveryTrips, auth: options.auth })
  }
  if (options.auth && options.courierAssignments) {
    registerCourierAssignmentRoutes(app, { ...options.courierAssignments, auth: options.auth })
  }
  if (options.auth && options.engagement) {
    registerEngagementRoutes(app, { ...options.engagement, auth: options.auth })
  }
  if (options.auth && options.pushDevices) {
    registerPushDeviceRoutes(app, { ...options.pushDevices, auth: options.auth })
  }
  if (options.auth && options.walletTransfers) {
    registerWalletTransferRoutes(app, { ...options.walletTransfers, auth: options.auth })
  }
  if (options.auth && options.walletWithdrawals) {
    registerWalletWithdrawalRoutes(app, { ...options.walletWithdrawals, auth: options.auth })
  }
  if (options.auth && options.wallet) {
    registerWalletRoutes(app, { ...options.wallet, auth: options.auth })
  }

  /**
   * The two probes are outside the limiter.
   *
   * nginx only lets them in from this host, so every caller of `/ready` shares
   * the loopback address — the monitor, systemd, an operator's curl — and so
   * does anything else arriving without a forwarded client address. Found on
   * the bundled server under load: once that bucket ran dry, `/ready` answered
   * 429, and a monitor reads a 429 from a readiness probe as "down". An
   * outage alarm caused by the limiter, at exactly the moment traffic peaked.
   * Both are a single cheap read; there is nothing here to protect.
   */
  const probe = { config: { rateLimit: false } } as const

  app.get('/health', probe, async (): Promise<HealthResponse> => ({
    success: true,
    data: {
      status: 'healthy',
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? '0.0.1',
      checks: [{ name: 'process', status: 'pass' }],
    },
    meta: responseMeta(),
  }))

  app.get('/ready', probe, async (_request, reply): Promise<ReadyResponse> => {
    const databaseReady = await readinessCheck().catch(() => false)
    const authenticationDeliveryReady = options.authenticationDeliveryReadinessCheck
      ? await options.authenticationDeliveryReadinessCheck().catch(() => false)
      : true
    const ready = databaseReady && authenticationDeliveryReady
    if (!ready) reply.code(503)

    return {
      success: ready,
      data: {
        ready,
        checks: [
          {
            name: 'database',
            ready: databaseReady,
            ...(!databaseReady && { message: 'Database connection unavailable' }),
          },
          ...(options.authenticationDeliveryReadinessCheck
            ? [
                {
                  name: 'authentication-delivery',
                  ready: authenticationDeliveryReady,
                  ...(!authenticationDeliveryReady && {
                    message: 'Authentication delivery provider unavailable',
                  }),
                },
              ]
            : []),
        ],
      },
      meta: responseMeta(),
    }
  })

  return app
}

function responseMeta(): ResponseMeta {
  return {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
