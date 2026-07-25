/**
 * Shared API contracts and type definitions for Alo Noon platform
 * Framework-independent, versioned contracts
 */

// Base response envelope
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ApiError
  meta?: ResponseMeta
}

export interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ResponseMeta {
  requestId: string
  timestamp: string
  version: string
}

// Pagination
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  meta: ResponseMeta & {
    pagination: PaginationMeta
  }
}

export interface PaginationMeta {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface PaginationParams {
  page?: number
  pageSize?: number
  sort?: string
  order?: 'asc' | 'desc'
}

// Health check
export interface HealthResponse extends ApiResponse {
  data: {
    status: 'healthy' | 'degraded' | 'unhealthy'
    uptime: number
    version: string
    checks: HealthCheck[]
  }
}

export interface HealthCheck {
  name: string
  status: 'pass' | 'fail' | 'warn'
  latency?: number
  message?: string
}

// Ready check
export interface ReadyResponse extends ApiResponse {
  data: {
    ready: boolean
    checks: ReadyCheck[]
  }
}

export interface ReadyCheck {
  name: string
  ready: boolean
  message?: string
}

// Common types
export type UUID = string
export type ISO8601DateString = string
export type ISO8601DateTimeString = string

export interface Timestamps {
  createdAt: ISO8601DateTimeString
  updatedAt: ISO8601DateTimeString
}

export interface SoftDelete extends Timestamps {
  deletedAt: ISO8601DateTimeString | null
}

// HTTP status codes
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const

export type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus]
