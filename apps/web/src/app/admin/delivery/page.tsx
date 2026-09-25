import { redirect } from 'next/navigation'

import { rialToToman } from '@alo-noon/domain'

import {
  publishDeliveryTariffAction,
  setAreaMotorcycleAction,
  setCityThresholdsAction,
} from '../../../lib/admin-actions'
import { isUnauthenticated, listDeliveryCities, listDeliveryTariffs } from '../../../lib/admin-api'
import type { AdminDeliveryCity, AdminDeliveryTariff } from '@alo-noon/contracts'
import { formatCount, formatMoney } from '../../../lib/admin-format-display'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'
import { TableScroll } from '../../components/table-scroll'

export const dynamic = 'force-dynamic'

const VEHICLES: Record<AdminDeliveryTariff['vehicleProfile'], string> = {
  MOTORCYCLE: 'موتور',
  CAR: 'خودرو',
}
const MODES: Record<AdminDeliveryTariff['calculationMode'], string> = {
  FLAT: 'ثابت',
  DISTANCE_BANDED: 'بر اساس مسافت',
}

/**
 * A Rial amount as the Toman money the formatter takes.
 *
 * `rialToToman` refuses an amount that does not divide into whole Toman rather
 * than rounding it — the right call for money — so this catches that refusal.
 * Without it one malformed row would throw while rendering and take the whole
 * tariff table with it, which is a worse way to learn about a bad row than a
 * dash in one cell.
 */
function toman(amountRial: string | null): { amount: string; currency: string } | undefined {
  if (!amountRial) return undefined
  try {
    return { amount: rialToToman(BigInt(amountRial)), currency: 'IRR' }
  } catch {
    return undefined
  }
}

/**
 * Delivery tariffs, city thresholds, and which areas take motorcycles.
 *
 * All three decided real money and real refusals before any of them had a
 * screen: until a car tariff is published, the first order from a factory or a
 * village is refused with a message the customer cannot act on. The page leads
 * with that state rather than burying it, because a city missing its car rate
 * is not a settings detail — it is an outage confined to the most valuable
 * orders the shop takes.
 */
