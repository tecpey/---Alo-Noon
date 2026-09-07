/**
 * الو نون — the service worker.
 *
 * Its job is narrow and its restraint is the point. A service worker sits
 * between a customer and every response the shop gives them, and this shop's
 * responses are prices, baskets, delivery windows, wallet balances and payment
 * verdicts. Every one of those is only true for a moment. A worker that cached
 * pages "for speed" would eventually show somebody yesterday's price, or a
 * basket they had already checked out, or — the one that cannot be allowed to
 * happen — a payment result page saying a payment succeeded when it did not.
 *
 * So this caches exactly two kinds of thing:
 *
 *   1. Files whose URL changes when their content changes. Next.js fingerprints
 *      everything under `/_next/static/`, and the fonts and brand images are
 *      versioned by hand and change about once a year. A stale copy of one of
 *      these is not stale, it is the file.
 *
 *   2. One offline page, so a customer on a lift or in a basement gets the
 *      shop's own apology in their own language instead of the browser's
 *      dinosaur.
 *
 * Everything else goes to the network every time. Not "network first with a
 * cache fallback" — network, full stop. A cache fallback for a page is how a
 * stale price gets shown, and there is no amount of speed worth that.
 *
 * That restraint is also what makes the update strategy safe below.
 */

const VERSION = 'v1'
const CACHE = `alo-noon-${VERSION}`
const OFFLINE_URL = '/offline'

/**
 * What is worth having before it is needed.
 *
 * The offline page and the icons only: the icons because a phone draws them
 * while the app is starting, the offline page because the one moment it is
 * needed is the one moment it cannot be fetched.
 *
 * Deliberately short. A worker that precaches the whole shop delays its own
 * installation behind a download the customer did not ask for, on a connection
 * that is often somebody's mobile data.
 */
const PRECACHE = [
  OFFLINE_URL,
  '/brand/icon-192.png',
  '/brand/icon-512.png',
  '/brand/icon-maskable-192.png',
  '/brand/icon-maskable-512.png',
]

/**
 * The prefixes safe to keep. An allow-list, not a deny-list: a new dynamic
 * route added next month is not cached by accident, it is simply not on this
 * list. The failure mode of forgetting to add something here is a slower load;
 * the failure mode of forgetting to exclude something from a deny-list is a
 * wrong price.
 */
const CACHEABLE_PREFIXES = ['/_next/static/', '/fonts/', '/brand/', '/products/']

/**
 * And it has to look like a file, not just live under the right folder.
 *
 * `/products/` is two things at once: a folder of photographs in `public`, and
 * the route a bread's own page is served from. The prefix alone would therefore
 * match `/products/barbari` — not the navigation, which is handled above and
 * never cached, but the data request the page makes for itself when somebody
 * taps through to it. That payload carries this morning's price, and a cached
 * copy of it is the exact thing this whole file exists to prevent.
 *
 * An extension is what separates the two. A photograph ends in `.jpg`; a route,
 * and the data behind it, never ends in anything.
 */
const STATIC_FILE = /\.(?:js|mjs|css|woff2?|png|jpe?g|gif|svg|webp|avif|ico|json|txt|map)$/

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Individually, not `addAll`: `addAll` rejects as a unit, so one missing
      // icon would leave the worker with no offline page either.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }))
          } catch {
            // A precache miss is not worth failing an installation over. The
            // fetch handler treats everything here as optional anyway.
          }
        }),
      )
      /**
       * Take over immediately.
       *
       * Normally a rude thing to do — it swaps the worker under a page that is
       * already running. It is safe here precisely because this worker never
       * serves a cached page: the only responses it can substitute are
       * fingerprinted assets, whose URLs the running page already resolved. The
       * alternative is worse, because a shop where every customer keeps one tab
       * open forever is a shop where a fix ships to nobody.
       */
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Every cache but this version's. A rename of CACHE is the whole upgrade
      // mechanism: ship a new VERSION and last release's assets are dropped.
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('alo-noon-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Only GET. A Server Action, a sign-in, a payment start — none of those is
  // something to have opinions about, and a worker that touches them is a
  // worker that can lose one.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Only this origin. The gateway a customer is sent to, a map tile, a
  // registrar's badge: not ours to hold.
  if (url.origin !== self.location.origin) return

  // A navigation is a page, and pages are never cached here. What this gives is
  // the offline page instead of the browser's error, which is the whole reason
  // a customer would notice this worker exists at all.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request)
        } catch {
          const cached = await caches.match(OFFLINE_URL)
          return (
            cached ??
            new Response('آفلاین هستید.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          )
        }
      })(),
    )
    return
  }

  const cacheable =
    CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) &&
    STATIC_FILE.test(url.pathname)
  if (!cacheable) return

  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      // Cache first, and no revalidation behind it: these URLs are content
      // addressed, so a hit is not a guess about freshness, it is the answer.
      if (cached) return cached

      const response = await fetch(request)
      // Only a clean, complete, same-origin answer is worth keeping. An opaque
      // response has an unknown status, and caching a 404 or a 500 would pin
      // the failure until the next release.
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE)
        cache.put(request, response.clone()).catch(() => {
          // Storage full, or a private window that refuses to persist. The
          // response is already on its way to the page either way.
        })
      }
      return response
    })(),
  )
})
