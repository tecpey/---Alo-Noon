/**
 * The two cookies the shop keeps for a visitor who has not signed in.
 *
 * Named here rather than inline so the server action that writes them and the
 * pages that read them cannot drift apart over a typo — which fails silently,
 * as an empty catalogue rather than an error.
 */
export const CITY_COOKIE = 'alo_city'
export const ZONE_COOKIE = 'alo_zone'
