/**
 * Where to send somebody after they sign in.
 *
 * Checkout sends a signed-out visitor to `/account?next=/checkout` so they come
 * back to the basket they were paying for rather than to a page they did not
 * ask for. That parameter is attacker-controlled — it arrives in a URL anyone
 * can compose and send — so it is validated rather than trusted.
 *
 * Only a path on this origin is allowed. A value naming another host is an open
 * redirect: a link that looks like the shop's own sign-in and lands on someone
 * else's page is the oldest way to run a convincing phishing page off a real
 * domain. The rejected cases below are all things that survive naive checks —
 * `//evil.example` is protocol-relative and a browser reads it as a host, and a
 * backslash is treated as a slash by several of them.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/account'): string {
  if (!value) return fallback
  // Must be a path on this origin, and only a path.
  if (!value.startsWith('/')) return fallback
  // Protocol-relative (`//host`) and backslash variants name another host.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  // A control character — a newline above all — can split a Location header.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback
  return value
}
