import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  adminAuthDeliveryConfigurationCreateSchema,
  adminAuthDeliveryHealthSchema,
  adminPaymentProviderConfigurationCreateSchema,
  adminPaymentProviderGovernanceSchema,
  adminPaymentProviderHealthSchema,
  adminProviderCredentialCreateSchema,
  type ErrorEnvelope,
  type ResponseMeta,
} from '@alo-noon/contracts'

import {
  AuthDeliveryProviderError,
  type AuthDeliveryProviderService,
} from './auth-delivery-provider.js'
import { authenticateRequest, authorizeGrants, type AuthDependencies } from './auth.js'
import { PaymentProviderError, type PaymentProviderService } from './payment-provider.js'

/**
 * Staff-facing provider governance.
 *
 * Before this existed, configuring a payment gateway or the OTP SMS provider was
 * only possible by running the provisioning CLI with database credentials in
 * hand. These routes make it an audited, permissioned operation instead.
 *
 * Two properties hold across every route here:
 *
 * - No secret ever crosses this boundary. Commands name a credential by opaque
 *   reference; the value lives in the deployment's secret store and is resolved
 *   only inside the payment execution path. Nothing here can read one back.
 * - Authorization is enforced twice: cheaply here, from the session's grants, so
 *   an unprivileged caller gets a 403 without touching provider state; and again
 *   inside the service's write transaction, against live grant rows, which is
 *   the authoritative check. The session copy of a grant can be stale; the
 *   in-transaction one cannot.
 */
const PAYMENT_GOVERN_PERMISSION = 'payment-provider.configuration.govern'
const DELIVERY_GOVERN_PERMISSION = 'auth-delivery-provider.configuration.govern'

// Governance is low-volume and high-consequence. A tighter budget than the
// global one limits how fast a stolen staff session can churn configuration.
const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export interface AdminProviderDependencies {
  auth: AuthDependencies
  paymentProviderService: PaymentProviderService
  authDeliveryProviderService: AuthDeliveryProviderService
  now?: () => Date
}

export interface AdminActor {
  tenantId: string
  accountId: string
}

/**
 * Resolves the acting staff account, or answers the request and returns null.
 * Callers must stop as soon as this returns null: the reply is already sent.
 *
 * Deliberately shaped like `authenticatedCustomer`, and allow-listed by the same
 * lint rule, so every admin handler still derives tenant identity from the
 * session rather than from anything the client sent.
 */
export async function authenticatedStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminProviderDependencies,
  permission: string,
): Promise<AdminActor | null> {
  reply.header('Cache-Control', 'no-store')
  const session = await authenticateRequest(request, dependencies.auth)
  if (!session) {
    await reply
      .code(401)
      .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid staff session is required.'))
    return null
  }
  // Provider governance is tenant-wide, so only a GLOBAL grant qualifies; a
  // city- or branch-scoped operator cannot reach it.
  if (!authorizeGrants(session.grants, permission, {}, dependencies.now?.() ?? new Date())) {
    await reply
      .code(403)
      .send(
        errorEnvelope(
          'PROVIDER_GOVERNANCE_FORBIDDEN',
          'This account may not govern provider configuration.',
        ),
      )
    return null
  }
  return { tenantId: session.tenantId, accountId: session.accountId }
}

