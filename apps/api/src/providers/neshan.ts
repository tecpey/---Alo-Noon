import type {
  ResolvedRoutingCredential,
  RouteLeg,
  RouteRequest,
  RouteResult,
  RoutingProvider,
} from '@alo-noon/domain'

/**
 * Neshan (نشان) routing, verified against its official Python client on PyPI.
 *
 * What that client establishes, and what this adapter is built on:
 *
 *     GET https://api.neshan.org/v2/direction
 *         ?origin=<lat>,<lng>&destination=<lat>,<lng>
 *         [&waypoints=<lat>,<lng>|<lat>,<lng>]
 *         [&avoidTrafficZone=true][&avoidOddEvenZone=true]
 *     Api-Key: <key>          (header, not a query parameter)
 *
 * with the reply carrying `routes`, and an error carrying a `status` that is not
 * "ok" alongside `code` and `message`.
 *
 * The two avoid parameters are the reason this is Neshan and not a generic
 * routing library. Iranian cities run a congestion zone and an odd/even plate
 * scheme, and a route through a zone the courier may not enter is not a shorter
 * route — it is a fine, and a delivery that does not arrive.
 *
 * **The shape inside a route is read defensively, on purpose.** Neshan follows
 * the widely-copied `legs[].distance.value` convention, but that detail could
 * not be confirmed from source in the environment this was written in — only the
 * endpoint, the parameters, the header, and the error envelope could. So the
 * reader accepts either an object with a `value` or a bare number, sums the legs,
 * and returns UNAVAILABLE when it finds nothing it can trust. A shape surprise
 * then costs a fallback to the straight-line estimate, which is a slightly wrong
 * fare on one order; guessing at a number would be a confidently wrong fare on
 * every order, which is worse and harder to notice.
 */
const PRODUCTION_ORIGIN = 'https://api.neshan.org'

/**
 * Neshan's direction API takes no vehicle parameter in the contract its client
 * exposes, so both profiles reach the same endpoint today. The profile is still
 * carried through the SPI and the cache key rather than dropped: it is a real
 * property of the journey, it already changes the answer for other engines, and
 * a cache keyed without it would serve a car's distance to a motorcycle the day
 * Neshan does add one.
 */
export interface CreateNeshanAdapterOptions {
  testOnly?: boolean
  /** Overrides the API origin, keeping Neshan's own paths. */
  endpointOrigin?: string
}

/**
 * The credential is the key itself, not a JSON envelope around it.
 *
 * Neshan needs exactly one secret, and this matches how SMS credentials are
 * already stored — an operator putting a key behind `env://ROUTING_NESHAN_KEY`
 * pastes the key. The payment gateways use JSON because several of them need
 * more than one field; making routing match them would add an encoding step
 * whose only visible symptom, when got wrong, is a gateway that quietly refuses.
 */
function readApiKey(credential: ResolvedRoutingCredential): string | null {
  const key = Buffer.from(credential.material).toString('utf8').trim()
  return key.length > 0 ? key : null
}

/** `lat,lng`, the only coordinate format the API accepts. */
function point(coordinates: { latitude: number; longitude: number }): string {
  return `${coordinates.latitude},${coordinates.longitude}`
}

