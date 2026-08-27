import Image from 'next/image'

import { formatToman } from '../../lib/persian'
import type { StorefrontProduct } from '../../lib/storefront-content'

/**
 * One bread.
 *
 * The name and the price share a line, at opposite ends: in a list of breads
 * that differ by a few thousand Toman, a price stacked under a name is a price
 * that has to be hunted for. Reading right to left, the name comes first
 * because it is what is being chosen, and the price closes the line because it
 * is what is being weighed.
 */
export function ProductCard({
  product,
  ratio = 'wide',
}: {
  product: StorefrontProduct
  /** `wide` for the special bakes, `tall` for the packaged row. */
  ratio?: 'wide' | 'tall'
}) {
  return (
    <a className={`product-card product-card--${ratio}`} href={`/products/${product.slug}`}>
      <span className="product-card__frame">
        <Image
          src={product.imageUrl}
          alt={product.imageAlt}
          width={624}
          height={ratio === 'wide' ? 204 : 180}
        />
      </span>
      <span className="product-card__row">
        <span className="product-card__name">{product.nameFa}</span>
        <span className="product-card__price">{formatToman(product.priceRial)}</span>
      </span>
    </a>
  )
}
