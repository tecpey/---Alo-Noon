import { DomainError } from './errors'

/**
 * The pilot's coverage: which towns, villages and estates Alo Noon delivers to,
 * and which of them a motorcycle may reach.
 *
 * ## Why this is one city and one zone
 *
 * Bread comes out of Babol's bakeries. The order path pins a cart to exactly
 * one city *and* one operational zone, and refuses any offering whose branch
 * sits elsewhere — `assertRequestedContext` compares both, and the address is
 * checked against the cart the same way. So a Babol bakery can only serve an
 * address whose service area belongs to the same zone its branch does.
 *
 * That settles the shape. Babolsar and Amol are not separate cities in this
 * model, because a separate city would need its own bakeries; they are service
 * areas inside the one catchment the Babol branches operate in. The city is
 * named for the catchment rather than the town so nobody reads "Babol" on an
 * Amol order and assumes a mistake.
 *
 * ## Why circles, and why that is honest
 *
 * These are not surveyed boundaries. Each entry is a town centre and a radius,
 * and the polygon is a circle drawn around it — an approximation, stated as
 * one. A real boundary would follow the municipal limit, and the difference
 * shows at the edges: a house just outside a radius is refused, and a field
 * just inside it is accepted.
 *
 * That is the right trade for a pilot, for one reason: the alternative is not a
 * better boundary, it is no coverage at all, and every one of these addresses
 * currently cannot order. The admin panel can redraw any of them afterwards
 * against real deliveries, which is a far better source than a map traced now.
 *
 * ## The radii are sized so no two circles touch
 *
 * An address inside two service areas is refused as `SERVICE_AREA_AMBIGUOUS`,
 * which reads to the customer exactly like being out of range. Four pairs
 * overlapped on the first draft of this table — Babol with Amirkola, Babol with
 * its industrial estate, Babolsar with Khazarshahr, Khazarshahr with
 * Fereydunkenar — and the radii below are the sizes that leave each pair
 * clear.
 *
 * Circles cannot tile a plane, so the cost is the other way round: between two
 * adjacent circles there is a band belonging to neither, and an address there
 * is refused as unserviceable. The bands are deliberately thin — 69 metres
 * between Babol and its estate, 142 between Babolsar and Khazarshahr, 150
 * between Babol and Amirkola, and about 1.2km between Khazarshahr and
 * Fereydunkenar, which is farmland. Anything wider than that is a hole to close
 * with a real polygon in the panel rather than by widening a circle until it
 * collides with its neighbour.
 *
 * **Every coordinate here needs checking against a map before go-live.** They
 * are the best available from memory of Mazandaran's geography, which is good
 * enough to place a town within a kilometre or two and not good enough to bet a
 * delivery on. And because the radii are constrained by their neighbours rather
 * than chosen freely, a centre that is off by a kilometre does not simply shift
 * the circle — it moves coverage off one side of the town and pushes the circle
 * towards whatever sits on the other. Check the centres first, then the radii.
 *
 * ## Why most of them refuse motorcycles
 *
 * Babol and Amirkola are minutes apart and a motorcycle is the right tool.
 * Everything else is a road journey — twenty to forty kilometres, much of it on
 * roads a loaded motorcycle has no business doing at speed, in Mazandaran
 * weather. The distance threshold would catch most of them anyway; saying it on
 * the area makes it true regardless of what the threshold is later set to, and
 * true for the ones that sit just inside it.
 */

export interface CoverageArea {
  /** Stable code, used as the service area's code and as an idempotency key. */
  readonly code: string
  readonly nameFa: string
  /** Approximate town centre. Needs checking against a map. */
  readonly latitude: number
  readonly longitude: number
  /**
   * How far out the circle reaches, in metres.
   *
   * Sized against the neighbouring areas rather than against the town: two
   * circles that touch make every address in the overlap ambiguous, which is
   * refused and reads as "out of range". See the note above the table.
   */
  readonly radiusMetres: number
  readonly motorcycleAllowed: boolean
  /** Why this area is on the list, for whoever reviews it later. */
  readonly note: string
}

/**
 * Babol and its catchment, as the pilot covers it.
 *
 * Ordered by distance from Babol rather than alphabetically, so the shape of
 * the operation is visible by reading down the list.
 */
