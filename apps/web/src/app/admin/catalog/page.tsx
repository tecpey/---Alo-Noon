import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  createCatalogCategoryAction,
  createProductAction,
  createVariantAction,
  setProductLifecycleAction,
  setVariantLifecycleAction,
} from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listCatalogCategories,
  listCatalogProducts,
  type AdminProduct,
  type CatalogCategory,
} from '../../../lib/admin-api'
import {
  formatCount,
  FULFILLMENT_CLASS_LABELS,
  label,
  PRODUCT_LIFECYCLE_LABELS,
} from '../../../lib/admin-format-display'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

// The catalogue changes by operator action and is read back immediately after
// each change, so nothing here may be served from a build-time render.
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20

const LIFECYCLES = Object.keys(PRODUCT_LIFECYCLE_LABELS)

function one(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value
  return single && single.trim() ? single.trim() : undefined
}

export default async function AdminCatalogPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const page = Math.max(1, Number(one(params['page']) ?? '1') || 1)
  const lifecycle = one(params['lifecycle'])
  const search = one(params['search'])

  const query: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) }
  // Only echo back a lifecycle the API would accept, so a hand-edited URL turns
  // into an unfiltered list rather than a 400 the operator cannot read.
  if (lifecycle && LIFECYCLES.includes(lifecycle)) query['lifecycle'] = lifecycle
  if (search && search.length >= 2) query['search'] = search

  const [products, categories] = await Promise.all([
    listCatalogProducts(query),
    listCatalogCategories(),
  ])
  if (
    (!products.ok && isUnauthenticated(products.error)) ||
    (!categories.ok && isUnauthenticated(categories.error))
  ) {
    redirect('/admin/login')
  }

  const categoryList: CatalogCategory[] = categories.ok ? categories.data : []
  const productList: AdminProduct[] = products.ok ? products.data : []

  return (
    <main className="admin">
      <AdminNav
        active="/admin/catalog"
        title="کاتالوگ"
        subtitle="محصول‌ها، گونه‌ها و وضعیت انتشارشان"
      />

      <aside className="note">
        این صفحه می‌گوید <em>نان چیست</em>. قیمت هر شعبه در{' '}
        <Link href="/admin/pricing">قیمت‌گذاری</Link> تعیین می‌شود. هر محصول و گونه‌ای که می‌سازید
        پیش‌نویس است و تا فعال نشود، هیچ شعبه‌ای نمی‌تواند آن را بفروشد.
      </aside>

      <form className="filters" method="get">
        <label className="field">
          <span>وضعیت</span>
          <select name="lifecycle" defaultValue={query['lifecycle'] ?? ''}>
            <option value="">همه</option>
            {LIFECYCLES.map((code) => (
              <option key={code} value={code}>
                {label(PRODUCT_LIFECYCLE_LABELS, code)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>جست‌وجو</span>
          <input name="search" defaultValue={query['search'] ?? ''} placeholder="نام یا slug" />
        </label>
        <button type="submit">اعمال</button>
      </form>

      {products.ok ? (
        <>
          {productList.length === 0 ? (
            <p className="muted">محصولی با این شرایط پیدا نشد.</p>
          ) : (
            <ul className="rows">
              {productList.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </ul>
          )}

          {products.pagination && (
            <nav className="pager" aria-label="صفحه‌بندی">
              <span className="muted">
                {formatCount(products.pagination.totalItems)} محصول، صفحهٔ{' '}
                {formatCount(products.pagination.page)} از{' '}
                {formatCount(Math.max(1, products.pagination.totalPages))}
              </span>
              <span>
                {products.pagination.hasPreviousPage && (
                  <Link href={pageHref(query, page - 1)}>قبلی</Link>
                )}
                {products.pagination.hasNextPage && (
                  <Link href={pageHref(query, page + 1)}>بعدی</Link>
                )}
              </span>
            </nav>
          )}
        </>
      ) : (
        <p className="error-box">{readFailureMessage(products.error.code)}</p>
      )}

      <section>
        <h2>افزودن</h2>

        <details className="card">
          <summary>محصول جدید</summary>
          <p className="muted">
            محصول در وضعیت پیش‌نویس ساخته می‌شود. نشانی (slug) در نشانی اینترنتی محصول ظاهر می‌شود و
            بعداً تغییر نمی‌کند، پس آن را ساده و پایدار انتخاب کنید.
          </p>
          <ActionForm action={createProductAction} submitLabel="ساخت محصول">
            <SelectField
              label="دسته"
              name="categoryId"
              options={categoryList.map((category) => ({
                value: category.id,
                label: `${category.nameFa} (${category.code})`,
              }))}
              {...(categoryList.length === 0 && { hint: 'اول یک دسته بسازید.' })}
            />
            <Field label="نام فارسی" name="nameFa" required placeholder="نان بربری" />
            <Field
              label="نشانی (slug)"
              name="slug"
              required
              dir="ltr"
              placeholder="nan-barbari"
              hint="فقط حروف کوچک انگلیسی، عدد و خط تیره."
            />
            <Field label="توضیح" name="descriptionFa" placeholder="توضیح کوتاه برای مشتری" />
          </ActionForm>
        </details>

        <details className="card">
          <summary>گونهٔ جدید</summary>
          <p className="muted">
            گونه همان چیزی است که مشتری سفارش می‌دهد. طبقه‌بندی پس از ساخت قابل تغییر نیست، چون
            زمان‌بندی تولید و تحویل بر پایهٔ آن انجام می‌شود.
          </p>
          <ActionForm action={createVariantAction} submitLabel="ساخت گونه">
            <SelectField
              label="محصول"
              name="productId"
              options={productList.map((product) => ({
                value: product.id,
                label: `${product.nameFa} — ${label(PRODUCT_LIFECYCLE_LABELS, product.lifecycle)}`,
              }))}
              {...(productList.length === 0 && { hint: 'اول یک محصول بسازید.' })}
            />
            <Field label="نام فارسی" name="nameFa" required placeholder="بربری ساده" />
            <Field
              label="SKU"
              name="sku"
              required
              dir="ltr"
              placeholder="BARBARI-PLAIN"
              hint="فقط حروف بزرگ انگلیسی، عدد و خط تیره. یکتا در کل سامانه."
            />
            <SelectField
              label="طبقه‌بندی"
              name="fulfillmentClass"
              options={Object.keys(FULFILLMENT_CLASS_LABELS).map((code) => ({
                value: code,
                label: label(FULFILLMENT_CLASS_LABELS, code),
              }))}
              hint="«تازه‌پخت» یعنی سفارشی و با پنجرهٔ تازگی؛ بقیه بسته‌بندی‌شده با تاریخ انقضا."
            />
            <Field
              label="مواد اولیه"
              name="ingredients"
              placeholder="آرد، آب، نمک"
              hint="با ویرگول جدا کنید."
            />
            <Field label="آلرژن‌ها" name="allergens" placeholder="گلوتن" />
          </ActionForm>
        </details>

        <details className="card">
          <summary>دستهٔ جدید</summary>
          <ActionForm action={createCatalogCategoryAction} submitLabel="ساخت دسته">
            <Field
              label="کد"
              name="code"
              required
              dir="ltr"
              placeholder="TRADITIONAL"
              hint="حروف بزرگ انگلیسی و زیرخط."
            />
            <Field label="نام فارسی" name="nameFa" required placeholder="نان سنتی" />
          </ActionForm>
        </details>
      </section>
    </main>
  )
}

function ProductRow({ product }: Readonly<{ product: AdminProduct }>) {
  return (
    <li className="row">
      <div className="row-head">
        <strong>{product.nameFa}</strong>
        <span className="badge">{label(PRODUCT_LIFECYCLE_LABELS, product.lifecycle)}</span>
      </div>
      <dl className="row-meta">
        <div>
          <dt>دسته</dt>
          <dd>{product.categoryNameFa}</dd>
        </div>
        <div>
          <dt>نشانی</dt>
          <dd dir="ltr">{product.slug}</dd>
        </div>
        <div>
          <dt>گونه‌ها</dt>
          <dd>{formatCount(product.variants.length)}</dd>
        </div>
      </dl>

      {product.variants.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>نام</th>
                <th>طبقه‌بندی</th>
                <th>وضعیت</th>
                <th>عرضه</th>
                <th>تغییر وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant) => (
                <tr key={variant.id}>
                  <td dir="ltr">{variant.sku}</td>
                  <td>{variant.nameFa}</td>
                  <td>{label(FULFILLMENT_CLASS_LABELS, variant.fulfillmentClass)}</td>
                  <td>{label(PRODUCT_LIFECYCLE_LABELS, variant.lifecycle)}</td>
                  <td>{formatCount(variant.offeringCount)}</td>
                  <td>
                    <LifecycleControl
                      action={setVariantLifecycleAction}
                      idName="variantId"
                      id={variant.id}
                      current={variant.lifecycle}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row-actions">
        <LifecycleControl
          action={setProductLifecycleAction}
          idName="productId"
          id={product.id}
          current={product.lifecycle}
        />
      </div>
    </li>
  )
}

/**
 * Offers only the transitions the API will accept from where the row is now.
 *
 * RETIRED is terminal and is offered plainly rather than hidden — an operator
 * needs to be able to withdraw something — but a retired row offers nothing,
 * because there is no way back and a disabled control says so more honestly
 * than a refusal after the click.
 */
function LifecycleControl({
  action,
  idName,
  id,
  current,
}: Readonly<{
  action: Parameters<typeof ActionForm>[0]['action']
  idName: 'productId' | 'variantId'
  id: string
  current: string
}>) {
  const NEXT: Readonly<Record<string, readonly string[]>> = {
    DRAFT: ['ACTIVE', 'RETIRED'],
    ACTIVE: ['SUSPENDED', 'RETIRED'],
    SUSPENDED: ['ACTIVE', 'RETIRED'],
    RETIRED: [],
  }
  const options = NEXT[current] ?? []
  if (options.length === 0) return <span className="muted">بازنشسته — بازگشت‌ناپذیر</span>

  return (
    <ActionForm action={action} submitLabel="ثبت">
      <input type="hidden" name={idName} value={id} />
      <SelectField
        label="وضعیت تازه"
        name="lifecycle"
        options={options.map((code) => ({
          value: code,
          label: label(PRODUCT_LIFECYCLE_LABELS, code),
        }))}
      />
      <Field label="دلیل" name="reason" placeholder="چرا این تغییر؟" />
    </ActionForm>
  )
}

function pageHref(query: Record<string, string>, page: number): string {
  const next = new URLSearchParams(query)
  next.set('page', String(page))
  next.delete('pageSize')
  return `/admin/catalog?${next.toString()}`
}
