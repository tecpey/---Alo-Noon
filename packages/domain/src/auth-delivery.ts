import { DomainError } from './errors'

export const AUTH_DELIVERY_ADAPTER_SPI_VERSION = 1 as const
export type AuthenticationDeliveryEnvironment = 'TEST' | 'PRODUCTION'
export type AuthenticationDeliveryOutcome =
  'DELIVERED' | 'REJECTED' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE' | 'UNKNOWN'

export type AuthenticationDeliveryAttemptState =
  'INITIALIZED' | 'DELIVERED' | 'REJECTED' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE' | 'UNKNOWN'

export interface AuthenticationDeliveryPolicy {
  readonly environment: AuthenticationDeliveryEnvironment
  readonly otpDigits: 6
  readonly otpTtlMs: number
  readonly resendCooldownMs: number
  readonly maxVerificationAttempts: number
  readonly maxPhoneSendsPerHour: number
  readonly maxIpSendsPerTenMinutes: number
  readonly maxTenantSendsPerHour: number
  /**
   * Hard ceiling on a tenant's daily SMS spend. The hourly limit alone bounds
   * bursts but not sustained cost: a tenant sustaining its hourly cap runs up
   * 24x that many paid messages a day. Sending is real money, so the day has
   * its own limit rather than being an unbounded multiple of the hour.
   */
  readonly maxTenantSendsPerDay: number
  readonly maxProviderSendsPerMinute: number
  readonly circuitFailureThreshold: number
  readonly circuitOpenMs: number
  readonly invocationTimeoutMs: number
  readonly maxPersistenceAttempts: number
}

export interface AuthenticationProviderConfigurationView {
  readonly id: string
  readonly tenantId: string
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: typeof AUTH_DELIVERY_ADAPTER_SPI_VERSION
  readonly environment: AuthenticationDeliveryEnvironment
  readonly credentialReference: string
  readonly senderReference: string
  readonly templateReference: string
}

export interface ResolvedAuthenticationCredential {
  readonly material: Uint8Array
  dispose(): void
}

export interface AuthenticationCredentialResolver {
  readonly testOnly?: boolean
  resolve(
    reference: string,
    tenantId: string,
    providerCode: string,
  ): Promise<ResolvedAuthenticationCredential>
}

export interface AuthenticationDeliveryRequest {
  readonly challengeId: string
  readonly deliveryAttemptId: string
  readonly mobileE164: string
  readonly otp: string
  readonly expiresAt: Date
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly timeoutMs: number
  readonly signal: AuthenticationAbortSignal
  readonly configuration: AuthenticationProviderConfigurationView
  /**
   * The tenant's sign-in message text, with `{code}` still in it.
   *
   * The wording belongs to the operator, so it comes from the message template
   * they edit rather than from the provider configuration — which is frozen at
   * creation and could not be corrected without provisioning a new gateway. The
   * code is left unsubstituted because a gateway with a real pattern API needs
   * to send the two separately; adapters without one render it themselves.
   */
  readonly messageBody: string
  readonly credential: ResolvedAuthenticationCredential
}

export interface AuthenticationAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

export interface AuthenticationDeliveryResult {
  readonly outcome: AuthenticationDeliveryOutcome
  readonly providerReference?: string
  readonly normalizedCode?: string
  readonly retryable?: boolean
}

export interface AuthenticationDeliveryProvider {
  readonly code: string
  readonly adapterVersion: string
  readonly spiVersion: typeof AUTH_DELIVERY_ADAPTER_SPI_VERSION
  readonly testOnly?: boolean
  deliverOtp(request: AuthenticationDeliveryRequest): Promise<AuthenticationDeliveryResult>
}

export interface AuthenticationDeliveryAdapterIdentity {
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: typeof AUTH_DELIVERY_ADAPTER_SPI_VERSION
  readonly testOnly: boolean
}

export interface AuthenticationDeliveryRegistry {
  resolve(input: {
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: number
    environment: AuthenticationDeliveryEnvironment
  }): AuthenticationDeliveryProvider
  identities(): readonly AuthenticationDeliveryAdapterIdentity[]
}

export interface AuthenticationProviderSelectionCandidate {
  readonly id: string
  readonly tenantId: string
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: number
  readonly environment: AuthenticationDeliveryEnvironment
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly priority: number
  readonly healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  readonly circuitOpenedUntil: Date | null
}

