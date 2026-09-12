import { touch } from '@alo-noon/design-tokens'

/**
 * The floor for a control that cannot grow.
 *
 * A text link inside a sentence, or an icon riding in a dense row, has no room
 * to become 44 points tall without pushing the line apart. `hitSlop` is React
 * Native's answer: the touchable area extends past the drawn one, so the target
 * is full size to a thumb and unchanged to the eye. It has no web equivalent,
 * which is why the web stylesheet exempts inline links instead.
 *
 * Kept apart from the stylesheet beside it, and importing nothing from React
 * Native, because it is arithmetic and arithmetic should be testable without a
 * native runtime — `react-native`'s entry point is Flow, which a plain test
 * runner cannot parse.
 *
 * @param height the control's own drawn height, in points
 */
export function hitSlopTo(height: number) {
  const missing = Math.max(0, touch.minPoints - height)
  // Half on *each* side. Halving the shortfall once would leave the control
  // under the floor and look identical.
  const half = Math.ceil(missing / 2)
  return { top: half, bottom: half, left: half, right: half }
}
