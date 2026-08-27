'use client'

import Image from 'next/image'

import { useStorefront } from './storefront-state'
import { CheckIcon, PlusIcon } from './icons'
import { formatToman, toPersianDigits } from '../../lib/persian'
import type { StorefrontProduct } from '../../lib/storefront-content'

/**
 * One bread, and the shortest possible path to buying it.
 *
 * The card used to be a link wrapped around everything. That made this a
 * catalogue — a customer who knows they want two lavash had to open a product
 * page, add, come back, and do it again — and when the add button went on the
 * card it also made the markup invalid, because a button inside an anchor is
 * interactive content inside interactive content and browsers are free to do
 * whatever they like with it.
 *
 * So the card is a plain article. The product name is the link, and it stretches
 * its own hit area over the whole card with a pseudo-element. The add button
 * sits above that layer. Result: one link, one button, both real, and a whole
 * card that is still clickable.
 *
 * The name and the price share a line, at opposite ends. In a list of breads
 * that differ by a few thousand Toman, a price stacked under a name is a price
 * that has to be hunted for.
 */
export function ProductCard({
  product,
  ratio = 'wide',
}: {
  product: StorefrontProduct
  /** `wide` for the special bakes, `tall` for the packaged row. */
  ratio?: 'wide' | 'tall'
}) {
  const { lines, add } = useStorefront()
  const quantity = lines.get(product.slug) ?? 0

  return (
    <article className={`product-card product-card--${ratio}`}>
      <div className="product-card__frame">
        <Image
          src={product.imageUrl}
          alt={product.imageAlt}
          width={624}
          height={ratio === 'wide' ? 204 : 180}
        />
        <span className="product-card__sheen" aria-hidden="true" />

        <button
          type="button"
          className={`product-card__add${quantity > 0 ? ' is-held' : ''}`}
          onClick={() => add(product.slug)}
          aria-label={`افزودن ${product.nameFa} به سبد خرید`}
        >
          {quantity > 0 ? (
            <>
              <CheckIcon width={16} height={16} />
              <span aria-hidden="true">{toPersianDigits(String(quantity))}</span>
            </>
          ) : (
            <PlusIcon width={18} height={18} />
          )}
        </button>
      </div>

      <div className="product-card__row">
        <a className="product-card__name" href={`/products/${product.slug}`}>
          {product.nameFa}
        </a>
        <span className="product-card__price">{formatToman(product.priceRial)}</span>
      </div>
    </article>
  )
}