export function createNeshanAdapter(options: CreateNeshanAdapterOptions = {}): RoutingProvider {
  const origin = (options.endpointOrigin ?? PRODUCTION_ORIGIN).replace(/\/+$/, '')

  return {
    code: 'NESHAN',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    async route(request: RouteRequest): Promise<RouteResult> {
      const apiKey = readApiKey(request.credential)
      if (!apiKey) {
        return { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_CREDENTIAL_INVALID' }
      }

      const url = new URL(`${origin}/v2/direction`)
      url.searchParams.set('origin', point(request.origin))
      url.searchParams.set('destination', point(request.destination))
      if (request.waypoints && request.waypoints.length > 0) {
        url.searchParams.set('waypoints', request.waypoints.map(point).join('|'))
      }
      // Sent only when true: the client omits them otherwise, and sending
      // `false` to an API that was never shown to accept it is a guess.
      if (request.restrictions.avoidTrafficZone) url.searchParams.set('avoidTrafficZone', 'true')
      if (request.restrictions.avoidOddEvenZone) url.searchParams.set('avoidOddEvenZone', 'true')

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Api-Key': apiKey, Accept: 'application/json' },
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as unknown

        if (!response.ok) {
          return { outcome: 'UNAVAILABLE', reasonCode: `NESHAN_HTTP_${response.status}` }
        }

        // Neshan reports failure inside a 200 by setting `status` to something
        // other than "ok" — so the HTTP status alone never decides this.
        const status = readString(body, 'status')
        if (status !== null && status.toLowerCase() !== 'ok') {
          return {
            outcome: status.toLowerCase() === 'zero_results' ? 'UNROUTABLE' : 'UNAVAILABLE',
            reasonCode: neshanReasonCode(status, readCode(body)),
          }
        }

        const routes = readArray(body, 'routes')
        if (routes.length === 0) {
          // Asked and answered: the engine has no route between these points.
          return { outcome: 'UNROUTABLE', reasonCode: 'NESHAN_NO_ROUTE' }
        }

        const legs = readLegs(routes[0])
        if (legs.length === 0) {
          return { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_ROUTE_UNREADABLE' }
        }

        const distanceMetres = legs.reduce((total, leg) => total + leg.distanceMetres, 0)
        const durations = legs.map((leg) => leg.durationSeconds)
        const durationSeconds = durations.every((value) => value !== null)
          ? durations.reduce((total, value) => total + (value ?? 0), 0)
          : undefined

        return {
          outcome: 'ROUTED',
          distanceMetres,
          ...(durationSeconds !== undefined && { durationSeconds }),
          legs,
        }
      } catch {
        // An abort and a refused connection are the same thing here: no answer.
        // The caller falls back to an estimate rather than failing the order.
        return { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_REQUEST_FAILED' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/**
 * Reads the legs of a route, accepting either `{ value }` or a bare number for
 * each measurement. A leg without a usable distance drops the whole route rather
 * than being counted as zero: a missing leg would silently shorten the journey.
 */
function readLegs(route: unknown): readonly RouteLeg[] {
  const legs = readArray(route, 'legs')
  const parsed: RouteLeg[] = []
  for (const leg of legs) {
    const distanceMetres = readMeasurement(leg, 'distance')
    if (distanceMetres === null) return []
    parsed.push({ distanceMetres, durationSeconds: readMeasurement(leg, 'duration') })
  }
  return parsed
}

function readMeasurement(source: unknown, field: 'distance' | 'duration'): number | null {
  if (!source || typeof source !== 'object') return null
  const raw = (source as Record<string, unknown>)[field]
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['value']
      : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  // Metres and seconds, rounded up: a fractional metre is not a real measurement
  // and the fare arithmetic downstream works in whole units.
  return Math.ceil(value)
}

function readArray(source: unknown, field: string): readonly unknown[] {
  if (!source || typeof source !== 'object') return []
  const value = (source as Record<string, unknown>)[field]
  return Array.isArray(value) ? value : []
}

function readString(source: unknown, field: string): string | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const value = (source as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readCode(source: unknown): number | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)['code']
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

// Reason codes are recorded against an estimate and read by operators, so they
// stay in one shape: upper case, underscore separated, no provider prose.
function neshanReasonCode(status: string, code: number | null): string {
  const safe = status
    .replace(/[^A-Za-z0-9]/g, '_')
    .toUpperCase()
    .slice(0, 32)
  return code === null ? `NESHAN_${safe}` : `NESHAN_${safe}_${code < 0 ? `NEG_${-code}` : code}`
}
