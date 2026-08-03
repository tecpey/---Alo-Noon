import { DomainError } from './errors'

export const PAYMENT_PROVIDER_CAPABILITIES = [
  'PAYMENT_INITIALIZATION',
  'CALLBACK_VERIFICATION',
  'PAYMENT_INQUIRY',
  'CANCELLATION',
  'REFUND',
] as const
export type PaymentProviderCapability = (typeof PAYMENT_PROVIDER_CAPABILITIES)[number]

export const PAYMENT_ATTEMPT_STATES = [
  'CREATED',
  'INITIALIZATION_PENDING',
  'INITIALIZED',
  'CUSTOMER_ACTION_REQUIRED',
  'CALLBACK_RECEIVED',
  'VERIFICATION_PENDING',
  'VERIFIED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
] as const
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number]

export type ProviderNormalizedOutcome =
  'PENDING' | 'CUSTOMER_ACTION_REQUIRED' | 'VERIFIED' | 'REJECTED' | 'FAILED'

export interface ProviderSelectionCandidate {
  id: string
  tenantId: string
  environment: 'TEST' | 'PRODUCTION'
  paymentContext: 'CHECKOUT'
  currency: 'IRR'
  capabilities: readonly PaymentProviderCapability[]
  isActive: boolean
  isDefault: boolean
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
}

export interface ProviderSelectionRequest {
  tenantId: string
  environment: ProviderSelectionCandidate['environment']
  paymentContext: ProviderSelectionCandidate['paymentContext']
  currency: 'IRR'
  capability: PaymentProviderCapability
}

export interface ProviderConfigurationView {
  id: string
  tenantId: string
  providerCode: string
  environment: 'TEST' | 'PRODUCTION'
  merchantReference: string
  callbackPolicy: 'SIGNED_ONLY'
  capabilities: readonly PaymentProviderCapability[]
  credentialReference: string
}

export interface ResolvedProviderCredential {
  readonly material: Uint8Array
  dispose(): void
}

export interface ProviderSecretResolver {
  resolve(
    reference: string,
    tenantId: string,
    providerCode: string,
  ): Promise<ResolvedProviderCredential>
}

export interface ProviderVerificationInput {
  canonicalBody: Uint8Array
  approvedHeaders: Readonly<Record<string, string>>
  receivedAt: Date
  configuration: ProviderConfigurationView
  credential: ResolvedProviderCredential
}

export interface ProviderVerificationResult {
  verified: boolean
  externalEventId?: string
  providerReference?: string
  normalizedOutcome: ProviderNormalizedOutcome
  reasonCode?: string
}

export interface ProviderPaymentRequest {
  paymentAttemptId: string
  amount: bigint
  currency: 'IRR'
  idempotencyKey: string
  configuration: ProviderConfigurationView
  credential: ResolvedProviderCredential
}

export interface ProviderOperationResult {
  providerReference?: string
  normalizedOutcome: ProviderNormalizedOutcome
  customerActionUrl?: string
  reasonCode?: string
}

export interface PaymentProviderAdapter {
  readonly code: string
  readonly capabilities: ReadonlySet<PaymentProviderCapability>
  readonly testOnly?: boolean
  mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome
  initializePayment?(request: ProviderPaymentRequest): Promise<ProviderOperationResult>
  inquirePayment?(request: ProviderPaymentRequest): Promise<ProviderOperationResult>
  cancelPayment?(request: ProviderPaymentRequest): Promise<ProviderOperationResult>
  refundPayment?(request: ProviderPaymentRequest): Promise<ProviderOperationResult>
  verifyCallback?(input: ProviderVerificationInput): Promise<ProviderVerificationResult>
}