export default async function AdminDeliveryPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = (await searchParams) ?? {}
  const rawCity = Array.isArray(params['cityId']) ? params['cityId'][0] : params['cityId']
  const cityFilter = rawCity && rawCity.trim() ? rawCity.trim() : undefined

  const [cities, tariffs] = await Promise.all([
    listDeliveryCities(),
    listDeliveryTariffs(cityFilter),
  ])
  if (
    (!cities.ok && isUnauthenticated(cities.error)) ||
    (!tariffs.ok && isUnauthenticated(tariffs.error))
  ) {
    redirect('/admin/login')
  }

  const cityList: AdminDeliveryCity[] = cities.ok ? cities.data : []
  const tariffList: AdminDeliveryTariff[] = tariffs.ok ? tariffs.data : []
  const carless = cityList.filter((city) => !city.hasActiveCarTariff)

  return (
    <main className="admin">
      <AdminNav
        active="/admin/delivery"
        title="کرایه و محدودهٔ ارسال"
        subtitle="تعرفهٔ هر وسیله، محدودهٔ موتور در هر شهر، و مناطقی که موتور به آن‌ها نمی‌رود"
      />

      {!cities.ok && <p className="error-box">{readFailureMessage(cities.error.code)}</p>}

      {/*
        The first thing on the page, when it applies. A city with no active car
        tariff refuses every order that needs a car — every factory, every
        school ordering by the hundred, every village — and does it with a
        message the customer can do nothing about. That is not a settings gap to
        find by scrolling.
      */}
      {carless.length > 0 && (
        <section className="card card--warning">
          <h2>این شهرها هنوز تعرفهٔ خودرو ندارند</h2>
          <p>
            سفارشی که به خودرو نیاز دارد — سفارش‌های پرتعداد، شهرک‌های صنعتی، روستاها و شهرهای اطراف
            — در این شهرها <strong>رد می‌شود</strong>. تا وقتی تعرفهٔ خودرو ثبت نشده، آن سفارش‌ها
            قابل ثبت نیستند.
          </p>
          <ul className="rows rows--chips">
            {carless.map((city) => (
              <li key={city.id}>{city.nameFa}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>تعرفه‌های فعلی</h2>
        {tariffList.length === 0 ? (
          <p className="muted">هنوز هیچ تعرفه‌ای ثبت نشده است.</p>
        ) : (
          <TableScroll label="تعرفه‌های فعلی">
            <table>
              <thead>
                <tr>
                  <th>شهر</th>
                  <th>منطقه</th>
                  <th>وسیله</th>
                  <th>نوع</th>
                  <th>کرایهٔ پایه</th>
                  <th>هر کیلومتر</th>
                  <th>حداقل سفارش</th>
                  <th>ارسال رایگان از</th>
                  <th>نسخه</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {tariffList.map((tariff) => (
                  <tr key={tariff.id} className={tariff.isActive ? undefined : 'is-retired'}>
                    <td>{tariff.cityNameFa}</td>
                    <td>{tariff.operationalZoneNameFa ?? 'کل شهر'}</td>
                    <td>{VEHICLES[tariff.vehicleProfile]}</td>
                    <td>{MODES[tariff.calculationMode]}</td>
                    <td>{formatMoney(toman(tariff.baseFeeAmount))}</td>
                    <td>
                      {tariff.calculationMode === 'DISTANCE_BANDED'
                        ? formatMoney(toman(tariff.perKilometerFeeAmount))
                        : '—'}
                    </td>
                    <td>{formatMoney(toman(tariff.minimumOrderAmount))}</td>
                    <td>{formatMoney(toman(tariff.freeDeliveryThreshold))}</td>
                    <td>{formatCount(tariff.version)}</td>
                    <td>{tariff.isActive ? 'فعال' : 'بازنشسته'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section className="card">
        <h2>انتشار تعرفهٔ تازه</h2>
        <p className="note">
          تعرفهٔ تازه بلافاصله فعال می‌شود و نسخهٔ قبلیِ همان شهر، همان منطقه و همان وسیله در همان
          لحظه بازنشسته می‌شود. سفارش‌هایی که قبلاً قیمت گرفته‌اند تغییر نمی‌کنند.
        </p>
        <ActionForm action={publishDeliveryTariffAction} submitLabel="انتشار تعرفه">
          <SelectField
            name="cityId"
            label="شهر"
            options={cityList.map((city) => ({ value: city.id, label: city.nameFa }))}
          />
          <Field name="operationalZoneId" label="شناسهٔ منطقه (خالی = کل شهر)" />
          <SelectField
            name="vehicleProfile"
            label="وسیله"
            options={[
              { value: 'CAR', label: 'خودرو' },
              { value: 'MOTORCYCLE', label: 'موتور' },
            ]}
          />
          <SelectField
            name="calculationMode"
            label="نوع محاسبه"
            options={[
              { value: 'DISTANCE_BANDED', label: 'بر اساس مسافت' },
              { value: 'FLAT', label: 'ثابت' },
            ]}
          />
          <Field name="baseFeeAmount" label="کرایهٔ پایه (تومان)" required />
          <Field name="perKilometerFeeAmount" label="کرایهٔ هر کیلومتر (تومان)" />
          <Field name="minimumOrderAmount" label="حداقل مبلغ سفارش (تومان، اختیاری)" />
          <Field name="freeDeliveryThreshold" label="ارسال رایگان از (تومان، اختیاری)" />
        </ActionForm>
      </section>

      {cityList.map((city) => (
        <section className="card" key={city.id}>
          <h2>{city.nameFa}</h2>
          <p className="note">
            سفارشی که از این حدها بگذرد، خودرو لازم دارد. خالی گذاشتن هر کدام یعنی «اندازه‌گیری
            نشده» و مقدار پیش‌فرض استفاده می‌شود — که الان {formatCount(city.effectiveItemLimit)}{' '}
            قلم و {formatCount(Math.round(city.effectiveRangeMetres / 100) / 10)} کیلومتر است.
          </p>
          <ActionForm action={setCityThresholdsAction} submitLabel="ثبت محدودهٔ شهر">
            <input type="hidden" name="cityId" value={city.id} />
            <Field
              name="motorcycleItemLimit"
              label="بیشترین تعداد قلم روی موتور"
              defaultValue={city.motorcycleItemLimit ? String(city.motorcycleItemLimit) : ''}
            />
            <Field
              name="motorcycleRangeKm"
              label="بیشترین فاصلهٔ موتور (کیلومتر)"
              defaultValue={
                city.motorcycleRangeMetres ? String(city.motorcycleRangeMetres / 1_000) : ''
              }
            />
          </ActionForm>

          {city.areas.length > 0 && (
            <>
              <h3>مناطق</h3>
              <p className="note">
                منطقه‌ای که موتور به آن نمی‌رود را غیرفعال کنید. این مستقل از فاصله است: روستایی در
                هشت کیلومتری، آن‌طرف رودخانه، داخل محدوده است و باز جای فرستادن موتور نیست.
              </p>
              <ul className="rows">
                {city.areas.map((area) => (
                  <li key={area.id}>
                    <span>
                      <strong>{area.nameFa}</strong>
                      <span className="muted">{area.operationalZoneNameFa}</span>
                    </span>
                    <span className={area.motorcycleAllowed ? 'is-on' : 'is-off'}>
                      {area.motorcycleAllowed ? 'موتور فعال' : 'فقط خودرو'}
                    </span>
                    <ActionForm
                      action={setAreaMotorcycleAction}
                      submitLabel={
                        area.motorcycleAllowed ? 'غیرفعال کردن موتور' : 'فعال کردن موتور'
                      }
                    >
                      <input type="hidden" name="areaId" value={area.id} />
                      <input
                        type="hidden"
                        name="motorcycleAllowed"
                        value={area.motorcycleAllowed ? 'false' : 'true'}
                      />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </main>
  )
}
