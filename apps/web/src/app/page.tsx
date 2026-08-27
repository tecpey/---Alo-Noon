import Image from 'next/image'

import './storefront.css'

import { ArchTexture } from './components/brand-art'
import { BasketDrawer } from './components/basket-drawer'
import { CitySwitch } from './components/city-switch'
import { Shelf } from './components/shelf'
import { StorefrontProvider } from './components/storefront-state'
import { BrandMark } from './components/brand-mark'
import { CategoryRail } from './components/category-rail'
import { Reveal } from './components/reveal'
import { RetryButton } from './components/retry-button'
import { SiteHeader } from './components/site-header'
import {
  BagIcon,
  ChevronDownIcon,
  ChevronIcon,
  ClockIcon,
  CourierIcon,
  OvenIcon,
  PinIcon,
  ShieldIcon,
  SteamIcon,
  WheatIcon,
} from './components/icons'
import { toPersianDigits } from '../lib/persian'
import { loadStorefront, type StorefrontData } from '../lib/storefront-data'
import {
  foundationStatus,
  heroCopy,
  orderConditions,
  orderSteps,
  trustClaims,
  type OrderCondition,
} from '../lib/storefront-content'

// Prices, availability and which bakeries are open all change during a day, and
// none of them may be served from a cache built at deploy time.
export const dynamic = 'force-dynamic'

const CONDITION_ICONS = {
  pin: PinIcon,
  bag: BagIcon,
  clock: ClockIcon,
} as const

const TRUST_ICONS = {
  clock: ClockIcon,
  oven: OvenIcon,
  shield: ShieldIcon,
  courier: CourierIcon,
} as const

function ConditionField({ condition, value }: { condition: OrderCondition; value: string }) {
  const Glyph = CONDITION_ICONS[condition.icon]
  return (
    <button type="button" className="condition">
      <span className="condition__glyph">
        <Glyph duotone />
      </span>
      <span className="condition__text">
        <span className="condition__label">{condition.labelFa}</span>
        <span className="condition__value">{value}</span>
      </span>
      <ChevronDownIcon className="condition__chevron" />
    </button>
  )
}

/**
 * The storefront.
 *
 * The page answers, in order: whose shop this is, what it promises, on what
 * terms it can reach you, why you should believe it, what you can buy today,
 * and how the whole thing works. Nothing else — a bread shop's home page
 * competing for attention with itself is a bread shop whose customers scroll
 * instead of ordering.
 *
 * The bread is real. It comes from the catalog API, scoped to the city this
 * visitor is in, which is the same city the prices, the bakeries and the
 * delivery fare are decided against. Everything below the shelves is copy,
 * because it describes how the shop works rather than what is in it.
 *
 * Depth is used as a language rather than as decoration. There are exactly
 * three planes: the photograph at the back, the paper the shop is printed on,
 * and glass for the two things that float above both — the pinned top bar and
 * the delivery panel lying on the hero. A card sitting flat on paper gets no
 * glass, because there is nothing behind it to see through.
 */
