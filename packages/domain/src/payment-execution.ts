import { DomainError } from './errors'
import type {
  PaymentProviderAdapter,
  ProviderInitializationOutcome,
  ProviderInitializationResult,
} from './payment-provider'

export interface ProviderExecutionPolicy {
  readonly capability: 'PAYMENT_INITIALIZATION'
  readonly environment: 'TEST' | 'PRODUCTION'
  readonly paymentContext: 'CHECKOUT'
  readonly currency: 'IRR'
  readonly requireHealthyProvider: true
  readonly maxPersistenceAttempts: number
  readonly invocationTimeoutMs: number
}

export interface SafeInitializationResult {
  readonly outcome: ProviderInitializationOutcome
  readonly providerReference: string | null
  readonly customerActionUrl: string | null
  readonly actionExpiresAt: Date | null
  readonly failureCode: string | null
  readonly retryable: boolean
  readonly customerMessageKey: string | null
}

const failureOutcomes = new Set<ProviderInitializationOutcome>([
  'REJECTED',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'UNKNOWN',
])

export function createProviderExecutionPolicy(
  input: Omit<
    ProviderExecutionPolicy,
    'capability' | 'paymentContext' | 'currency' | 'requireHealthyProvider'
  >,
): ProviderExecutionPolicy {
  if (!Number.isInteger(input.maxPersistenceAttempts) || input.maxPersistenceAttempts < 1) {
    throw new DomainError(
      'PAYMENT_EXECUTION_POLICY_INVALID',
      'Persistence attempts must be a positive integer',
    )
  }
  if (!Number.isInteger(input.invocationTimeoutMs) || input.invocationTimeoutMs < 100) {
    throw new DomainError(
      'PAYMENT_EXECUTION_POLICY_INVALID',
      'Invocation timeout metadata must be at least 100 milliseconds',
    )
  }
  return Object.freeze({
    capability: 'PAYMENT_INITIALIZATION',
    environment: input.environment,
    paymentContext: 'CHECKOUT',
    currency: 'IRR',
    requireHealthyProvider: true,
    maxPersistenceAttempts: input.maxPersistenceAttempts,
    invocationTimeoutMs: input.invocationTimeoutMs,
  })
}

export function validateInitializationAdapter(
  adapter: PaymentProviderAdapter,
  environment: ProviderExecutionPolicy['environment'],
): void {
  if (environment === 'PRODUCTION' && adapter.testOnly === true) {
    throw new DomainError(
      'PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE',
      'Test-only payment adapters cannot execute in production',
    )
  }
  if (!adapter.capabilities.has('PAYMENT_INITIALIZATION') || !adapter.initializePayment) {
    throw new DomainError(
      'PAYMENT_PROVIDER_CAPABILITY_UNSUPPORTED',
      'Payment initialization capability is unavailable',
    )
  }
}

export function normalizeInitializationResult(
  result: ProviderInitializationResult,
  now: Date,
): SafeInitializationResult {
  const providerReference = optionalBounded(result.providerReference, 200, 'provider reference')
  const failureCode = optionalCode(result.normalizedCode)
  const customerMessageKey = optionalMessageKey(result.customerMessageKey)
  const customerActionUrl = optionalActionUrl(result.customerActionUrl)
  const actionExpiresAt = result.actionExpiresAt ? new Date(result.actionExpiresAt) : null

  if (actionExpiresAt && (!Number.isFinite(actionExpiresAt.getTime()) || actionExpiresAt <= now)) {
    throw invalidResult('Action expiry must be a valid future timestamp')
  }

  if (result.outcome === 'ACCEPTED') {
    if (!providerReference || customerActionUrl || actionExpiresAt || failureCode) {
      throw invalidResult('Accepted initialization result is inconsistent')
    }
  } else if (result.outcome === 'CUSTOMER_ACTION_REQUIRED') {
    if (!providerReference || !customerActionUrl || failureCode) {
      throw invalidResult('Customer-action initialization result is incomplete')
    }
  } else if (failureOutcomes.has(result.outcome)) {
    if (!failureCode || providerReference || customerActionUrl || actionExpiresAt) {
      throw invalidResult('Failed initialization result is inconsistent')
    }
  } else {
    throw invalidResult('Initialization outcome is unsupported')
  }

  const retryable =
    result.outcome === 'RETRYABLE_FAILURE'
      ? true
      : result.outcome === 'ACCEPTED' || result.outcome === 'CUSTOMER_ACTION_REQUIRED'
        ? false
        : (result.retryable ?? false)
  if (result.outcome !== 'RETRYABLE_FAILURE' && result.retryable === true) {
    throw invalidResult('Only retryable failures may be marked retryable')
  }

  return Object.freeze({
    outcome: result.outcome,
    providerReference,
    customerActionUrl,
    actionExpiresAt,
    failureCode,
    retryable,
    customerMessageKey,
  })
}

export function initializationAttemptStates(
  outcome: ProviderInitializationOutcome,
): readonly ('INITIALIZED' | 'CUSTOMER_ACTION_REQUIRED' | 'FAILED')[] {
  if (outcome === 'ACCEPTED') return ['INITIALIZED']
  if (outcome === 'CUSTOMER_ACTION_REQUIRED') {
    return ['INITIALIZED', 'CUSTOMER_ACTION_REQUIRED']
  }
  return ['FAILED']
}

function optionalBounded(value: string | undefined, max: number, label: string): string | null {
  if (value === undefined) return null
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > max) {
    throw invalidResult(`${label} is invalid`)
  }
  return normalized
}

function optionalCode(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
    throw invalidResult('Normalized failure code is invalid')
  }
  return value
}

function optionalMessageKey(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!/^[a-z][a-z0-9_.-]{1,99}$/.test(value)) {
    throw invalidResult('Customer message key is invalid')
  }
  return value
}

function optionalActionUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  if (
    value.length > 2048 ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^#\s]*)?$/.test(value)
  ) {
    throw invalidResult('Customer action URL must be an opaque HTTPS URL')
  }
  return value
}

function invalidResult(message: string): DomainError {
  return new DomainError('PAYMENT_PROVIDER_RESPONSE_INVALID', message)
}
