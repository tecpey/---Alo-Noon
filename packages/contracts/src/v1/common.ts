import { z } from 'zod'

export const uuidSchema = z.string().uuid()
export const isoDateTimeSchema = z.string().datetime({ offset: true })
export const currencySchema = z.enum(['IRR'])
export const moneySchema = z.object({
  amount: z.string().regex(/^\d+$/, 'Money amount must be an unsigned integer string'),
  currency: currencySchema,
})
export type MoneyContract = z.infer<typeof moneySchema>

export const responseMetaSchema = z.object({
  requestId: uuidSchema,
  timestamp: isoDateTimeSchema,
  version: z.literal('v1'),
})
export type ResponseMeta = z.infer<typeof responseMetaSchema>

export const apiErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  details: z.record(z.unknown()).optional(),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: apiErrorSchema,
  meta: responseMetaSchema,
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ApiError
  meta?: ResponseMeta
}

export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(80).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})
export type PaginationParams = z.infer<typeof paginationParamsSchema>

export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
  hasNextPage: z.boolean(),
  hasPreviousPage: z.boolean(),
})
export type PaginationMeta = z.infer<typeof paginationMetaSchema>

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  meta: ResponseMeta & { pagination: PaginationMeta }
}

export type UUID = z.infer<typeof uuidSchema>
export type ISO8601DateTimeString = z.infer<typeof isoDateTimeSchema>

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
