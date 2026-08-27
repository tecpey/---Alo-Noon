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
