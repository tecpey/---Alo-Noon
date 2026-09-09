import { legalIdentity, missingLegalFields } from '../../lib/legal-identity'
import { toPersianDigits } from '../../lib/persian'

/**
 * How to reach the business, from the deployment's own configuration.
 *
 * When a value is unset the block says so and names the variable. That is
 * deliberate and it is not a developer convenience: a placeholder telephone
 * number on a legal page is a false statement about a real business, and an
 * eNamad reviewer who dials it reaches a stranger. An obviously unfinished page
 * is the safer failure.
 */
export function LegalContact() {
  const identity = legalIdentity()
  const missing = missingLegalFields(identity)

  return (
    <div className="legal__contact">
      <dl>
        {identity.legalNameFa && (
          <div>
            <dt>نام ثبت‌شده</dt>
            <dd>{identity.legalNameFa}</dd>
          </div>
        )}
        {identity.tradingNameFa && (
          <div>
            <dt>نام تجاری</dt>
            <dd>{identity.tradingNameFa}</dd>
          </div>
        )}
        {identity.nationalId && (
          <div>
            <dt>شناسهٔ ملی</dt>
            <dd dir="ltr">{toPersianDigits(identity.nationalId)}</dd>
          </div>
        )}
        {identity.registrationNumber && (
          <div>
            <dt>شمارهٔ ثبت</dt>
            <dd dir="ltr">{toPersianDigits(identity.registrationNumber)}</dd>
          </div>
        )}
        {identity.addressFa && (
          <div>
            <dt>نشانی</dt>
            <dd>{identity.addressFa}</dd>
          </div>
        )}
        {identity.postalCode && (
          <div>
            <dt>کد پستی</dt>
            <dd dir="ltr">{toPersianDigits(identity.postalCode)}</dd>
          </div>
        )}
        {identity.phone && (
          <div>
            <dt>تلفن</dt>
            <dd>
              {/* A telephone number is only useful if it dials. */}
              <a href={`tel:${identity.phone.replace(/[^\d+]/g, '')}`} dir="ltr">
                {toPersianDigits(identity.phone)}
              </a>
            </dd>
          </div>
        )}
        {identity.supportEmail && (
          <div>
            <dt>ایمیل</dt>
            <dd>
              <a href={`mailto:${identity.supportEmail}`} dir="ltr">
                {identity.supportEmail}
              </a>
            </dd>
          </div>
        )}
        {identity.supportHoursFa && (
          <div>
            <dt>ساعت پاسخگویی</dt>
            <dd>{identity.supportHoursFa}</dd>
          </div>
        )}
      </dl>

      {missing.length > 0 && (
        <p className="legal__missing" role="status">
          <strong>این بخش هنوز کامل نشده است.</strong> پیش از راه‌اندازی عمومی باید این متغیرهای
          محیطی روی سرور تنظیم شوند: <code dir="ltr">{missing.join('، ')}</code>. تا آن زمان اطلاعات
          هویتی نمایش داده نمی‌شود — نمایش یک نشانی یا تلفن ساختگی از خالی‌بودن این بخش بدتر است.
        </p>
      )}
    </div>
  )
}
