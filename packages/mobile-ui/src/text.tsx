import { forwardRef } from 'react'
// The one file allowed to reach for the raw components: it is what every other
// file imports instead. The rule that forbids this everywhere else is in
// `@alo-noon/eslint-config/react-native`.
/* eslint-disable no-restricted-imports */
import {
  Text as RNText,
  TextInput as RNTextInput,
  StyleSheet,
  type TextInputProps,
  type TextProps,
} from 'react-native'
/* eslint-enable no-restricted-imports */

import { fontFamily } from './typography'

/**
 * `Text` and `TextInput`, with the shop's typeface already on them.
 *
 * ## Why these exist rather than a rule people follow
 *
 * React Native inherits a font from a parent `<Text>` and from nothing else — a
 * `<View>` passes nothing down, and there is no theme provider for type. So
 * every one of the ~180 text nodes across the two apps would have to name a
 * family, and the one that forgot would render in the system font, which for
 * Persian on iOS is Geeza Pro. Nothing throws. Nobody notices until a
 * screenshot.
 *
 * Shadowing the two components moves that from a rule into a fact: a screen
 * changes its import line and every label it already had is in Vazirmatn. It is
 * also the only approach that survives React 19, which removed `defaultProps`
 * on function components — the trick most React Native codebases used for this.
 *
 * An eslint rule in each app forbids importing `Text` or `TextInput` from
 * `react-native` directly, so the next screen cannot quietly go back to the
 * system font.
 *
 * ## Why the family goes first in the array
 *
 * `StyleSheet.flatten` resolves later entries over earlier ones, so a style that
 * asks for `fontFamily: fontFamily.bold` wins and a style that says nothing gets
 * regular. That is the whole mechanism, and it is why these wrappers can be
 * dropped in without touching a single existing style.
 */

const base = StyleSheet.create({
  text: { fontFamily: fontFamily.regular },
})

export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...props }, ref) {
  return <RNText ref={ref} {...props} style={[base.text, style]} />
})

/**
 * The input needs it for two things, not one: what somebody types, and the
 * placeholder they read before they type. Both are drawn by this component, and
 * a placeholder in Geeza Pro under a label in Vazirmatn is the giveaway that
 * nobody looked at the screen.
 */
export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(
  { style, ...props },
  ref,
) {
  return <RNTextInput ref={ref} {...props} style={[base.text, style]} />
})