export interface SafeAuthenticationDeliveryResult {
  readonly outcome: AuthenticationDeliveryOutcome
  readonly providerReference: string | null
  readonly normalizedCode: string | null
  readonly retryable: boolean
}

const terminalAttemptStates = new Set<AuthenticationDeliveryAttemptState>([
  'DELIVERED',
  'REJECTED',
  'TRANSIENT_FAILURE',
  'PERMANENT_FAILURE',
  'UNKNOWN',
])

export function createAuthenticationDeliveryPolicy(
  input: Omit<AuthenticationDeliveryPolicy, 'otpDigits'>,
): AuthenticationDeliveryPolicy {
  const bounded = (value: number, minimum: number, maximum: number, label: string): number => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new DomainError(
        'AUTH_DELIVERY_POLICY_INVALID',
        `${label} must be an integer between ${minimum} and ${maximum}`,
      )
    }
    return value
  }

  // A daily ceiling below the hourly limit would make the hourly limit
  // unreachable and is always a misconfiguration, so it is rejected rather than
  // silently clamped.
  const boundedDailyCeiling = (value: number, hourly: number): number => {
    const daily = bounded(value, 10, 1_000_000, 'Tenant daily send limit')
    if (daily < hourly) {
      throw new DomainError(
        'AUTH_DELIVERY_POLICY_INVALID',
        'Tenant daily send limit must be at least the hourly send limit',
      )
    }
    return daily
  }

  return Object.freeze({
    ...input,
    otpDigits: 6,
    otpTtlMs: bounded(input.otpTtlMs, 2 * 60_000, 10 * 60_000, 'OTP TTL'),
    resendCooldownMs: bounded(input.resendCooldownMs, 30_000, 5 * 60_000, 'Resend cooldown'),
    maxVerificationAttempts: bounded(input.maxVerificationAttempts, 3, 8, 'Verification attempts'),
    maxPhoneSendsPerHour: bounded(input.maxPhoneSendsPerHour, 2, 10, 'Phone send limit'),
    maxIpSendsPerTenMinutes: bounded(input.maxIpSendsPerTenMinutes, 5, 100, 'IP send limit'),
    maxTenantSendsPerHour: bounded(input.maxTenantSendsPerHour, 10, 100_000, 'Tenant send limit'),
    maxTenantSendsPerDay: boundedDailyCeiling(
      input.maxTenantSendsPerDay,
      input.maxTenantSendsPerHour,
    ),
    maxProviderSendsPerMinute: bounded(
      input.maxProviderSendsPerMinute,
      1,
      10_000,
      'Provider send limit',
    ),
    circuitFailureThreshold: bounded(input.circuitFailureThreshold, 2, 20, 'Circuit threshold'),
    circuitOpenMs: bounded(input.circuitOpenMs, 60_000, 60 * 60_000, 'Circuit open duration'),
    invocationTimeoutMs: bounded(input.invocationTimeoutMs, 500, 30_000, 'Invocation timeout'),
    maxPersistenceAttempts: bounded(input.maxPersistenceAttempts, 1, 5, 'Persistence attempts'),
  })
}

export function normalizeIranianMobile(input: string): string {
  const normalized = input.trim()
  if (!/^\+989\d{9}$/.test(normalized)) {
    throw new DomainError(
      'INVALID_IRANIAN_MOBILE',
      'Iranian mobile number must use +989XXXXXXXXX format',
    )
  }
  return normalized
}

export function generateSecureOtp(random: (maximum: number) => number): string {
  const value = random(1_000_000)
  if (!Number.isInteger(value) || value < 0 || value >= 1_000_000) {
    throw new DomainError(
      'AUTH_DELIVERY_POLICY_INVALID',
      'OTP entropy source returned invalid data',
    )
  }
  return value.toString().padStart(6, '0')
}

