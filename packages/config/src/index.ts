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
    AUTH_ABUSE_PEPPER: z.string().min(32).optional(),
    API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    // Payment provider adapters resolve this to build each gateway's callback URL;
    // no adapter can initialize a payment without it.
    PAYMENT_CALLBACK_BASE_URL: z.string().url().optional(),
    // Observability
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    SENTRY_DSN: z.string().url().optional(),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return

    for (const key of ['AUTH_OTP_PEPPER', 'AUTH_SESSION_PEPPER', 'AUTH_ABUSE_PEPPER'] as const) {
      if (!env[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production`,
        })
      }
    }
    const configuredPeppers = [
      env.AUTH_OTP_PEPPER,
      env.AUTH_SESSION_PEPPER,
      env.AUTH_ABUSE_PEPPER,
    ].filter((value): value is string => value !== undefined)
    if (new Set(configuredPeppers).size !== configuredPeppers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_OTP_PEPPER'],
        message: 'Authentication peppers must be independent production secrets',
      })
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

export function parseCorsOrigins(value: string): string[] {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)

  return origins.map((origin) => {
    if (origin === '*') throw new Error('CORS_ORIGINS cannot contain a wildcard')

    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`CORS origin is invalid: ${origin}`)
    }
    if (url.origin !== origin) {
      throw new Error(`CORS origin must not include a path: ${origin}`)
    }
    return url.origin
  })
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
