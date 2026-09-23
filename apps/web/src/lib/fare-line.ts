import type { DeliveryEstimate } from '@alo-noon/contracts'

import { formatToman } from './persian'

/**
 * The delivery fare, in the words the shop is allowed to use for it.
 *
 * One function rather than a phrase written at each place it appears, because
 * the shelf and the basket showing the same number under different promises is
 * the failure this whole feature was meant to avoid. The `basis` decides the
 * sentence; nothing here may invent one.
 *
 * Why it exists at all: extra costs met late are the single largest fixable
 * cause of abandoned baskets Baymard measures — 39% of shoppers — and this shop
 * knew its own tariff from the first screen while saying nothing until after
 * sign-in, an address and a delivery window. Saying it early only helps if the
 * early number survives to the payment button, which is what `basis` protects.
 */
export interface FareLine {
  /** The headline, with the amount already in Toman and Persian digits. */
  text: string
  /** The qualifier, or null when the amount needs none. */
  note: string | null
  /** The free-delivery offer, when this tariff makes one. */
  freeOver: string | null
}

export function fareLine(estimate: DeliveryEstimate | null): FareLine | null {
  if (!estimate) return null

  const amount = formatToman(estimate.amount.amount)
  const freeOver =
    estimate.freeOver === null
      ? null
      : `سفارش بالای ${formatToman(estimate.freeOver.amount)}: ارسال رایگان`

  switch (estimate.basis) {
    case 'EXACT':
      // One flat tariff, no provider to consult. Nothing left can move it, so
      // this is a price and is allowed to read as one.
      return { text: `کرایهٔ پیک ${amount}`, note: 'برای این محدوده ثابت است', freeOver }
    case 'FROM':
      // A floor, and the note names both ways it can rise. `FROM` is produced
      // by a distance-banded tariff, by the customer having a choice of
      // vehicle, or by both — the launch tenant is the second case, where the
      // motorcycle is flat and only picking the car costs more. A note that
      // said "بسته به مسافت" alone would be describing the wrong variable
      // there, which is a small lie in the one place this feature exists to
      // stop telling them.
      return {
        text: `کرایهٔ پیک از ${amount}`,
        note: 'بسته به مسافت و وسیله‌ای که انتخاب می‌کنید',
        freeOver,
      }
    case 'INDICATIVE':
      // A delivery provider quotes at checkout and its answer wins — the way
      // the fare is worked out inside Tapsi's and Snapp's own applications.
      // «حدود» rather than a bare figure, and the note says who decides.
      return {
        text: `کرایهٔ پیک حدود ${amount}`,
        note: 'مبلغ دقیق هنگام ثبت سفارش از سرویس تحویل گرفته می‌شود',
        freeOver,
      }
  }
}
