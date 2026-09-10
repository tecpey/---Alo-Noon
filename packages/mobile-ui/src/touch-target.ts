import { StyleSheet } from 'react-native'

import { touch } from '@alo-noon/design-tokens'

/**
 * How small a thing anybody is expected to hit is allowed to be, on a phone.
 *
 * The same floor the web carries, from the same token, because these are the
 * same product: a customer who installs the shop as a web app and later
 * installs it from a store should not find the second one harder to use.
 *
 * It matters more here than there. The web version is often a thumb on a table;
 * this is a courier at a door in the rain, one-handed, with a bag in the other,
 * pressing "تحویل شد" — and a target that takes two attempts at that moment is
 * a target that gets pressed twice.
 */

export const touchTarget = StyleSheet.create({
  /**
   * The floor, for a control that is its own box: a chip, a tab, a row button.
   *
   * `justifyContent: 'center'` comes with it deliberately. `minHeight` alone
   * grows the box and leaves the label at the top of it, so the control looks
   * taller without the label moving — which is a layout change with none of the
   * benefit.
   */
  min: {
    minHeight: touch.minPoints,
    justifyContent: 'center',
  },
  /** Primary actions: the one button a screen exists to have pressed. */
  comfortable: {
    minHeight: touch.comfortablePoints,
    justifyContent: 'center',
  },
})
