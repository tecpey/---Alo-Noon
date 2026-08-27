import type { Metadata } from 'next'
import Image from 'next/image'

import type { ProductDetail } from '@alo-noon/contracts'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import '../../storefront.css'
import './product.css'

import { BreadPlaceholderArt } from '../../components/brand-art'
import { BasketDrawer } from '../../components/basket-drawer'
import { CitySwitch } from '../../components/city-switch'
import { ProductBuy } from '../../components/product-buy'
import { RetryButton } from '../../components/retry-button'
import { SiteHeader } from '../../components/site-header'
import { StorefrontProvider } from '../../components/storefront-state'
import { ChevronIcon, ClockIcon, OvenIcon, ShieldIcon, WheatIcon } from '../../components/icons'
import { isFresh, productImage, toShelfProduct } from '../../../lib/catalog-view'
import { minutes } from '../../../lib/duration'
import { formatToman } from '../../../lib/persian'
import { loadProduct } from '../../../lib/storefront-data'

export const dynamic = 'force-dynamic'

/**
 * One bread's own page.
 *
 * Every card on the storefront has always linked here; until now every one of
 * those links was a 404, which is the worst kind of broken — the shop looked
 * finished and failed on the most ordinary thing a customer does.
 *
 * What the page owes a customer is what a card cannot fit: what is in the
 * bread, what it might do to them, how long it stays good, and how long it
 * takes to make. All of it comes from the catalog rather than being written
 * here, because an ingredient list a page invents is a lie with consequences.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const data = await loadProduct(slug)
  if (data.state !== 'ready') return { title: 'محصول | الو نون' }
  return {
    title: `${data.product.nameFa} | الو نون`,
    ...(data.product.descriptionFa && { description: data.product.descriptionFa }),
  }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadProduct(slug)

  // A bread nobody here sells is genuinely not a page. Rendering our own
  // "not found" body with a 200 would tell a search engine this URL is real.
  if (data.state === 'missing') notFound()

  return (
    <StorefrontProvider products={data.state === 'ready' ? [toShelfProduct(data.product)] : []}>
      <div className="app-frame">
        <SiteHeader />
        <main className="product-page">
          {data.state === 'ready' ? (
            <Detail product={data.product} cityNameFa={data.city.nameFa} />
          ) : (
            <Unavailable data={data} />
          )}
        </main>
        <BasketDrawer />
      </div>
    </StorefrontProvider>
  )
}

function Detail({ product, cityNameFa }: { product: ProductDetail; cityNameFa: string }) {
  const image = productImage(product)
  const fresh = isFresh(product)

  return (
    <>
      <nav className="crumbs" aria-label="مسیر">
        <Link href="/">فروشگاه</Link>
        <ChevronIcon width={16} height={16} aria-hidden="true" />
        <span>{product.categoryNameFa}</span>
      </nav>

      <article className="product">
        <div className="product__art">
          {image ? (
            <Image src={image} alt="" width={900} height={640} priority />
          ) : (
            <span className="product__placeholder">
              <BreadPlaceholderArt />
            </span>
          )}
          {fresh && <span className="product__badge">تازه از تنور</span>}
        </div>

        <div className="product__body">
          <p className="product__category">{product.categoryNameFa}</p>
          <h1>{product.nameFa}</h1>
          {product.descriptionFa && <p className="product__lead">{product.descriptionFa}</p>}

          <p className="product__price">{formatToman(product.price.amount)}</p>

          <ProductBuy offeringId={product.offeringId} nameFa={product.nameFa} />

          {/*
            Three facts, and each one is only shown when the catalog actually
            holds it. A "۹۰ دقیقه" printed under a bread whose freshness window
            nobody set would be a number this page made up.
          */}
          <ul className="product__facts">
            <li>
              <OvenIcon duotone width={20} height={20} />
              <div>
                <p className="product__fact-title">{fresh ? 'پخت سفارشی' : 'بسته‌بندی‌شده'}</p>
                <p className="product__fact-body">
                  {fresh ? 'پس از ثبت سفارش پخته می‌شود.' : 'در بسته‌بندی بهداشتی و آمادهٔ ارسال.'}
                </p>
              </div>
            </li>
            {product.freshnessWindowMinutes !== undefined && (
              <li>
                <ClockIcon duotone width={20} height={20} />
                <div>
                  <p className="product__fact-title">
                    تازگی تا {minutes(product.freshnessWindowMinutes)}
                  </p>
                  <p className="product__fact-body">بهترین زمان مصرف پس از تحویل.</p>
                </div>
              </li>
            )}
            {product.packaging && (
              <li>
                <ShieldIcon duotone width={20} height={20} />
                <div>
                  <p className="product__fact-title">
                    ماندگاری {minutes(product.packaging.shelfLifeMinutes)}
                  </p>
                  <p className="product__fact-body">در بسته‌بندی بازنشده.</p>
                </div>
              </li>
            )}
            <li>
              <WheatIcon duotone width={20} height={20} />
              <div>
                <p className="product__fact-title">تحویل در {cityNameFa}</p>
                <p className="product__fact-body">
                  کرایه در مرحلهٔ پرداخت و بر اساس مسیر واقعی محاسبه می‌شود.
                </p>
              </div>
            </li>
          </ul>

          {product.ingredients.length > 0 && (
            <section className="product__section" aria-labelledby="ingredients-title">
              <h2 id="ingredients-title">مواد تشکیل‌دهنده</h2>
              <ul className="tag-list">
                {product.ingredients.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {/*
            Allergens are marked as a warning, not as another tag row. Someone
            reading this list may be reading it because getting it wrong sends
            them to hospital.
          */}
          {product.allergens.length > 0 && (
            <section className="product__section" aria-labelledby="allergens-title">
              <h2 id="allergens-title">هشدار حساسیت</h2>
              <ul className="tag-list tag-list--warning">
                {product.allergens.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {product.dietaryAttributes.length > 0 && (
            <section className="product__section" aria-labelledby="dietary-title">
              <h2 id="dietary-title">ویژگی‌های غذایی</h2>
              <ul className="tag-list">
                {product.dietaryAttributes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </article>
    </>
  )
}

function Unavailable({
  data,
}: {
  data: Exclude<Awaited<ReturnType<typeof loadProduct>>, { state: 'ready' | 'missing' }>
}) {
  if (data.state === 'choose-city') {
    return (
      <section className="catalog-state" aria-labelledby="product-state-title">
        <h2 id="product-state-title">شهرتان را انتخاب کنید</h2>
        <p>قیمت و موجودی هر نان برای هر شهر جداگانه تعیین می‌شود.</p>
        <CitySwitch cities={data.cities} />
      </section>
    )
  }

  if (data.state === 'closed') {
    return (
      <section className="catalog-state" aria-labelledby="product-state-title">
        <h2 id="product-state-title">هنوز جایی را پوشش نمی‌دهیم</h2>
        <p>به‌زودی از بابل شروع می‌کنیم.</p>
      </section>
    )
  }

  return (
    <section className="catalog-state catalog-state--fault" aria-labelledby="product-state-title">
      <h2 id="product-state-title">این صفحه در دسترس نیست</h2>
      <p>{data.message}</p>
      <RetryButton>تلاش دوباره</RetryButton>
    </section>
  )
}