export default async function HomePage() {
  const storefront = await loadStorefront()
  const products =
    storefront.state === 'ready'
      ? storefront.catalog.shelves.flatMap((shelf) => shelf.products)
      : []

  return (
    <StorefrontProvider products={products}>
      <div className="app-frame">
        <SiteHeader />

        <main>
          <section className="hero">
            {/*
              The photograph is the page's ground, not an illustration beside
              the words: it runs off the top and side of the frame and is veiled
              back into the paper, so the headline sits on bread rather than
              next to it.
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
              <span className="hero__eyebrow">
                <WheatIcon width={16} height={16} />
                نانوایی‌های محلهٔ شما
              </span>
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
              together they decide which bakeries this customer even has. It is
              glass because it lies on the photograph: a solid panel here would
              punch a hole in the picture it is sitting on.

              The city is the one field that is not a placeholder: it is the city
              the shelves below were actually priced in.
            */}
            <div className="conditions" role="group" aria-label="شرایط تحویل">
              {orderConditions.map((condition) => (
                <ConditionField
                  key={condition.id}
                  condition={condition}
                  value={
                    condition.id === 'address' && storefront.state === 'ready'
                      ? storefront.city.nameFa
                      : condition.valueFa
                  }
                />
              ))}
            </div>
          </section>

          <Reveal className="trust-wrap">
            <ul className="trust">
              {trustClaims.map((claim) => {
                const Glyph = TRUST_ICONS[claim.icon]
                return (
                  <li key={claim.id} className="trust__item">
                    <span className="trust__glyph">
                      <Glyph duotone width={22} height={22} />
                    </span>
                    <div>
                      <p className="trust__title">{claim.titleFa}</p>
                      <p className="trust__body">{claim.bodyFa}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Reveal>

          <Catalog storefront={storefront} />

          <section className="steps" aria-labelledby="steps-title">
            <ArchTexture className="steps__texture" />
            <Reveal>
              <div className="an-section-head">
                <div className="an-section-head__title">
                  <span className="shelf__mark" aria-hidden="true">
                    <SteamIcon width={16} height={16} />
                  </span>
                  <div>
                    <h2 id="steps-title">سفارش در سه قدم</h2>
                    <p className="an-section-head__note">بدون تماس، بدون معطلی پشت تنور</p>
                  </div>
                </div>
              </div>
            </Reveal>
            <ol className="steps__list">
              {orderSteps.map((step, index) => (
                <Reveal key={step.id} delay={index}>
                  <li className="step">
                    <span className="step__number" aria-hidden="true">
                      {toPersianDigits(String(index + 1))}
                    </span>
                    <p className="step__title">{step.titleFa}</p>
                    <p className="step__body">{step.bodyFa}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </section>
        </main>

        <footer className="site-footer">
          <ArchTexture className="site-footer__texture" />
          <div className="site-footer__inner">
            <BrandMark tone="light" />
            <p>{foundationStatus}</p>
          </div>
        </footer>
        <BasketDrawer />
      </div>
    </StorefrontProvider>
  )
}

/**
 * The shelves, or an honest account of why there are none.
 *
 * Each of the four states is a different thing to tell a customer, and
 * collapsing them into one "چیزی برای نمایش نیست" would tell them nothing they
 * could act on: choosing a city, waiting, and the shop not having opened in
 * their town yet are three different next steps.
 */
function Catalog({ storefront }: { storefront: StorefrontData }) {
  if (storefront.state === 'choose-city') {
    return (
      <section className="catalog-state" aria-labelledby="catalog-state-title">
        <h2 id="catalog-state-title">شهرتان را انتخاب کنید</h2>
        <p>نان‌ها، قیمت‌ها و زمان تحویل برای هر شهر جداگانه تعیین می‌شود.</p>
        <CitySwitch cities={storefront.cities} />
      </section>
    )
  }

  if (storefront.state === 'closed') {
    return (
      <section className="catalog-state" aria-labelledby="catalog-state-title">
        <h2 id="catalog-state-title">هنوز جایی را پوشش نمی‌دهیم</h2>
        <p>به‌زودی از بابل شروع می‌کنیم. همین صفحه اولین جایی است که خبرش را می‌دهد.</p>
      </section>
    )
  }

  if (storefront.state === 'unavailable') {
    return (
      <section className="catalog-state catalog-state--fault" aria-labelledby="catalog-state-title">
        <h2 id="catalog-state-title">فهرست نان‌ها در دسترس نیست</h2>
        {/*
          The API's own message, not a generic apology: it is the difference
          between "کمی بعد دوباره تلاش کنید" and a customer refreshing forever.
        */}
        <p>{storefront.message}</p>
        <RetryButton>تلاش دوباره</RetryButton>
      </section>
    )
  }

  if (storefront.catalog.total === 0) {
    return (
      <section className="catalog-state" aria-labelledby="catalog-state-title">
        <h2 id="catalog-state-title">امروز نانی برای {storefront.city.nameFa} ثبت نشده</h2>
        <p>نانوایی‌های این شهر هنوز عرضهٔ امروزشان را باز نکرده‌اند.</p>
      </section>
    )
  }

  return (
    <>
      <CategoryRail chips={storefront.catalog.chips} />
      {storefront.catalog.shelves.map((shelf) => (
        <Shelf key={shelf.id} shelf={shelf} />
      ))}
    </>
  )
}
