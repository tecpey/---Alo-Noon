/**
 * Environment and runtime configuration for Alo Noon platform
 * Uses Zod for type-safe environment validation
 */

import { z } from 'zod'

// Core environment schema
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
    API_VERSION: z
      .string()
      .regex(/^v\d+$/)
      .default('v1'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // Database
    DATABASE_URL: z.string().url().optional(),
    // Redis (future)
    REDIS_URL: z.string().url().optional(),
    // Authentication secrets are optional outside production so isolated tests and
    // non-auth development surfaces can start without committed defaults.
    AUTH_OTP_PEPPER: z.string().min(32).optional(),
    AUTH_SESSION_PEPPER: z.string().min(32).optional(),
    // Observability
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    SENTRY_DSN: z.string().url().optional(),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return

    for (const key of ['AUTH_OTP_PEPPER', 'AUTH_SESSION_PEPPER'] as const) {
      if (!env[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production`,
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

// Validation function with detailed error reporting
export function validateEnv<T extends Env = Env>(
  env: Record<string, string | undefined>,
): { success: true; data: T } | { success: false; errors: string[] } {
  const result = envSchema.safeParse(env)

  if (result.success) {
    return { success: true, data: result.data as T }
  }

  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  return { success: false, errors }
}

// Get validated environment with fail-fast behavior
export function getEnv(): Env {
  const result = validateEnv(process.env)

  if (!result.success) {
    console.error('Environment validation failed:')
    result.errors.forEach((err) => console.error(`  - ${err}`))
    process.exit(1)
  }

  return result.data
}

// App metadata
export const appMeta = {
  name: 'Alo Noon',
  nameFa: 'آلو نون',
  tagline: 'Fresh bread, delivered',
  taglineFa: 'نان تازه، درب منزل',
  version: process.env['npm_package_version'] ?? '0.0.1',
  apiVersion: 'v1',
  locale: 'fa-IR',
  timezone: 'Asia/Tehran',
} as const

export type AppMeta = typeof appMeta
