import { useFonts } from 'expo-font'
import { fontFamily } from '@alo-noon/mobile-ui'

/**
 * Loading Vazirmatn, and deciding what to do if it will not load.
 *
 * The keys are the names every `fontFamily` in this app refers to, and they come
 * from `@alo-noon/mobile-ui` rather than being typed out, so a rename cannot
 * leave the styles pointing at a family that was never registered. That failure
 * is silent — the text renders in the system font, which for Persian on iOS is
 * Geeza Pro.
 *
 * `require` rather than an import, because Metro resolves an asset `require`
 * relative to this file and that is what puts the binaries in the bundle. The
 * files live in this app rather than in the shared package for the same reason:
 * Metro's handling of assets inside a linked workspace package is not something
 * worth betting a release on, and a font is three small files.
 */
export function useAppFonts(): boolean {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const [loaded, error] = useFonts({
    [fontFamily.regular]: require('../assets/fonts/Vazirmatn-Regular.ttf'),
    [fontFamily.bold]: require('../assets/fonts/Vazirmatn-Bold.ttf'),
    [fontFamily.extraBold]: require('../assets/fonts/Vazirmatn-ExtraBold.ttf'),
  })
  /* eslint-enable @typescript-eslint/no-require-imports */

  /**
   * Ready means "stop waiting", not "the font arrived".
   *
   * An error here is treated as ready on purpose. An app that never paints
   * because a typeface failed to decode is worse in every way than one that
   * paints in the system font: the rider can still read their next stop, and
   * the only thing lost is the one thing that was never worth a blank screen at
   * the side of a road.
   */
  return loaded || error !== null
}
