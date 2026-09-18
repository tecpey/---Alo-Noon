import type { TextStyle } from 'react-native'

/**
 * The shop's typeface, and the one rule that makes it work on a phone.
 *
 * ## Why this file exists at all
 *
 * React Native does not synthesise a bold from a regular for a custom font the
 * way a browser does. On iOS `fontWeight` is simply ignored once `fontFamily`
 * names a font that was loaded at runtime — the text renders at whatever weight
 * that file is — and on Android the matching is version-dependent and has been
 * wrong in both directions. So `fontWeight` cannot be trusted, and a screen that
 * asks for the Vazirmatn family at weight 800 gets regular weight on an iPhone
 * — nobody notices until a heading looks flat in a screenshot.
 *
 * The rule, therefore: **one family name per weight, and no `fontWeight`
 * anywhere**. `persianText` below is how a screen asks for a weight, and it
 * returns the family rather than the weight.
 *
 * ## Why it matters more here than in most apps
 *
 * Without a loaded font, iOS renders Persian in Geeza Pro — a face designed for
 * Arabic, with the wrong shapes for the letters Persian added (گ چ پ ژ) and a
 * look nobody in Iran associates with a modern product. Android falls back to
 * Noto Naskh, which is closer and still not the brand. The name «الو نون», the
 * logo and this typeface were chosen together with the people who follow the
 * account; rendering them in the system fallback is shipping somebody else's
 * design.
 *
 * ## The names are a contract
 *
 * These strings are what `expo-font` registers each file under, and what every
 * `fontFamily` refers to. They live here rather than in either app so the two
 * cannot drift — a courier app that loaded `Vazirmatn-Black` while its styles
 * asked for `Vazirmatn-ExtraBold` would silently fall back to the system font,
 * which is exactly the failure this package exists to prevent.
 *
 * The files themselves stay in each app's `assets/fonts`, because a `require`
 * of a binary asset is resolved relative to the file that writes it and Metro's
 * handling of assets inside a linked workspace package is not something worth
 * betting a release on.
 */
export const fontFamily = {
  /** Body text. Vazirmatn at 400. */
  regular: 'Vazirmatn-Regular',
  /** Emphasis, labels, values. Vazirmatn at 700. */
  bold: 'Vazirmatn-Bold',
  /** Headings and prices. Vazirmatn at 800. */
  extraBold: 'Vazirmatn-ExtraBold',
} as const

export type FontFamilyName = (typeof fontFamily)[keyof typeof fontFamily]

/** The three files each app must load, keyed by the name to load them under. */
export const FONT_FAMILY_NAMES: readonly FontFamilyName[] = Object.freeze([
  fontFamily.regular,
  fontFamily.bold,
  fontFamily.extraBold,
])

/**
 * SHA-256 of each file, so the two apps cannot ship different cuts of the same
 * typeface.
 *
 * The files are copies — one set per app, because Metro resolves an asset
 * `require` relative to the file that writes it — and copies drift. A customer
 * app on Vazirmatn and a courier app on something a shade heavier is two
 * products from two companies, which is exactly what this shared package exists
 * to prevent, and it is invisible to everyone who does not put the two phones
 * side by side.
 *
 * Each app's own test checks its files against these. Updating the typeface
 * therefore means updating this table, which is the point: it turns "somebody
 * replaced a font file" from an accident into a deliberate act with a diff.
 *
 * These were produced from Vazirmatn's variable font by instancing the weight
 * axis at 400, 700 and 800 — static cuts rather than one variable file, because
 * React Native's variable-font support is partial and platform-dependent, and a
 * variable font that loads and then renders every weight at its default is the
 * same silent failure as no font at all.
 */
export const FONT_FILE_DIGESTS: Readonly<Record<FontFamilyName, string>> = Object.freeze({
  [fontFamily.regular]: 'daf9e0735f083ce5442c4fc0db6e6a245413ab49bf8deea26eca0348dedb5f07',
  [fontFamily.bold]: '698551bc32b1f286f86382081de885270ef800fd59c0d29034f467267884e3d1',
  [fontFamily.extraBold]: 'bb98f1ae2f356f308ebf70758583a7866ced80a01c2cc21e2fda3d770f297ee6',
})

/**
 * The weights a screen is allowed to ask for.
 *
 * Three, not six. The styles across both apps used 400, 600, 700, 800 and 900,
 * which is five files of about 127KB each for differences no one could point to
 * on a phone screen — 600 and 700 are a hair apart at 13pt, and 800 and 900 are
 * indistinguishable. They collapse to these three.
 */
export type TextWeight = 'regular' | 'bold' | 'extraBold'

/**
 * A weight, as a style a screen can spread.
 *
 * Returns `fontFamily` and deliberately no `fontWeight`: setting both is the
 * mistake this whole file is about, and a style object that carries only the
 * family cannot make it.
 */
export function persianText(weight: TextWeight = 'regular'): TextStyle {
  return { fontFamily: fontFamily[weight] }
}
