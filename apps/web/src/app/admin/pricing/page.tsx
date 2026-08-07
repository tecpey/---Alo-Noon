import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  createOfferingAction,
  repriceOfferingAction,
  setOfferingAvailabilityAction,
  setOfferingStockAction,
} from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listCatalogBranches,
  listCatalogOfferings,
  listCatalogProducts,
  type AdminBranch,
  type AdminOffering,
  type AdminProduct,
} from '../../../lib/admin-api'
import {
  BRANCH_STATUS_LABELS,
  formatCount,
  formatMoney,
  label,
  OFFERING_AVAILABILITY_LABELS,
  PRODUCT_LIFECYCLE_LABELS,
} from '../../../lib/admin-format-display'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20
const AVAILABILITIES = Object.keys(OFFERING_AVAILABILITY_LABELS)

function one(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value
  return single && single.trim() ? single.trim() : undefined
}

export default async function AdminPricingPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const page = Math.max(1, Number(one(params['page']) ?? '1') || 1)
  const branchId = one(params['bakeryBranchId'])
  const availability = one(params['availability'])

  const query: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) }
  if (branchId && /^[0-9a-fA-F-]{36}$/.test(branchId)) query['bakeryBranchId'] = branchId
  if (availability && AVAILABILITIES.includes(availability)) query['availability'] = availability

  const [offerings, branches, products] = await Promise.all([
    listCatalogOfferings(query),
    listCatalogBranches(),
    // Only the first page of products: the create form needs something to pick
    // from, not the whole catalogue. An operator with more variants than this
    // filters the list on the catalogue page and comes back with the SKU.
    listCatalogProducts({ page: '1', pageSize: '100' }),
  ])
  if (
    (!offerings.ok && isUnauthenticated(offerings.error)) ||
    (!branches.ok && isUnauthenticated(branches.error))
  ) {
    redirect('/admin/login')
  }

  const branchList: AdminBranch[] = branches.ok ? branches.data : []
  const activeVariants = (products.ok ? products.data : []).flatMap(variantOptions)

  return (
    <main className="admin">
      <AdminNav
        active="/admin/pricing"
        title="قیمت‌گذاری"
        subtitle="قیمت و وضعیت فروش هر گونه در هر شعبه"
      />

      <aside className="note">
        تغییر قیمت روی سفارش‌های ثبت‌شده اثری ندارد؛ هر سفارش قیمت لحظهٔ خودش را نگه می‌دارد. قیمت
        قبلی هم در سابقهٔ ممیزی ثبت می‌شود تا ماه‌ها بعد بتوان یک مبلغ را توضیح داد. برای ساخت محصول
        و گونه به <Link href="/admin/catalog">کاتالوگ</Link> بروید.
      </aside>

      <form className="filters" method="get">
        <label className="field">
          <span>شعبه</span>
          <select name="bakeryBranchId" defaultValue={query['bakeryBranchId'] ?? ''}>
            <option value="">همه</option>
            {branchList.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.nameFa} — {branch.bakeryNameFa}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>وضعیت فروش</span>
          <select name="availability" defaultValue={query['availability'] ?? ''}>
            <option value="">همه</option>
            {AVAILABILITIES.map((code) => (
              <option key={code} value={code}>
                {label(OFFERING_AVAILABILITY_LABELS, code)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">اعمال</button>
      </form>

      {offerings.ok ? (
        <>
          {offerings.data.length === 0 ? (
            <p className="muted">عرضه‌ای با این شرایط پیدا نشد.</p>
          ) : (
            <ul className="rows">
              {offerings.data.map((offering) => (
                <OfferingRow key={offering.id} offering={offering} />
              ))}
            </ul>
          )}

          {offerings.pagination && (
            <nav className="pager" aria-label="صفحه‌بندی">
              <span className="muted">
                {formatCount(offerings.pagination.totalItems)} عرضه، صفحهٔ{' '}
                {formatCount(offerings.pagination.page)} از{' '}
                {formatCount(Math.max(1, offerings.pagination.totalPages))}
              </span>
              <span>
                {offerings.pagination.hasPreviousPage && (
                  <Link href={pageHref(query, page - 1)}>قبلی</Link>
                )}
                {offerings.pagination.hasNextPage && (
                  <Link href={pageHref(query, page + 1)}>بعدی</Link>
                )}
              </span>
            </nav>
          )}
        </>
      ) : (
        <p className="error-box">{readFailureMessage(offerings.error.code)}</p>
      )}

      <section>
        <h2>عرضهٔ تازه</h2>
        <details className="card">
          <summary>افزودن گونه به یک شعبه</summary>
          <p className="muted">
            هر گونه در هر شعبه فقط یک قیمت دارد. عرضهٔ تازه پیش‌نویس ساخته می‌شود و تا انتشار به
            مشتری نشان داده نمی‌شود؛ انتشار هم تا وقتی محصول و گونه فعال نشده باشند رد می‌شود.
          </p>
          <ActionForm action={createOfferingAction} submitLabel="ثبت عرضه">
            <SelectField
              label="شعبه"
              name="bakeryBranchId"
              options={branchList.map((branch) => ({
                value: branch.id,
                label: `${branch.nameFa} — ${label(BRANCH_STATUS_LABELS, branch.operationalStatus)}`,
              }))}
              {...(branchList.length === 0 && { hint: 'هنوز شعبه‌ای ثبت نشده است.' })}
            />
            <SelectField
              label="گونه"
              name="productVariantId"
              options={activeVariants}
              {...(activeVariants.length === 0 && { hint: 'اول در کاتالوگ یک گونه بسازید.' })}
            />
            <Field
              label="قیمت (ریال)"
              name="price"
              required
              dir="ltr"
              inputMode="numeric"
              placeholder="250000"
              hint="عدد کامل به ریال. جداکنندهٔ هزارگان و ارقام فارسی هم پذیرفته می‌شود."
            />
            <Field
              label="ظرفیت روزانه"
              name="dailyCapacity"
              dir="ltr"
              inputMode="numeric"
              placeholder="40"
              hint="اختیاری. برای نان تازه‌پخت، سقف سفارش روزانهٔ این شعبه."
            />
            <Field
              label="زمان آماده‌سازی (دقیقه)"
              name="preparationMinutes"
              dir="ltr"
              inputMode="numeric"
              placeholder="25"
            />
            <Field
              label="موجودی اولیه"
              name="stockOnHand"
              dir="ltr"
              inputMode="numeric"
              placeholder="خالی بگذارید"
              hint="فقط برای کالای بسته‌بندی‌شده. خالی یعنی شمارش موجودی خاموش است."
            />
            <Field label="دلیل" name="reason" placeholder="قیمت‌گذاری اولیه" />
          </ActionForm>
        </details>
      </section>
    </main>
  )
}

function variantOptions(product: AdminProduct): Array<{ value: string; label: string }> {
  return product.variants.map((variant) => ({
    value: variant.id,
    // The lifecycle is on the label because offering a draft variant is allowed
    // but publishing it is not, and the operator should see that before they
    // find out at the publish step.
    label: `${product.nameFa} / ${variant.nameFa} (${variant.sku}) — ${label(
      PRODUCT_LIFECYCLE_LABELS,
      variant.lifecycle,
    )}`,
  }))
}

function OfferingRow({ offering }: Readonly<{ offering: AdminOffering }>) {
  const sellable = offering.availability === 'AVAILABLE' || offering.availability === 'SOLD_OUT'
  return (
    <li className="row">
      <div className="row-head">
        <strong>
          {offering.productNameFa} / {offering.variantNameFa}
        </strong>
        <span className="badge">{label(OFFERING_AVAILABILITY_LABELS, offering.availability)}</span>
      </div>
      <dl className="row-meta">
        <div>
          <dt>شعبه</dt>
          <dd>{offering.branchNameFa}</dd>
        </div>
        <div>
          <dt>SKU</dt>
          <dd dir="ltr">{offering.sku}</dd>
        </div>
        <div>
          <dt>قیمت</dt>
          <dd>{formatMoney(offering.price)}</dd>
        </div>
        <div>
          <dt>موجودی</dt>
          <dd>
            {offering.stockTracked ? formatCount(offering.stockOnHand ?? 0) : 'شمارش نمی‌شود'}
          </dd>
        </div>
        <div>
          <dt>وضعیت گونه</dt>
          <dd>{label(PRODUCT_LIFECYCLE_LABELS, offering.variantLifecycle)}</dd>
        </div>
      </dl>

      {offering.availability === 'RETIRED' ? (
        <p className="muted">این عرضه بازنشسته است و تغییر نمی‌کند.</p>
      ) : (
        <div className="row-actions">
          <ActionForm action={repriceOfferingAction} submitLabel="ثبت قیمت">
            <input type="hidden" name="offeringId" value={offering.id} />
            <Field
              label="قیمت تازه (ریال)"
              name="price"
              required
              dir="ltr"
              inputMode="numeric"
              defaultValue={offering.price.amount}
            />
            <Field label="دلیل" name="reason" placeholder="افزایش قیمت آرد" />
          </ActionForm>

          <ActionForm action={setOfferingAvailabilityAction} submitLabel="ثبت وضعیت">
            <input type="hidden" name="offeringId" value={offering.id} />
            <SelectField
              label="وضعیت فروش"
              name="availability"
              defaultValue={offering.availability}
              options={AVAILABILITIES.filter((code) => code !== 'RETIRED').map((code) => ({
                value: code,
                label: label(OFFERING_AVAILABILITY_LABELS, code),
              }))}
              hint={
                sellable
                  ? 'برای خروج از فروش، «متوقف» را انتخاب کنید.'
                  : 'انتشار تا وقتی محصول و گونه فعال نشده باشند رد می‌شود.'
              }
            />
            <Field label="دلیل" name="reason" placeholder="آمادهٔ فروش" />
          </ActionForm>

          <ActionForm action={setOfferingStockAction} submitLabel="ثبت موجودی">
            <input type="hidden" name="offeringId" value={offering.id} />
            <SelectField
              label="شمارش موجودی"
              name="stockTracked"
              defaultValue={String(offering.stockTracked)}
              options={[
                { value: 'false', label: 'خاموش' },
                { value: 'true', label: 'روشن' },
              ]}
            />
            <Field
              label="تعداد موجود"
              name="stockOnHand"
              dir="ltr"
              inputMode="numeric"
              defaultValue={offering.stockOnHand === null ? '' : String(offering.stockOnHand)}
              hint="وقتی شمارش روشن است لازم است."
            />
            <Field label="دلیل" name="reason" placeholder="شمارش پایان روز" />
          </ActionForm>
        </div>
      )}
    </li>
  )
}

function pageHref(query: Record<string, string>, page: number): string {
  const next = new URLSearchParams(query)
  next.set('page', String(page))
  next.delete('pageSize')
  return `/admin/pricing?${next.toString()}`
}
