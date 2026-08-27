/**
 * Turning one HTTP response into a result.
 *
 * This is the half of the transport that has no I/O in it, so it lives outside
 * `api-core.ts` — that module opens with `import 'server-only'`, which by design
 * makes it unimportable from a test. The decisions worth pinning are here:
 * which payloads count as an error, and what a success with no body means.
 */

export interface ApiFailure {
  code: string
  message: string
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure }

export interface Envelope<T> {
  result: ApiResult<T>
  meta?: unknown
}

/**
 * `payload` is whatever `response.json()` produced, or null when the body was
 * empty or unparseable.
 *
 * A bodiless success is a success. `DELETE /api/v1/auth/session` answers 204
 * with no envelope at all, and reading `.data` off that used to throw inside the
 * Server Action that signs a customer out — the API had already revoked the
 * session, so the crash landed on someone who was, in fact, signed out.
 *
 * A bodiless *failure* is the opposite problem: there is no code to show, so one
 * is synthesised from the status rather than reporting success by omission.
 */
export function decodeEnvelope<T>(status: number, ok: boolean, payload: unknown): Envelope<T> {
  if (!ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload.error as ApiFailure)
        : { code: `HTTP_${status}`, message: 'درخواست ناموفق بود.' }
    return { result: { ok: false, error } }
  }

  if (payload === null || typeof payload !== 'object') {
    return { result: { ok: true, data: undefined as T } }
  }

  const envelope = payload as { data: T; meta?: unknown }
  return { result: { ok: true, data: envelope.data }, meta: envelope.meta }
}

/**
 * True when the API refused for lack of a session, as opposed to lack of
 * permission. Only the first sends someone back to sign in — an account without
 * a grant needs to be told that, not bounced through a login it will complete
 * successfully and land right back where it was.
 */
export function isUnauthenticated(error: ApiFailure): boolean {
  return error.code === 'SESSION_UNAUTHORIZED'
}

/** A uuid, checked before it is interpolated into a path segment. */
export function isUuid(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value)
}

/**
 * Picks one cookie's value out of a Set-Cookie list.
 *
 * The API issues a session only as a cookie — the response body never carries
 * the token — so signing in means reading it here and re-setting it on this
 * origin. Only the named cookie is relayed: any other cookie the API sets is
 * left alone rather than blindly copied onto this domain.
 */
export function sessionTokenFromSetCookie(
  setCookies: readonly string[],
  cookieName: string,
): string | null {
  for (const entry of setCookies) {
    const [pair] = entry.split(';')
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() !== cookieName) continue
    const value = pair.slice(separator + 1).trim()
    // A clearing cookie (`name=; Max-Age=0`) is not a session.
    if (value) return value
  }
  return null
}
