/**
 * The integrated Iranian gateways return the customer to the callback URL
 * through the customer's own browser, carrying result parameters. Those
 * parameters are attacker-controllable and must never be treated as proof of
 * payment — they are only used to identify *which* provider transaction the
 * callback refers to, so the receipt can be recorded and later verified
 * server-to-server.
 *
 * Each provider names its transaction reference differently, so extraction is
 * per-provider. This stays in the application layer rather than the domain SPI
 * because it is transport shape, not a payment invariant.
 */
export const CALLBACK_PROVIDER_CODES = ['NEXTPAY', 'SHEPA', 'IDPAY', 'ZARINPAL'] as const
export type CallbackProviderCode = (typeof CALLBACK_PROVIDER_CODES)[number]

export function isCallbackProviderCode(value: string): value is CallbackProviderCode {
  return (CALLBACK_PROVIDER_CODES as readonly string[]).includes(value)
}

// Field each provider uses for its own transaction reference, verified against
// the same sources the adapters were built from (nextpay-ir official repo,
// parsisolution/gateway Shepa and IDPay drivers, shetabit/multipay Zarinpal
// driver). Zarinpal capitalises its parameter — `Authority`, alongside a
// `Status` of OK or NOK that is deliberately ignored here, because a redirect
// the customer's browser carried is never allowed to conclude anything.
const EXTERNAL_EVENT_FIELD: Readonly<Record<CallbackProviderCode, string>> = Object.freeze({
  NEXTPAY: 'trans_id',
  SHEPA: 'token',
  IDPAY: 'id',
  ZARINPAL: 'Authority',
})

/**
 * Returns the provider's transaction reference, or null when the callback is
 * unusable. A null result must not be reported to the customer as a failed
 * payment — the payment may well have succeeded; only this redirect is
 * unusable, and the truth still comes from server-to-server verification.
 */
export function extractExternalEventId(
  providerCode: CallbackProviderCode,
  params: Readonly<Record<string, unknown>>,
): string | null {
  const raw = params[EXTERNAL_EVENT_FIELD[providerCode]]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length < 1 || trimmed.length > 200) return null
  return trimmed
}

/**
 * Flattens query and body into one string-valued map. Values are bounded and
 * non-string shapes dropped so a hostile redirect cannot push unbounded or
 * deeply nested JSON into the durable receipt payload.
 */
export function canonicalCallbackParams(
  sources: readonly (Record<string, unknown> | undefined | null)[],
): Record<string, string> {
  const canonical: Record<string, string> = {}
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (Object.keys(canonical).length >= 40) return canonical
      if (typeof key !== 'string' || key.length > 64) continue
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue
      }
      const stringValue = String(value)
      if (stringValue.length > 512) continue
      canonical[key] = stringValue
    }
  }
  return canonical
}
