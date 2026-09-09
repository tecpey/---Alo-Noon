'use server'

import { revalidatePath } from 'next/cache'

import { addFavourite, rateOrder, removeFavourite, reorder } from './shop-api'
import { translateProviderError } from './admin-format'

/**
 * Coming back, from the browser's side.
 *
 * Nothing here decides anything. The server prices a reorder, judges whether a
 * rating is allowed and owns the favourite; these actions carry the answer back
 * and turn a refusal code into a sentence somebody can act on.
 */

export type ReorderOutcome =
  | {
      ok: true
      addedCount: number
      /** What could not be repeated. Empty when the whole order came back. */
      adjustments: readonly { nameFa: string; reason: string; quantity: number }[]
    }
  | { ok: false; message: string }

export type RatingOutcome = { ok: true } | { ok: false; message: string }

export async function reorderAction(orderId: string): Promise<ReorderOutcome> {
  const result = await reorder(orderId)
  if (!result.ok) {
    return {
      ok: false,
      message: translateProviderError(result.error.code, 'تکرار سفارش ممکن نشد.'),
    }
  }
  // The basket lives on the server now, so every page that shows it is stale.
  revalidatePath('/')
  revalidatePath('/checkout')
  return {
    ok: true,
    addedCount: result.data.addedCount,
    adjustments: result.data.adjustments.map((adjustment) => ({
      nameFa: adjustment.nameFa,
      reason: adjustment.reason,
      quantity: adjustment.quantity,
    })),
  }
}

export async function rateOrderAction(
  orderId: string,
  breadScore: number,
  deliveryScore?: number,
  comment?: string,
): Promise<RatingOutcome> {
  const result = await rateOrder(orderId, {
    breadScore,
    ...(deliveryScore !== undefined && { deliveryScore }),
    ...(comment && { comment }),
  })
  if (!result.ok) {
    return { ok: false, message: translateProviderError(result.error.code, 'ثبت امتیاز ممکن نشد.') }
  }
  revalidatePath('/orders')
  return { ok: true }
}

export async function toggleFavouriteAction(
  offeringId: string,
  next: boolean,
): Promise<{ ok: boolean }> {
  const result = next ? await addFavourite(offeringId) : await removeFavourite(offeringId)
  if (result.ok) revalidatePath('/favourites')
  return { ok: result.ok }
}
