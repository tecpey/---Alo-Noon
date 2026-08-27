/**
 * Image files, so the brand mark can be imported rather than `require`d.
 *
 * Metro resolves a PNG import to an asset reference, not to the bytes; the
 * opaque type says so, so nothing downstream tries to treat it as a string.
 */
declare module '*.png' {
  const asset: number
  export default asset
}

/**
 * A module's own source text, which Vitest can serve with `?raw`.
 *
 * Used by one test that has to inspect source rather than behaviour. Reading it
 * with `node:fs` instead would mean adding Node's types to an app that runs on
 * a phone, and the first person to believe `fs` exists there would ship code
 * that crashes on a device rather than failing to compile.
 */
declare module '*?raw' {
  const source: string
  export default source
}