const attemptTransitions: Readonly<Record<PaymentAttemptState, readonly PaymentAttemptState[]>> = {
  CREATED: ['INITIALIZATION_PENDING', 'FAILED', 'EXPIRED'],
  INITIALIZATION_PENDING: ['INITIALIZED', 'FAILED', 'EXPIRED'],
  INITIALIZED: [
    'CUSTOMER_ACTION_REQUIRED',
    'CALLBACK_RECEIVED',
    'VERIFICATION_PENDING',
    'FAILED',
    'EXPIRED',
  ],
  CUSTOMER_ACTION_REQUIRED: ['CALLBACK_RECEIVED', 'FAILED', 'EXPIRED'],
  CALLBACK_RECEIVED: ['VERIFICATION_PENDING', 'REJECTED'],
  VERIFICATION_PENDING: ['VERIFIED', 'REJECTED', 'FAILED'],
  VERIFIED: [],
  REJECTED: [],
  FAILED: [],
  EXPIRED: [],
}

export function transitionPaymentAttempt(from: PaymentAttemptState, to: PaymentAttemptState): void {
  if (!attemptTransitions[from].includes(to)) {
    throw new DomainError(
      'INVALID_PAYMENT_ATTEMPT_TRANSITION',
      `Payment attempt transition ${from} -> ${to} is not allowed`,
    )
  }
}

export function selectPaymentProvider(
  candidates: readonly ProviderSelectionCandidate[],
  request: ProviderSelectionRequest,
): ProviderSelectionCandidate {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.tenantId === request.tenantId &&
      candidate.environment === request.environment &&
      candidate.paymentContext === request.paymentContext &&
      candidate.currency === request.currency &&
      candidate.isActive &&
      candidate.isDefault &&
      candidate.healthStatus === 'HEALTHY' &&
      candidate.capabilities.includes(request.capability),
  )
  if (eligible.length === 0) {
    throw new DomainError('PAYMENT_PROVIDER_MISSING', 'No eligible default payment provider exists')
  }
  if (eligible.length !== 1) {
    throw new DomainError('PAYMENT_PROVIDER_AMBIGUOUS', 'Payment provider selection is ambiguous')
  }
  return eligible[0]!
}

export function requireProviderCapability(
  adapter: PaymentProviderAdapter,
  capability: PaymentProviderCapability,
): void {
  if (!adapter.capabilities.has(capability)) {
    throw new DomainError(
      'PAYMENT_PROVIDER_CAPABILITY_UNSUPPORTED',
      `Provider capability ${capability} is unsupported`,
    )
  }
  const implemented =
    capability === 'PAYMENT_INITIALIZATION'
      ? adapter.initializePayment
      : capability === 'CALLBACK_VERIFICATION'
        ? adapter.verifyCallback
        : capability === 'PAYMENT_INQUIRY'
          ? adapter.inquirePayment
          : capability === 'CANCELLATION'
            ? adapter.cancelPayment
            : adapter.refundPayment
  if (!implemented) {
    throw new DomainError(
      'PAYMENT_PROVIDER_CAPABILITY_UNSUPPORTED',
      `Provider capability ${capability} is not implemented`,
    )
  }
}

export function validateProviderCapabilities(
  capabilities: readonly PaymentProviderCapability[],
): void {
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    throw new DomainError(
      'INVALID_PAYMENT_PROVIDER_CAPABILITIES',
      'Payment provider capabilities must be non-empty and unique',
    )
  }
}

export function resolveProductionProviderAdapter(
  adapters: ReadonlyMap<string, PaymentProviderAdapter>,
  providerCode: string,
  environment: 'TEST' | 'PRODUCTION',
): PaymentProviderAdapter {
  const adapter = adapters.get(providerCode)
  if (!adapter || (environment === 'PRODUCTION' && adapter.testOnly === true)) {
    throw new DomainError('PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 'Payment provider is unavailable')
  }
  return adapter
}

export function canonicalProviderRequest(value: unknown): string {
  return stableSerialize(value)
}

export function redactProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactProviderSecrets(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /authorization|credential|secret|signature|token|api[-_]?key/i.test(key)
        ? '[REDACTED]'
        : redactProviderSecrets(nested),
    ]),
  )
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DomainError('INVALID_PROVIDER_REQUEST', 'Provider request must be finite')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(value.toString())}}`
  if (typeof value !== 'object') {
    throw new DomainError('INVALID_PROVIDER_REQUEST', 'Provider request is not canonicalizable')
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`)
    .join(',')}}`
}
