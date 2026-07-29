import {
  activeCitiesEnvelopeSchema,
  catalogPageSchema,
  errorEnvelopeSchema,
  otpRequestEnvelopeSchema,
  serviceabilityEnvelopeSchema,
  sessionEnvelopeSchema,
  type ActiveCitySummary,
  type OtpRequestAccepted,
  type ProductSummary,
  type ServiceabilityResponse,
  type SessionContext,
} from '@alo-noon/contracts'

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export type CustomerFetch = (input: string, init?: RequestInit) => Promise<Response>

export class CustomerApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code)
  }
}

export interface CustomerApiClient {
  getSession(): Promise<SessionContext | null>
  requestOtp(mobileE164: string): Promise<OtpRequestAccepted>
  verifyOtp(challengeId: string, code: string): Promise<SessionContext>
  logout(): Promise<void>
  listActiveCities(): Promise<ActiveCitySummary[]>
  checkServiceability(input: {
    cityId: string
    latitude: number
    longitude: number
  }): Promise<ServiceabilityResponse>
  listCatalog(input: { cityId: string; operationalZoneId: string }): Promise<ProductSummary[]>
}

export function createCustomerApiClient(
  baseUrl: string,
  fetchImplementation: CustomerFetch = fetch,
): CustomerApiClient {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  const request = async <T>(
    path: string,
    schema: RuntimeSchema<{ data: T }>,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) throw await apiError(response)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new CustomerApiError('INVALID_API_RESPONSE', response.status)
    return parsed.data.data
  }

  return {
    async getSession() {
      try {
        return await request('/api/v1/auth/session', sessionEnvelopeSchema)
      } catch (error) {
        if (error instanceof CustomerApiError && error.status === 401) return null
        throw error
      }
    },
    requestOtp: async (mobileE164) =>
      request('/api/v1/auth/otp/request', otpRequestEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ mobileE164 }),
      }),
    verifyOtp: async (challengeId, code) =>
      request('/api/v1/auth/otp/verify', sessionEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ challengeId, code }),
      }),
    async logout() {
      const response = await fetchImplementation(`${normalizedBaseUrl}/api/v1/auth/session`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok && response.status !== 204) throw await apiError(response)
    },
    listActiveCities: async () => {
      const envelope = await request('/api/v1/serviceability/cities', activeCitiesEnvelopeSchema)
      return envelope
    },
    checkServiceability: async (input) =>
      request('/api/v1/serviceability/check', serviceabilityEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listCatalog: async ({ cityId, operationalZoneId }) => {
      const query = new URLSearchParams({
        cityId,
        operationalZoneId,
        page: '1',
        pageSize: '50',
      })
      return request(`/api/v1/catalog/products?${query.toString()}`, catalogPageSchema)
    },
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must use HTTP or HTTPS')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must not include a path')
  }
  return url.origin
}

async function apiError(response: Response): Promise<CustomerApiError> {
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined

  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    if (parsed.success) {
      return new CustomerApiError(
        parsed.data.error.code,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      )
    }
  } catch {
    // Fall through to the bounded transport error below.
  }

  return new CustomerApiError(
    response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_FAILED',
    response.status,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  )
}
