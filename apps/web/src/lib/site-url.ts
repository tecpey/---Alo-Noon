/**
 * Where this deployment lives, as an absolute origin.
 *
 * Deliberately without `import 'server-only'`, unlike the API client next to
 * it. That guard exists to keep credentials and session handling out of a
 * browser bundle; this reads one public URL and holds nothing worth guarding,
 * and the guard would only make the parsing untestable — which is the half most
 * worth pinning, since a malformed value ends up in a file search engines read.
 *
 * Needed by three things that cannot work with relative paths: `metadataBase`,
 * which resolves Open Graph image URLs; `robots.txt`, which has to name the
 * sitemap absolutely; and the sitemap itself, whose entries are absolute by
 * specification.
 *
 * Falls back to localhost rather than throwing. A missing variable in
 * development should not stop the site rendering, and in production the value
 * appears in a sitemap nobody has submitted yet rather than anywhere a customer
 * would be harmed by it — while a crash would take down the whole storefront
 * over a metadata concern.
 */
const FALLBACK = 'http://localhost:3000'

export function siteUrl(): URL {
  const raw = process.env['WEB_BASE_URL']?.trim()
  if (!raw) return new URL(FALLBACK)
  try {
    const url = new URL(raw)
    // Only a real web origin, and no credentials or path: this value is
    // interpolated into files search engines read, and a malformed one there is
    // worse than the default.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return new URL(FALLBACK)
    }
    return new URL(url.origin)
  } catch {
    return new URL(FALLBACK)
  }
}