export const BABOL_PILOT_COVERAGE: readonly CoverageArea[] = Object.freeze([
  {
    code: 'BABOL_CENTRE',
    nameFa: 'بابل',
    latitude: 36.5513,
    longitude: 52.679,
    radiusMetres: 3_400,
    motorcycleAllowed: true,
    note: 'The pilot city. Where the bakeries are and where most orders come from.',
  },
  {
    code: 'AMIRKOLA',
    nameFa: 'امیرکلا',
    latitude: 36.59,
    longitude: 52.72,
    radiusMetres: 2_100,
    motorcycleAllowed: true,
    note: 'Five kilometres north of Babol and effectively continuous with it.',
  },
  {
    code: 'BABOL_INDUSTRIAL',
    nameFa: 'شهرک صنعتی بابل',
    latitude: 36.51,
    longitude: 52.73,
    radiusMetres: 3_000,
    motorcycleAllowed: false,
    note: 'Factory canteens order by the hundred; a motorcycle cannot carry it.',
  },
  {
    code: 'BABOLSAR',
    nameFa: 'بابلسر',
    latitude: 36.7025,
    longitude: 52.6575,
    radiusMetres: 3_000,
    motorcycleAllowed: false,
    note: 'Twenty kilometres north on the coast road.',
  },
  {
    code: 'KHAZARSHAHR',
    nameFa: 'خزرشهر و دریاکنار',
    latitude: 36.715,
    longitude: 52.595,
    radiusMetres: 2_600,
    motorcycleAllowed: false,
    note: 'Coastal residential complexes west of Babolsar; one area, they adjoin.',
  },
  {
    code: 'FEREYDUNKENAR',
    nameFa: 'فریدون‌کنار',
    latitude: 36.6861,
    longitude: 52.5219,
    radiusMetres: 3_500,
    motorcycleAllowed: false,
    note: 'Coast, west of Khazarshahr. Roughly twenty-five kilometres out.',
  },
  {
    code: 'QAEMSHAHR',
    nameFa: 'قائم‌شهر',
    latitude: 36.4631,
    longitude: 52.86,
    radiusMetres: 5_000,
    motorcycleAllowed: false,
    note: 'Twenty-five kilometres east. Its own city, served from Babol for now.',
  },
  {
    code: 'AMOL',
    nameFa: 'آمل',
    latitude: 36.4696,
    longitude: 52.3507,
    radiusMetres: 6_000,
    motorcycleAllowed: false,
    note: 'The furthest, about thirty-five kilometres west. Car only, always.',
  },
])

/** Metres per degree of latitude. Constant enough at this scale. */
const METRES_PER_DEGREE_LATITUDE = 111_320

/**
 * A circle as a GeoJSON polygon.
 *
 * Longitude degrees shrink towards the poles, so the east-west radius is
 * divided by the cosine of the latitude. Skipping that would draw an ellipse
 * squashed east-west — at Mazandaran's latitude by about twenty per cent, which
 * is a kilometre of coverage silently missing from either side of every town.
 *
 * The ring closes on its first point, which GeoJSON requires and which is the
 * kind of detail that fails as "this address is not serviceable" rather than as
 * an error anybody can read.
 */
export function circleToGeoJson(
  centre: { latitude: number; longitude: number },
  radiusMetres: number,
  segments = 48,
): { type: 'Polygon'; coordinates: number[][][] } {
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    throw new DomainError('INVALID_COVERAGE_RADIUS', 'A coverage radius must be positive')
  }
  if (!Number.isFinite(centre.latitude) || Math.abs(centre.latitude) > 90) {
    throw new DomainError('INVALID_COVERAGE_CENTRE', 'A coverage centre must be a real point')
  }
  if (!Number.isFinite(centre.longitude) || Math.abs(centre.longitude) > 180) {
    throw new DomainError('INVALID_COVERAGE_CENTRE', 'A coverage centre must be a real point')
  }
  if (!Number.isSafeInteger(segments) || segments < 8) {
    // Below about eight the shape is a polygon nobody would call a circle, and
    // the corners cut real streets out of the coverage.
    throw new DomainError('INVALID_COVERAGE_SEGMENTS', 'A circle needs at least eight segments')
  }

  const latitudeDelta = radiusMetres / METRES_PER_DEGREE_LATITUDE
  const longitudeDelta =
    radiusMetres / (METRES_PER_DEGREE_LATITUDE * Math.cos((centre.latitude * Math.PI) / 180))

  const ring: number[][] = []
  for (let step = 0; step < segments; step += 1) {
    const angle = (2 * Math.PI * step) / segments
    // GeoJSON is [longitude, latitude] — the opposite order to how everything
    // else in this codebase names a point, and the source of the classic bug
    // where a Babol address lands in the Indian Ocean.
    ring.push([
      round(centre.longitude + longitudeDelta * Math.cos(angle)),
      round(centre.latitude + latitudeDelta * Math.sin(angle)),
    ])
  }
  ring.push([...ring[0]!])
  return { type: 'Polygon', coordinates: [ring] }
}

/** Six places is about eleven centimetres — far past what a boundary needs. */
function round(value: number): number {
  return Number(value.toFixed(6))
}
