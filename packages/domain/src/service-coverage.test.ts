import { describe, expect, it } from 'vitest'

import { calculateDeliveryDistanceMeters } from './delivery-pricing'
import { DomainError } from './errors'
import { BABOL_PILOT_COVERAGE, circleToGeoJson } from './service-coverage'

/**
 * The coverage circles, checked as geometry rather than as data.
 *
 * The failure this guards against is quiet and total: a polygon that is wrong
 * does not raise anything, it simply refuses every address inside the town it
 * was meant to cover, and the customer is told their address is not
 * serviceable. Nothing in the logs distinguishes that from a town nobody lives
 * in.
 */

/**
 * The same ray-casting test the API uses to decide serviceability.
 *
 * Reimplemented here on purpose rather than imported: the API's copy lives in a
 * Fastify module this package must not depend on, and a circle that satisfies a
 * bespoke "is it roughly round" assertion while failing the real containment
 * check would pass a test and refuse a city.
 */
function contains(polygon: { coordinates: number[][][] }, longitude: number, latitude: number) {
  const ring = polygon.coordinates[0]!
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]! as [number, number]
    const [xj, yj] = ring[j]! as [number, number]
    const straddles = yi > latitude !== yj > latitude
    if (straddles && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

describe('drawing a coverage circle', () => {
  const centre = { latitude: 36.5513, longitude: 52.679 }
  const circle = circleToGeoJson(centre, 5_000)

  it('closes the ring, which GeoJSON requires', () => {
    // An unclosed ring is not a polygon. It fails as "this address is not
    // serviceable" rather than as anything anybody could read.
    const ring = circle.coordinates[0]!
    expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(ring).toHaveLength(49)
  })

  it('puts the centre inside itself', () => {
    expect(contains(circle, centre.longitude, centre.latitude)).toBe(true)
  })

  it('reaches its radius in every direction, not just north', () => {
    // Longitude degrees shrink towards the poles. Without dividing by the
    // cosine of the latitude this would be an ellipse squashed east-west — at
    // Mazandaran's latitude by about a fifth, which is a kilometre of coverage
    // quietly missing from either side of every town.
    const ring = circle.coordinates[0]!
    const distances = ring.map(([longitude, latitude]) =>
      calculateDeliveryDistanceMeters(centre, { latitude: latitude!, longitude: longitude! }),
    )
    for (const distance of distances) {
      expect(distance).toBeGreaterThan(4_900)
      expect(distance).toBeLessThan(5_100)
    }
  })

  it('excludes a point beyond the radius', () => {
    // Ten kilometres north of the centre, which is past Amirkola.
    const outside = { latitude: centre.latitude + 0.09, longitude: centre.longitude }
    expect(contains(circle, outside.longitude, outside.latitude)).toBe(false)
  })

  it('refuses nonsense rather than drawing something unusable', () => {
    expect(() => circleToGeoJson(centre, 0)).toThrow(DomainError)
    expect(() => circleToGeoJson(centre, -1)).toThrow(DomainError)
    expect(() => circleToGeoJson({ latitude: 200, longitude: 0 }, 1_000)).toThrow(DomainError)
    expect(() => circleToGeoJson(centre, 1_000, 3)).toThrow(DomainError)
  })
})

describe('the Babol pilot coverage', () => {
  it('covers every town the pilot promised', () => {
    const codes = BABOL_PILOT_COVERAGE.map((area) => area.code)
    expect(codes).toEqual([
      'BABOL_CENTRE',
      'AMIRKOLA',
      'BABOL_INDUSTRIAL',
      'BABOLSAR',
      'KHAZARSHAHR',
      'FEREYDUNKENAR',
      'QAEMSHAHR',
      'AMOL',
    ])
  })

  it('gives every area a unique code, since it is the idempotency key', () => {
    // Two areas sharing a code means provisioning either creates one and
    // silently skips the other, or overwrites the first with the second.
    expect(new Set(BABOL_PILOT_COVERAGE.map((area) => area.code)).size).toBe(
      BABOL_PILOT_COVERAGE.length,
    )
  })

  it('places every centre in Mazandaran rather than in the sea', () => {
    // The coordinates need checking against a map before go-live and this is
    // not that check. It catches the one error that would be invisible: a pair
    // written the wrong way round, which puts a Babol address off Somalia.
    for (const area of BABOL_PILOT_COVERAGE) {
      expect(area.latitude).toBeGreaterThan(36.3)
      expect(area.latitude).toBeLessThan(36.9)
      expect(area.longitude).toBeGreaterThan(52.2)
      expect(area.longitude).toBeLessThan(53.0)
    }
  })

  it('lets a motorcycle serve only Babol and Amirkola', () => {
    // Everything else is a road journey of twenty kilometres or more. Stated on
    // the area rather than left to the distance threshold, so it stays true
    // whatever that threshold is later set to.
    const motorcycle = BABOL_PILOT_COVERAGE.filter((area) => area.motorcycleAllowed)
    expect(motorcycle.map((area) => area.code)).toEqual(['BABOL_CENTRE', 'AMIRKOLA'])
  })

  it('keeps the motorcycle areas genuinely close to the bakeries', () => {
    // The claim the flag above is making. If a motorcycle-allowed area were
    // forty kilometres out, the flag would be sending a rider there.
    const babol = BABOL_PILOT_COVERAGE[0]!
    for (const area of BABOL_PILOT_COVERAGE.filter((entry) => entry.motorcycleAllowed)) {
      expect(calculateDeliveryDistanceMeters(babol, area)).toBeLessThan(12_000)
    }
  })

  it('keeps every car-only area further out than the motorcycle ones', () => {
    const babol = BABOL_PILOT_COVERAGE[0]!
    const nearest = Math.min(
      ...BABOL_PILOT_COVERAGE.filter((area) => !area.motorcycleAllowed).map((area) =>
        calculateDeliveryDistanceMeters(babol, area),
      ),
    )
    const furthestMotorcycle = Math.max(
      ...BABOL_PILOT_COVERAGE.filter((area) => area.motorcycleAllowed).map((area) =>
        calculateDeliveryDistanceMeters(babol, area),
      ),
    )
    // Not a hard rule of the domain — an area can be car-only for reasons that
    // are not distance — but with this list it should hold, and if it stops
    // holding somebody has added an area that needs a second look.
    expect(nearest).toBeGreaterThan(furthestMotorcycle)
  })

  it('does not overlap two areas onto the same point', () => {
    // An address inside two areas is refused as SERVICE_AREA_AMBIGUOUS, which
    // reads to the customer exactly like being out of range. Circles this size
    // around towns this far apart should not touch; the one pair worth watching
    // is Babolsar and Khazarshahr, which adjoin in reality.
    for (const [index, area] of BABOL_PILOT_COVERAGE.entries()) {
      for (const other of BABOL_PILOT_COVERAGE.slice(index + 1)) {
        const gap = calculateDeliveryDistanceMeters(area, other)
        expect({
          pair: `${area.code}/${other.code}`,
          clear: gap > area.radiusMetres + other.radiusMetres,
        }).toEqual({ pair: `${area.code}/${other.code}`, clear: true })
      }
    }
  })
})
