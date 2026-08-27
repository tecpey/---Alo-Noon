import Image from 'next/image'

import './storefront.css'

import { BrandMark } from './components/brand-mark'
import { ProductCard } from './components/product-card'
import { SiteHeader } from './components/site-header'
import {
  BagIcon,
  ChevronDownIcon,
  ChevronIcon,
  ClockIcon,
  PinIcon,
  SteamIcon,
} from './components/icons'
import {
  everydayBreads,
  heroCopy,
  orderConditions,
  specialBakes,
  type OrderCondition,
  type StorefrontSection,
} from '../lib/storefront-content'

/**
 * The storefront.
 *
 * One screen that answers, in order: whose shop this is, what it promises, on
 * what terms it can deliver to you, and what you can buy today. Nothing else —
 * a bread shop's home page competing for attention with itself is a bread shop
 * whose customers scroll instead of ordering.
 */
export const foundationStatus = 'زیرساخت سفارش نان آماده است'

const CONDITION_ICONS = {
  pin: PinIcon,
  bag: BagIcon,
  clock: ClockIcon,
} as const

function ConditionField({ condition }: { condition: OrderCondition }) {
  const Glyph = CONDITION_ICONS[condition.icon]
  return (
    <button type="button" className="condition">
      <span className="condition__glyph">
        <Glyph />
      </span>
      <span className="condition__text">
        <span className="condition__label">{condition.labelFa}</span>
        <span className="condition__value">{condition.valueFa}</span>
      </span>
      <ChevronDownIcon className="condition__chevron" />
    </button>
  )
}

function Section({ section, ratio }: { section: StorefrontSection; ratio: 'wide' | 'tall' }) {
  return (
    <section className="shelf" aria-labelledby={`${section.id}-title`}>
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
      </div>
      <div className={`shelf__grid shelf__grid--${ratio}`}>
        {section.products.map((product) => (
          <ProductCard key={product.slug} product={product} ratio={ratio} />
        ))}
      </div>
    </section>
  )
}

export default function HomePage() {
  return (
    <div className="app-frame">
      <SiteHeader basketCount={2} />

      <main>
        <section className="hero">
          {/*
            The photograph is the page's ground, not an illustration beside the
            words: it runs off the top and side of the frame and is veiled back
            into the paper so the headline sits on bread rather than next to it.
          */}
          <div className="hero__art" aria-hidden="true">
            <Image
              src="/products/hero-bread.jpg"
              alt=""
              width={1004}
              height={976}
              priority
              sizes="(max-width: 900px) 100vw, 55vw"
            />
            <span className="hero__veil" />
          </div>

          <div className="hero__copy">
            <h1>
              {heroCopy.headlineFa.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </h1>
            <p className="hero__lead">{heroCopy.leadFa}</p>
            <a className="an-button hero__cta" href="#special">
              {heroCopy.ctaFa}
              <ChevronIcon width={18} height={18} />
            </a>
          </div>

          {/*
            Where, how and when — asked once, before a basket exists, because
            together they decide which bakeries this customer even has.
          */}
          <div className="conditions" role="group" aria-label="شرایط تحویل">
            {orderConditions.map((condition) => (
              <ConditionField key={condition.id} condition={condition} />
            ))}
          </div>
        </section>

        <div id="special" />
        <Section section={specialBakes} ratio="wide" />
        <Section section={everydayBreads} ratio="tall" />
      </main>

      <footer className="site-footer">
        <BrandMark tone="light" />
        <p>{foundationStatus}</p>
      </footer>
    </div>
  )
}
