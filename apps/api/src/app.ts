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
  type ServiceabilityRepository,
} from './modules/discovery.js'
import { registerAuthRoutes, type AuthDependencies } from './modules/auth.js'
import {
  registerCommerceRoutes,
  type CommerceDependencies,
  type CommerceRepository,
} from './modules/commerce.js'
import { registerAddressRoutes, type AddressRepository } from './modules/addresses.js'
import { registerPushDeviceRoutes, type PushDeviceDependencies } from './modules/push-devices.js'
import { registerWalletRoutes, type WalletDependencies } from './modules/wallet.js'
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

export interface AppOptions {
  readinessCheck?: () => Promise<boolean>
  authenticationDeliveryReadinessCheck?: () => Promise<boolean>
  catalogRepository?: CatalogRepository
  cityRepository?: CityRepository
  serviceabilityRepository?: ServiceabilityRepository
  auth?: AuthDependencies
  commerceRepository?: CommerceRepository
  addressRepository?: AddressRepository
  pushDevices?: Omit<PushDeviceDependencies, 'auth'>
  wallet?: Omit<WalletDependencies, 'auth'>
  orderRepository?: OrderRepository
  paymentExecutionService?: PaymentExecutionService
  paymentCallback?: Omit<PaymentCallbackDependencies, 'auth'>
  paymentCheckout?: Omit<PaymentCheckoutDependencies, 'auth'>
  adminProviders?: Omit<AdminProviderDependencies, 'auth'>
  adminReporting?: Omit<AdminReportingDependencies, 'auth'>
  adminLogistics?: Omit<AdminLogisticsDependencies, 'auth'>
  adminCatalog?: Omit<AdminCatalogDependencies, 'auth'>
  adminAccess?: Omit<AdminAccessDependencies, 'auth'>
  adminMessaging?: Omit<AdminMessagingDependencies, 'auth'>
  orderOperations?: Omit<OrderOperationsDependencies, 'auth'>
  delivery?: Omit<DeliveryDependencies, 'auth'>
  deliveryTrips?: Omit<DeliveryTripDependencies, 'auth'>
  courierAssignments?: Omit<CourierAssignmentDependencies, 'auth'>
  engagement?: Omit<EngagementDependencies, 'auth'>
  corsOrigins?: string[]
  logger?: boolean
  trustProxyHops?: number
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
    trustProxy:
      options.trustProxyHops && options.trustProxyHops > 0 ? options.trustProxyHops : false,
  })
  const readinessCheck = options.readinessCheck ?? (async () => true)

  // A forwarding header arriving while proxy trust is off is direct evidence the
  // API sits behind a proxy that was never declared. Every request then reports
  // the proxy's address, so rate limiting and OTP abuse control silently share
  // one bucket across all users. Warn once rather than per request.
  if (!options.trustProxyHops) {
    let warned = false
    app.addHook('onRequest', async (request) => {
      if (warned || !request.headers['x-forwarded-for']) return
      warned = true
      request.log.warn(
        'Received X-Forwarded-For while proxy trust is disabled: per-IP rate limiting and OTP abuse control are keying on the proxy address, not the client. Set API_TRUST_PROXY_HOPS to the number of trusted hops.',
      )
    })
  }

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    errorResponseBuilder: () =>
      errorEnvelope('RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down and retry.'),
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
  registerDiscoveryRoutes(app, {
    catalogRepository: options.catalogRepository ?? unavailableCatalogRepository,
    cityRepository: options.cityRepository ?? unavailableCityRepository,
    serviceabilityRepository:
      options.serviceabilityRepository ?? unavailableServiceabilityRepository,
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
    registerAddressRoutes(app, { repository: options.addressRepository, auth: options.auth })
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
  if (options.auth && options.adminAccess) {
    registerAdminAccessRoutes(app, { ...options.adminAccess, auth: options.auth })
  }
  if (options.auth && options.adminMessaging) {
    registerAdminMessagingRoutes(app, { ...options.adminMessaging, auth: options.auth })
  }
  if (options.auth && options.orderOperations) {
    registerOrderOperationsRoutes(app, { ...options.orderOperations, auth: options.auth })
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
  if (options.auth && options.wallet) {
    registerWalletRoutes(app, { ...options.wallet, auth: options.auth })
  }

  app.get('/health', async (): Promise<HealthResponse> => ({
    success: true,
    data: {
      status: 'healthy',
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? '0.0.1',
      checks: [{ name: 'process', status: 'pass' }],
    },
    meta: responseMeta(),
  }))

  app.get('/ready', async (_request, reply): Promise<ReadyResponse> => {
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