export function registerAdminProviderRoutes(
  app: FastifyInstance,
  dependencies: AdminProviderDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()
  app.post(
    '/api/v1/admin/payment-providers/credentials',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        PAYMENT_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminProviderCredentialCreateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PROVIDER_CREDENTIAL_COMMAND', 'The command is invalid.'))
      }

      try {
        const credential = await dependencies.paymentProviderService.createCredentialReference(
          actor.tenantId,
          {
            actor: 'STAFF',
            actorId: actor.accountId,
            providerCode: parsed.data.providerCode,
            reference: parsed.data.reference,
            keyVersion: parsed.data.keyVersion,
            metadata: parsed.data.metadata,
            idempotencyKey: parsed.data.idempotencyKey,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: credential, meta: responseMeta() })
      } catch (error) {
        return paymentGovernanceFailure(request, reply, error)
      }
    },
  )

  app.get(
    '/api/v1/admin/payment-providers/configurations',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        PAYMENT_GOVERN_PERMISSION,
      )
      if (!actor) return reply

      try {
        const configurations = await dependencies.paymentProviderService.listConfigurations(
          actor.tenantId,
          { actor: 'STAFF', actorId: actor.accountId },
          currentTime(),
        )
        return reply.send({ success: true, data: configurations, meta: responseMeta() })
      } catch (error) {
        return paymentGovernanceFailure(request, reply, error)
      }
    },
  )

  app.post(
    '/api/v1/admin/payment-providers/configurations',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        PAYMENT_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminPaymentProviderConfigurationCreateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PROVIDER_CONFIGURATION_COMMAND', 'The command is invalid.'))
      }

      try {
        const configuration = await dependencies.paymentProviderService.createConfiguration(
          actor.tenantId,
          { actor: 'STAFF', actorId: actor.accountId, ...parsed.data },
          currentTime(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: configuration, meta: responseMeta() })
      } catch (error) {
        return paymentGovernanceFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { configurationId: string } }>(
    '/api/v1/admin/payment-providers/configurations/:configurationId/governance',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        PAYMENT_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminPaymentProviderGovernanceSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PROVIDER_GOVERNANCE_COMMAND', 'The command is invalid.'))
      }

      try {
        const configuration = await dependencies.paymentProviderService.governConfiguration(
          actor.tenantId,
          {
            actor: 'STAFF',
            actorId: actor.accountId,
            providerConfigurationId: request.params.configurationId,
            ...parsed.data,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: configuration, meta: responseMeta() })
      } catch (error) {
        return paymentGovernanceFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { configurationId: string } }>(
    '/api/v1/admin/payment-providers/configurations/:configurationId/health',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        PAYMENT_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminPaymentProviderHealthSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PROVIDER_HEALTH_COMMAND', 'The command is invalid.'))
      }

      try {
        const configuration = await dependencies.paymentProviderService.setConfigurationHealth(
          actor.tenantId,
          {
            actor: 'STAFF',
            actorId: actor.accountId,
            providerConfigurationId: request.params.configurationId,
            ...parsed.data,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: configuration, meta: responseMeta() })
      } catch (error) {
        return paymentGovernanceFailure(request, reply, error)
      }
    },
  )

  app.get(
    '/api/v1/admin/sms-providers/configurations',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        DELIVERY_GOVERN_PERMISSION,
      )
      if (!actor) return reply

      try {
        const configurations = await dependencies.authDeliveryProviderService.listConfigurations(
          actor.tenantId,
          { actor: 'STAFF', actorId: actor.accountId },
          currentTime(),
        )
        return reply.send({ success: true, data: configurations, meta: responseMeta() })
      } catch (error) {
        return deliveryGovernanceFailure(request, reply, error)
      }
    },
  )

  app.post(
    '/api/v1/admin/sms-providers/configurations',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        DELIVERY_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminAuthDeliveryConfigurationCreateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_SMS_PROVIDER_COMMAND', 'The command is invalid.'))
      }

      const { priority, ...command } = parsed.data
      try {
        const configuration = await dependencies.authDeliveryProviderService.createConfiguration(
          actor.tenantId,
          {
            actor: 'STAFF',
            actorId: actor.accountId,
            ...command,
            ...(priority !== undefined && { priority }),
          },
          currentTime(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: configuration, meta: responseMeta() })
      } catch (error) {
        return deliveryGovernanceFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { configurationId: string } }>(
    '/api/v1/admin/sms-providers/configurations/:configurationId/health',
    ADMIN_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        DELIVERY_GOVERN_PERMISSION,
      )
      if (!actor) return reply
      const parsed = adminAuthDeliveryHealthSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_SMS_PROVIDER_HEALTH_COMMAND', 'The command is invalid.'))
      }

      try {
        const configuration = await dependencies.authDeliveryProviderService.setConfigurationHealth(
          actor.tenantId,
          {
            actor: 'STAFF',
            actorId: actor.accountId,
            configurationId: request.params.configurationId,
            ...parsed.data,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: configuration, meta: responseMeta() })
      } catch (error) {
        return deliveryGovernanceFailure(request, reply, error)
      }
    },
  )
}

