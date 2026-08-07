/**
 * Every payment gateway adapter's credential material is a UTF-8 JSON blob
 * (never a raw secret concatenated by convention), so a gateway needing more
 * than one secret field (e.g. SizPay's merchant/terminal/username/password)
 * fits the same single-value ResolvedProviderCredential.material contract as
 * a gateway needing only an API key.
 */
export function parseJsonCredential<T extends Record<string, unknown>>(
  material: Uint8Array,
  isShapeValid: (value: Record<string, unknown>) => value is T,
): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(material).toString('utf8'))
  } catch {
    throw new Error('CREDENTIAL_JSON_INVALID')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CREDENTIAL_SHAPE_INVALID')
  }
  const candidate = parsed as Record<string, unknown>
  if (!isShapeValid(candidate)) {
    throw new Error('CREDENTIAL_SHAPE_INVALID')
  }
  return candidate
}
