'use client'

import { EmptyBasketArt, SteamRibbon } from './brand-art'
import { ProductCard } from './product-card'
import { Reveal } from './reveal'
import { SteamIcon } from './icons'
import { useStorefront } from './storefront-state'
import type { StorefrontSection } from '../../lib/storefront-content'

/**
 * A shelf of bread, filtered by whichever chip is selected.
 *
 * When the filter empties a shelf it says so rather than vanishing. A section
 * that disappears leaves a customer wondering whether they broke something; a
 * section that says "nothing in this category on this shelf" and offers the way
 * back is a section that answered the question they were about to ask.
 *
 * When the filter empties *every* shelf the page would otherwise be a header
 * and a footer, which is why the empty state is drawn rather than written: it
 * is the one screen where the product has nothing to give, and a blank space
 * there says nobody thought about that moment.
 */
export function Shelf({ section, ratio }: { section: StorefrontSection; ratio: 'wide' | 'tall' }) {
  const { category, selectCategory } = useStorefront()
  const products =
    category === 'all'
      ? section.products
      : section.products.filter((product) => product.categoryId === category)

  return (
    <section className="shelf" id={section.id} aria-labelledby={`${section.id}-title`}>
      <Reveal>
        <div className="an-section-head">
          <div className="an-section-head__title">
            <span className="shelf__mark" aria-hidden="true">
              <SteamIcon width={16} height={16} />
            </span>
            <div>
              <h2 id={`${section.id}-title`}>{section.titleFa}</h2>
              <p className="an-section-head__note">{section.noteFa}</p>
            </div>
          </div>
          <SteamRibbon className="shelf__ribbon" />
        </div>
      </Reveal>

      {products.length === 0 ? (
        <div className="shelf__empty">
          <EmptyBasketArt className="shelf__empty-art" />
          <p className="shelf__empty-text">در این دسته، چیزی روی این قفسه نیست.</p>
          <button
            type="button"
            className="an-button an-button--quiet"
            onClick={() => selectCategory('all')}
          >
            نمایش همهٔ نان‌ها
          </button>
        </div>
      ) : (
        <div className={`shelf__grid shelf__grid--${ratio}`}>
          {products.map((product, index) => (
            <Reveal key={product.slug} delay={index}>
              <ProductCard product={product} ratio={ratio} />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  )
}