/**
 * The service's own authorization check is authoritative, so a FORBIDDEN from it
 * becomes a 403 even though the session's grants said otherwise — that gap is
 * exactly a grant revoked between login and this request.
 */
const PAYMENT_GOVERNANCE_STATUS: Readonly<Record<string, 400 | 403 | 404 | 409 | 422>> = {
  PAYMENT_PROVIDER_OPERATION_FORBIDDEN: 403,
  PROVIDER_CONFIGURATION_NOT_FOUND: 404,
  PROVIDER_CREDENTIAL_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  PROVIDER_DEFAULT_CONFLICT: 409,
  PROVIDER_CONFIGURATION_STATE_UNCHANGED: 409,
  PAYMENT_PROVIDER_CONCURRENCY_CONFLICT: 409,
  INVALID_PROVIDER_CREDENTIAL_REFERENCE: 400,
  PROVIDER_REASON_REQUIRED: 400,
  PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE: 422,
}

const DELIVERY_GOVERNANCE_STATUS: Readonly<Record<string, 400 | 403 | 404 | 409>> = {
  AUTH_DELIVERY_PROVIDER_OPERATION_FORBIDDEN: 403,
  AUTH_DELIVERY_CONFIGURATION_NOT_FOUND: 404,
  AUTH_DELIVERY_CONFIGURATION_CONFLICT: 409,
  AUTH_DELIVERY_DEFAULT_ALREADY_EXISTS: 409,
  AUTH_DELIVERY_PROVIDER_CONCURRENCY_CONFLICT: 409,
  AUTH_DELIVERY_PROVIDER_CODE_INVALID: 400,
  AUTH_DELIVERY_ADAPTER_VERSION_INVALID: 400,
  AUTH_DELIVERY_CREDENTIAL_REFERENCE_INVALID: 400,
  AUTH_DELIVERY_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE: 400,
  AUTH_DELIVERY_REFERENCE_METADATA_INVALID: 400,
  AUTH_DELIVERY_PRIORITY_OUT_OF_RANGE: 400,
  AUTH_DELIVERY_DEFAULT_MUST_BE_ENABLED: 400,
  AUTH_DELIVERY_REASON_REQUIRED: 400,
}

function paymentGovernanceFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): unknown {
  if (error instanceof PaymentProviderError) {
    const status = PAYMENT_GOVERNANCE_STATUS[error.code]
    // The code is a stable, non-secret identifier; the operator needs it to act.
    if (status) return reply.code(status).send(errorEnvelope(error.code, governanceMessage(status)))
  }
  request.log.error({ err: error }, 'Payment provider governance failed')
  return reply
    .code(503)
    .send(
      errorEnvelope(
        'PROVIDER_GOVERNANCE_UNAVAILABLE',
        'Provider governance is temporarily unavailable.',
      ),
    )
}

function deliveryGovernanceFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): unknown {
  if (error instanceof AuthDeliveryProviderError) {
    const status = DELIVERY_GOVERNANCE_STATUS[error.code]
    if (status) return reply.code(status).send(errorEnvelope(error.code, governanceMessage(status)))
  }
  request.log.error({ err: error }, 'Authentication delivery provider governance failed')
  return reply
    .code(503)
    .send(
      errorEnvelope(
        'PROVIDER_GOVERNANCE_UNAVAILABLE',
        'Provider governance is temporarily unavailable.',
      ),
    )
}

function governanceMessage(status: number): string {
  switch (status) {
    case 403:
      return 'This account may not govern provider configuration.'
    case 404:
      return 'No such provider configuration for this tenant.'
    case 409:
      return 'The configuration conflicts with what is already recorded.'
    case 422:
      return 'No adapter serves the requested provider configuration.'
    default:
      return 'The command is invalid.'
  }
}

function responseMeta(): ResponseMeta {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
