import { z } from 'zod'

import { responseMetaSchema, type ApiResponse } from './common'

export const healthCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['pass', 'fail', 'warn']),
  latency: z.number().nonnegative().optional(),
  message: z.string().optional(),
})
export type HealthCheck = z.infer<typeof healthCheckSchema>

export const healthDataSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  uptime: z.number().nonnegative(),
  version: z.string(),
  checks: z.array(healthCheckSchema),
})

export const healthResponseSchema = z.object({
  success: z.literal(true),
  data: healthDataSchema,
  meta: responseMetaSchema,
})
export interface HealthResponse extends ApiResponse {
  success: true
  data: z.infer<typeof healthDataSchema>
  meta: z.infer<typeof responseMetaSchema>
}

export const readyCheckSchema = z.object({
  name: z.string().min(1),
  ready: z.boolean(),
  message: z.string().optional(),
})
export type ReadyCheck = z.infer<typeof readyCheckSchema>

export const readyDataSchema = z.object({
  ready: z.boolean(),
  checks: z.array(readyCheckSchema),
})
export const readyResponseSchema = z.object({
  success: z.boolean(),
  data: readyDataSchema,
  meta: responseMetaSchema,
})
export interface ReadyResponse extends ApiResponse {
  data: z.infer<typeof readyDataSchema>
  meta: z.infer<typeof responseMetaSchema>
}
