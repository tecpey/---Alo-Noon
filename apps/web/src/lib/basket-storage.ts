import { BASKET_STORAGE_KEY, parseStoredBasket, type BasketLine } from './basket-lines'

/**
 * The browser half of the basket, in one place.
 *
 * Local storage is allowed to not exist. Private windows, cleared site data and
 * browsers set to block storage all throw on access rather than returning
 * nothing, and a shop that will not render because it could not save a basket is
 * a worse shop than one that forgets it.
 */
export function readStoredBasket(): BasketLine[] {
  try {
    return parseStoredBasket(window.localStorage.getItem(BASKET_STORAGE_KEY))
  } catch {
    return []
  }
}

export function writeStoredBasket(value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(BASKET_STORAGE_KEY)
    else window.localStorage.setItem(BASKET_STORAGE_KEY, value)
  } catch {
    /* A basket that cannot be saved is still a basket for this visit. */
  }
}