export function createAuthenticationDeliveryRegistry(
  adapters: readonly AuthenticationDeliveryProvider[],
): AuthenticationDeliveryRegistry {
  const registered = new Map<string, AuthenticationDeliveryProvider>()
  const identities: AuthenticationDeliveryAdapterIdentity[] = []
  for (const adapter of adapters) {
    if (
      !/^[A-Z][A-Z0-9_]{1,31}$/.test(adapter.code) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adapter.adapterVersion) ||
      adapter.spiVersion !== AUTH_DELIVERY_ADAPTER_SPI_VERSION
    ) {
      throw new DomainError(
        'AUTH_DELIVERY_REGISTRY_INVALID',
        'Authentication delivery adapter identity is invalid',
      )
    }
    const key = registryKey(adapter.code, adapter.adapterVersion, adapter.spiVersion)
    if (registered.has(key)) {
      throw new DomainError(
        'AUTH_DELIVERY_REGISTRY_INVALID',
        'Authentication delivery adapter identity is duplicated',
      )
    }
    registered.set(key, adapter)
    identities.push(
      Object.freeze({
        providerCode: adapter.code,
        adapterVersion: adapter.adapterVersion,
        adapterSpiVersion: adapter.spiVersion,
        testOnly: adapter.testOnly === true,
      }),
    )
  }
  const snapshot = Object.freeze(identities)
  const registry: AuthenticationDeliveryRegistry = {
    resolve(input: {
      providerCode: string
      adapterVersion: string
      adapterSpiVersion: number
      environment: AuthenticationDeliveryEnvironment
    }) {
      const adapter = registered.get(
        registryKey(input.providerCode, input.adapterVersion, input.adapterSpiVersion),
      )
      if (!adapter || (input.environment === 'PRODUCTION' && adapter.testOnly === true)) {
        throw new DomainError(
          'AUTH_DELIVERY_ADAPTER_UNAVAILABLE',
          'Authentication delivery provider is unavailable',
        )
      }
      return adapter
    },
    identities: () => snapshot,
  }
  return Object.freeze(registry)
}

export function selectAuthenticationProvider(
  candidates: readonly AuthenticationProviderSelectionCandidate[],
  tenantId: string,
  environment: AuthenticationDeliveryEnvironment,
  now: Date,
): AuthenticationProviderSelectionCandidate {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.environment === environment &&
        candidate.enabled &&
        candidate.isDefault &&
        candidate.healthStatus !== 'UNHEALTHY' &&
        (!candidate.circuitOpenedUntil || candidate.circuitOpenedUntil <= now),
    )
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  if (eligible.length === 0) {
    throw new DomainError(
      'AUTH_DELIVERY_PROVIDER_MISSING',
      'No eligible authentication delivery provider exists',
    )
  }
  if (eligible.length !== 1) {
    throw new DomainError(
      'AUTH_DELIVERY_PROVIDER_AMBIGUOUS',
      'Authentication delivery provider selection is ambiguous',
    )
  }
  return eligible[0]!
}

export function normalizeAuthenticationDeliveryResult(
  result: AuthenticationDeliveryResult,
): SafeAuthenticationDeliveryResult {
  const providerReference = boundedOptional(result.providerReference, 200)
  const normalizedCode = result.normalizedCode?.trim() ?? null
  if (normalizedCode && !/^[A-Z][A-Z0-9_]{1,63}$/.test(normalizedCode)) {
    throw invalidResponse()
  }
  if (result.outcome === 'DELIVERED' && !providerReference) throw invalidResponse()
  if (result.outcome !== 'DELIVERED' && providerReference) throw invalidResponse()
  const retryable = result.outcome === 'TRANSIENT_FAILURE'
  if (result.retryable !== undefined && result.retryable !== retryable) throw invalidResponse()
  return Object.freeze({ outcome: result.outcome, providerReference, normalizedCode, retryable })
}

export function assertAuthenticationDeliveryTransition(
  from: AuthenticationDeliveryAttemptState,
  to: AuthenticationDeliveryAttemptState,
): void {
  if (from !== 'INITIALIZED' || !terminalAttemptStates.has(to)) {
    throw new DomainError(
      'INVALID_AUTH_DELIVERY_TRANSITION',
      `Authentication delivery transition ${from} -> ${to} is not allowed`,
    )
  }
}

export function redactAuthenticationData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuthenticationData)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /otp|mobile|phone|authorization|credential|secret|signature|api[-_]?key|token/i.test(key)
        ? '[REDACTED]'
        : redactAuthenticationData(nested),
    ]),
  )
}

function registryKey(providerCode: string, adapterVersion: string, spiVersion: number): string {
  return `${providerCode}@${adapterVersion}#${spiVersion}`
}

function boundedOptional(value: string | undefined, max: number): string | null {
  if (value === undefined) return null
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw invalidResponse()
  return normalized
}

function invalidResponse(): DomainError {
  return new DomainError(
    'AUTH_DELIVERY_RESPONSE_INVALID',
    'Authentication delivery provider response is invalid',
  )
}
