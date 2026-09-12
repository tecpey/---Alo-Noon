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
    /**
     * Which interface to listen on.
     *
     * The default binds everywhere, because a container has no other useful
     * choice — its loopback is its own and nothing outside could reach it. On a
     * server where the API sits behind nginx, set this to `127.0.0.1`: left at
     * the default, the API answers on the public interface too, and a request
     * that arrives there skips TLS and arrives with no proxy headers, so the
     * rate limiter and the OTP abuse counters see the wrong client entirely.
     */
    API_HOST: z.string().min(1).default('0.0.0.0'),
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
    // Deliberately not defaulted: production must state its topology explicitly.
    /**
     * Which upstream addresses are allowed to say who the client is.
     *
     * Rate limiting and OTP abuse control both key on `request.ip`, so getting
     * this wrong silently collapses every user into one shared bucket —
     * throttling real customers while giving an attacker no per-IP limit at all.
     *
     * An address list, not a hop count. This used to be `API_TRUST_PROXY_HOPS`,
     * a number of proxies to trust, and Fastify 5.12 removed that mode for a
     * good reason: counting hops cannot tell you *who* the immediate peer is, so
     * a client connecting directly could forge `X-Forwarded-For` with enough
     * entries and be believed. Fastify now refuses to trust anything when given
     * a number — which would have left this service with proxy trust configured,
     * apparently working, and every request attributed to the load balancer.
     *
     * Accepts what `proxy-addr` accepts: one or more comma-separated IPs or
     * CIDR blocks, or the presets `loopback`, `linklocal` and `uniquelocal`.
     * `loopback` is right for a reverse proxy on the same host, which is the
     * usual single-server deployment. Absent means no proxy is trusted, which is
     * only correct when the API is exposed directly.
     */
    API_TRUST_PROXY: z.string().min(1).optional(),
    /**
     * A tombstone, declared only so it can be refused.
     *
     * Zod drops keys the schema does not name, so without this the old variable
     * would be invisible to the check below and a deployment carrying it would
     * boot with no proxy trusted at all.
     */
    API_TRUST_PROXY_HOPS: z.string().optional(),
    // Payment provider adapters resolve this to build each gateway's callback URL;
    // no adapter can initialize a payment without it.
    PAYMENT_CALLBACK_BASE_URL: z.string().url().optional(),
    // Where the customer's browser is sent after returning from the gateway.
    // Carries no payment verdict — only an opaque reference.
    PAYMENT_RESULT_REDIRECT_URL: z.string().url().optional(),
    // Base64 32-byte AES-256-GCM key that opens `local-encrypted://` payment
    // credentials. Kept apart from the encrypted values themselves so leaking the
    // configuration does not leak the gateway secret.
    PAYMENT_SECRET_ENCRYPTION_KEY: z.string().optional(),
    /**
     * Origin the Zarinpal adapter talks to, keeping Zarinpal's own paths.
     *
     * Absent, a TEST configuration uses Zarinpal's real sandbox and a PRODUCTION
     * one uses the live gateway, which is what both want. It exists for the same
     * reason the SMS override below does: a deployment that cannot reach the
     * sandbox from its own network still needs the money path exercised
     * end to end before real money is at stake.
     */
    PAYMENT_ZARINPAL_ENDPOINT: z.string().url().optional(),
    /**
     * The same override for Zibal, which publishes no separate sandbox host —
     * one set of endpoints serves both environments, so a stand-in is the only
     * way to exercise its money path without a live merchant.
     */
    PAYMENT_ZIBAL_ENDPOINT: z.string().url().optional(),
    /**
     * Where the LimooSMS adapter posts.
     *
     * Absent it uses the gateway's real endpoint, which is what production
     * wants. It exists because there is otherwise no way to prove a deployment
     * can sign anyone in without texting a real person and spending the
     * tenant's credit — a smoke test that has to be run against live customers
     * is one nobody runs.
     */
    AUTH_SMS_LIMOSMS_ENDPOINT: z.string().url().optional(),
    /**
     * Where the Expo push adapter sends, for the same two reasons as the SMS
     * endpoint above.
     *
     * A stub proves the channel works without reaching Expo's servers, which is
     * the only way to test that a customer with the app gets a push and one
     * without gets a text. And a deployment whose network cannot reach
     * exp.host directly can point this at a proxy rather than at a fork of the
     * adapter.
     */
    EXPO_PUSH_ENDPOINT: z.string().url().optional(),
    /**
     * Where the Neshan routing adapter asks, keeping Neshan's own paths.
     *
     * Absent it uses the real service, which is what production wants. Routing
     * has a fallback that keeps orders flowing when it is unreachable, so unlike
     * the payment and SMS overrides this one exists for development rather than
     * for proving a deployment works.
     */
    ROUTING_NESHAN_ENDPOINT: z.string().url().optional(),
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
    if (env.API_TRUST_PROXY === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_TRUST_PROXY'],
        message:
          'API_TRUST_PROXY must be set explicitly in production. Give the address of the reverse proxy in front of the API — "loopback" when it runs on the same host, otherwise its IP or CIDR block — or "none" only when the API is exposed directly. Guessing wrong disables per-IP rate limiting and OTP abuse control.',
      })
    }
  })
  .superRefine((env, context) => {
    /**
     * The old variable, refused loudly rather than ignored — in every
     * environment, not only production.
     *
     * A deployment carrying `API_TRUST_PROXY_HOPS=1` from before this changed
     * would otherwise start cleanly with *no* proxy trusted at all: the exact
     * failure the setting exists to prevent, and invisible from the outside
     * because the service still answers every request. Better to refuse to boot
     * and say what to write instead.
     */
    if (env.API_TRUST_PROXY_HOPS !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_TRUST_PROXY_HOPS'],
        message:
          'API_TRUST_PROXY_HOPS is no longer supported: a hop count cannot identify the immediate peer, so a client connecting directly could forge X-Forwarded-For and be believed. Replace it with API_TRUST_PROXY naming the proxy itself — "loopback" for a proxy on the same host, otherwise its IP or CIDR block.',
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
  // Spelled as the wordmark spells it. The logo is the authority on the
  // brand's own name, and a product whose panel and whose sign disagree about
  // that has two names.
  nameFa: 'الو نون',
  tagline: 'Fresh bread, delivered',
  taglineFa: 'نان تازه، زندگی گرم',
  version: process.env['npm_package_version'] ?? '0.0.1',
  apiVersion: 'v1',
  locale: 'fa-IR',
  timezone: 'Asia/Tehran',
} as const

export type AppMeta = typeof appMeta
