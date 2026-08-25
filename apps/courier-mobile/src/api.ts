import {
  deliveryTaskEnvelopeSchema,
  deliveryTaskListEnvelopeSchema,
  errorEnvelopeSchema,
  otpRequestEnvelopeSchema,
  sessionEnvelopeSchema,
  type DeliveryTaskView,
  type OtpRequestAccepted,
  type SessionContext,
} from '@alo-noon/contracts'

/**
 * The courier app's view of the API.
 *
 * A courier signs in with the same one-time code as a customer — there is one
 * identity system and no second login to keep in step. What makes the session a
 * courier's is a record on the roster carrying their number, which the API
 * checks; an account without one gets `NOT_A_COURIER` rather than an empty list,
 * so somebody handed the wrong app finds out immediately instead of concluding
 * there is no work.
 *
 * Every response is parsed before it is trusted. A courier acting on a half-
 * understood payload would be a courier told an order is theirs when it is not.
 */
interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export type CourierFetch = (input: string, init?: RequestInit) => Promise<Response>

export class CourierApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code)
    this.name = 'CourierApiError'
  }
}

/** The four things a courier can say about an order they are holding. */
export type CourierReport = 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED'

export interface CourierApiClient {
  getSession(): Promise<SessionContext | null>
  requestOtp(mobileE164: string, idempotencyKey: string): Promise<OtpRequestAccepted>
  verifyOtp(challengeId: string, code: string): Promise<SessionContext>
  logout(): Promise<void>
  /** Everything offered to or held by this courier, oldest first. */
  listDeliveries(): Promise<DeliveryTaskView[]>
  /** Answers an offer. Declining returns the order to the dispatcher's queue. */
  respond(taskId: string, accept: boolean): Promise<DeliveryTaskView>
  /**
   * Reports what happened. `reasonCode` is required for FAILED and refused by
   * the API without it — a failed delivery with no reason leaves a dispatcher
   * nothing to decide with.
   */
  report(taskId: string, to: CourierReport, reasonCode?: string): Promise<DeliveryTaskView>
}

export function createCourierApiClient(
  baseUrl: string,
  fetchImplementation: CourierFetch = fetch,
): CourierApiClient {
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
    if (!parsed.success) throw new CourierApiError('INVALID_API_RESPONSE', response.status)
    return parsed.data.data
  }

  return {
    async getSession() {
      try {
        return await request('/api/v1/auth/session', sessionEnvelopeSchema)
      } catch (error) {
        if (error instanceof CourierApiError && error.status === 401) return null
        throw error
      }
    },
    requestOtp: async (mobileE164, idempotencyKey) =>
      request('/api/v1/auth/otp/request', otpRequestEnvelopeSchema, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
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
    listDeliveries: async () =>
      request('/api/v1/courier/deliveries', deliveryTaskListEnvelopeSchema),
    respond: async (taskId, accept) =>
      request(
        `/api/v1/courier/deliveries/${encodeURIComponent(taskId)}/respond`,
        deliveryTaskEnvelopeSchema,
        { method: 'POST', body: JSON.stringify({ accept }) },
      ),
    report: async (taskId, to, reasonCode) =>
      request(
        `/api/v1/courier/deliveries/${encodeURIComponent(taskId)}/report`,
        deliveryTaskEnvelopeSchema,
        {
          method: 'POST',
          body: JSON.stringify({ to, ...(reasonCode ? { reasonCode } : {}) }),
        },
      ),
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

async function apiError(response: Response): Promise<CourierApiError> {
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined

  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    if (parsed.success) {
      return new CourierApiError(
        parsed.data.error.code,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      )
    }
  } catch {
    // Fall through to the bounded transport error below.
  }

  return new CourierApiError(
    response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_FAILED',
    response.status,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  )
}
