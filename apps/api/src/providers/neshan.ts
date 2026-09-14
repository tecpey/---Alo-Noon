import {
  PLACE_SEARCH_MAX_RESULTS,
  type PlaceCandidate,
  type PlaceSearchRequest,
  type PlaceSearchResult,
  type ResolvedRoutingCredential,
  type ReverseGeocodeRequest,
  type ReverseGeocodeResult,
  type RouteLeg,
  type RouteRequest,
  type RouteResult,
  type RoutingProvider,
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
 *
 * ## Search and reverse geocoding
 *
 * Re-verified against the same client, version 1.1.1, so these rest on the same
 * evidence as the routing above rather than on the documentation site — which
 * is unreachable from here, exactly as it was when the routing was written:
 *
 *     GET /v1/search?term=<text>[&lat=<lat>&lng=<lng>]   (neshan/places.py)
 *     GET /v2/reverse?lat=<lat>&lng=<lng>                (neshan/geocoding.py)
 *
 * both with the same `Api-Key` header and the same error envelope — a 200 whose
 * `status` is not "ok", carrying `code` and `message` (`client.py:_get_body`).
 *
 * The client's own docstring states the search reply's top level: `count` and
 * `items`. It states nothing reliable about the fields inside an item, nor about
 * the reverse reply — its `reverse_geocode` docstring promises a list while the
 * code returns the whole object, so the two disagree and neither is evidence.
 *
 * Both readers here are therefore written to survive being wrong. The search
 * reader accepts several plausible spellings per field, keeps only candidates
 * carrying a usable coordinate, and reports EMPTY rather than inventing one. The
 * reverse reader assembles nothing: it returns a line only if the provider
 * supplies one whole, because an address stitched together from guessed fields
 * is a confident-looking sentence that sends bread to the wrong door.
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

    async searchPlaces(request: PlaceSearchRequest): Promise<PlaceSearchResult> {
      const apiKey = readApiKey(request.credential)
      if (!apiKey) {
        return { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_CREDENTIAL_INVALID' }
      }

      const url = new URL(`${origin}/v1/search`)
      url.searchParams.set('term', request.term)
      // Sent as two parameters, not one joined pair — this endpoint takes `lat`
      // and `lng` separately, unlike `/v2/direction` which takes `lat,lng`.
      if (request.bias) {
        url.searchParams.set('lat', String(request.bias.latitude))
        url.searchParams.set('lng', String(request.bias.longitude))
      }

      const body = await getJson(url, apiKey, request.timeoutMs)
      if (body.outcome !== 'OK') {
        return { outcome: 'UNAVAILABLE', reasonCode: body.reasonCode }
      }

      const failure = readEnvelopeFailure(body.value)
      if (failure) {
        return { outcome: 'UNAVAILABLE', reasonCode: failure }
      }

      const candidates: PlaceCandidate[] = []
      for (const item of readArray(body.value, 'items')) {
        const candidate = readCandidate(item)
        if (candidate) candidates.push(candidate)
        if (candidates.length === PLACE_SEARCH_MAX_RESULTS) break
      }
      if (candidates.length === 0) {
        // Either the provider knows nowhere by that name, or every item it sent
        // was unreadable. Both leave the customer with nothing to choose, and
        // the distinction is not one they can act on.
        return { outcome: 'EMPTY', reasonCode: 'NESHAN_NO_PLACES' }
      }
      return { outcome: 'FOUND', candidates }
    },

    async reverseGeocode(request: ReverseGeocodeRequest): Promise<ReverseGeocodeResult> {
      const apiKey = readApiKey(request.credential)
      if (!apiKey) {
        return { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_CREDENTIAL_INVALID' }
      }

      const url = new URL(`${origin}/v2/reverse`)
      url.searchParams.set('lat', String(request.coordinates.latitude))
      url.searchParams.set('lng', String(request.coordinates.longitude))

      const body = await getJson(url, apiKey, request.timeoutMs)
      if (body.outcome !== 'OK') {
        return { outcome: 'UNAVAILABLE', reasonCode: body.reasonCode }
      }

      const failure = readEnvelopeFailure(body.value)
      if (failure) {
        return { outcome: 'UNAVAILABLE', reasonCode: failure }
      }

      // Only a line the provider assembled itself. Nothing is concatenated from
      // separate fields here: the customer reads this back to decide whether the
      // pin is their house, so a plausible sentence that is subtly wrong is
      // worse than no sentence at all.
      const formattedAddress =
        readString(body.value, 'formatted_address') ?? readString(body.value, 'formattedAddress')
      if (!formattedAddress) {
        return { outcome: 'EMPTY', reasonCode: 'NESHAN_NO_ADDRESS' }
      }
      return { outcome: 'RESOLVED', formattedAddress }
    },
  }
}

/**
 * One GET, one JSON body, and every failure flattened into a reason code.
 *
 * Shared by search and reverse because the two differ only in path and
 * parameters; routing keeps its own copy because it has to tell UNROUTABLE from
 * UNAVAILABLE, a distinction neither of these has.
 */
type JsonFetch = { outcome: 'OK'; value: unknown } | { outcome: 'FAILED'; reasonCode: string }

async function getJson(url: URL, apiKey: string, timeoutMs: number): Promise<JsonFetch> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Key': apiKey, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { outcome: 'FAILED', reasonCode: `NESHAN_HTTP_${response.status}` }
    }
    const value = (await response.json().catch(() => null)) as unknown
    return { outcome: 'OK', value }
  } catch {
    return { outcome: 'FAILED', reasonCode: 'NESHAN_REQUEST_FAILED' }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Neshan reports failure inside a 200 by setting `status` to something other
 * than "ok", so the HTTP status alone never decides this. Returns the reason
 * code for a failure, or null when the envelope is fine.
 */
function readEnvelopeFailure(body: unknown): string | null {
  const status = readString(body, 'status')
  if (status === null || status.toLowerCase() === 'ok') return null
  return neshanReasonCode(status, readCode(body))
}

/**
 * Reads one search item, accepting the spellings a place API plausibly uses.
 *
 * A candidate without a usable coordinate is dropped rather than shown: its only
 * purpose is to become a delivery address, and one that cannot is a row the
 * customer can select and then not order from.
 */
function readCandidate(item: unknown): PlaceCandidate | null {
  const location = readObject(item, 'location') ?? item
  const latitude = readNumber(location, 'y') ?? readNumber(location, 'latitude')
  const longitude = readNumber(location, 'x') ?? readNumber(location, 'longitude')
  if (latitude === null || longitude === null) return null
  // Iran spans roughly 25–40N, 44–64E. The check is the whole planet's range
  // rather than the country's: the failure it exists to catch is x and y
  // arriving the other way round, which puts a Babol address in the Indian
  // Ocean, not a customer legitimately ordering from an unexpected place.
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null

  const title = readString(item, 'title') ?? readString(item, 'name')
  const address = readString(item, 'address') ?? readString(item, 'region')
  if (!title && !address) return null

  return {
    title: title ?? address!,
    address: title ? address : null,
    coordinates: { latitude, longitude },
    distanceMetres: readNonNegativeInteger(item, 'distance'),
  }
}

function readObject(source: unknown, field: string): unknown {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[field]
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function readNumber(source: unknown, field: string): number | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNonNegativeInteger(source: unknown, field: string): number | null {
  const value = readNumber(source, field)
  return value === null || value < 0 ? null : Math.round(value)
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
