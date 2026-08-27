'use client'

import { CheckIcon, PlusIcon } from './icons'
import { useStorefront } from './storefront-state'
import { toPersianDigits } from '../../lib/persian'

/**
 * Adding this bread to the basket, from its own page.
 *
 * On a card the control is a single `+`, because the customer is skimming a
 * shelf and one tap is the whole interaction. Here they have stopped to read,
 * so the control shows how many they have and lets them change it in place —
 * going back to the shelf to press `+` four more times would be the worse half
 * of both designs.
 *
 * Once something is in the basket the button becomes the way to open it, since
 * "I have added it, now what" is the next question and the answer is otherwise
 * a small badge in the corner of the screen.
 */
export function ProductBuy({ offeringId, nameFa }: { offeringId: string; nameFa: string }) {
  const { lines, add, remove, openDrawer } = useStorefront()
  const quantity = lines.get(offeringId) ?? 0

  if (quantity === 0) {
    return (
      <button type="button" className="an-button product__buy" onClick={() => add(offeringId)}>
        <PlusIcon width={18} height={18} />
        افزودن به سبد خرید
      </button>
    )
  }

  return (
    <div className="product__buy-row">
      <div className="stepper stepper--large">
        <button type="button" onClick={() => add(offeringId)} aria-label={`یکی بیشتر از ${nameFa}`}>
          <PlusIcon width={18} height={18} />
        </button>
        <span aria-live="polite">{toPersianDigits(String(quantity))}</span>
        <button
          type="button"
          onClick={() => remove(offeringId)}
          aria-label={`یکی کمتر از ${nameFa}`}
        >
          <span aria-hidden="true">−</span>
        </button>
      </div>
      <button type="button" className="an-button product__buy" onClick={openDrawer}>
        <CheckIcon width={18} height={18} />
        دیدن سبد خرید
      </button>
    </div>
  )
}
