import type { Metadata } from 'next'

import { enamadSeal } from '../../../lib/legal-identity'
import { LegalContact } from '../legal-contact'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'تماس با ما | الو نون',
  description: 'هویت ثبت‌شده، نشانی، تلفن و راه‌های تماس با الو نون.',
}

/**
 * Who to call, and who we are.
 *
 * The page an eNamad reviewer opens first, and the one a customer looks for
 * when something has gone wrong and they want a person rather than a form.
 *
 * The trust seal renders only when both halves of its code are configured. A
 * seal drawn from a guessed value would be a claim that a regulator verified
 * this business when it has not — a forgery, not a placeholder — so a
 * half-configured deployment shows a note about the seal being pending instead.
 */
export default function ContactPage() {
  const seal = enamadSeal()

  return (
    <article className="legal__article">
      <h1>تماس با ما</h1>

      <section>
        <h2>هویت کسب‌وکار</h2>
        <LegalContact />
      </section>

      <section>
        <h2>پشتیبانی</h2>
        <p>
          برای هر چیزی که به سفارش، پرداخت یا کیف پول مربوط است، تلفن بالا سریع‌ترین راه است. اگر
          موضوع فوری نیست، ایمیل بزنید؛ در روزهای کاری پاسخ می‌دهیم.
        </p>
        <p>
          پیش از تماس، شمارهٔ سفارش را آماده داشته باشید — با آن می‌توانیم دقیقاً بگوییم چه اتفاقی
          افتاده است.
        </p>
      </section>

      <section>
        <h2>نمادها</h2>
        {seal ? (
          <a
            href={seal.href}
            target="_blank"
            rel="noopener noreferrer"
            // The registrar requires the referrer so the seal can verify which
            // site it was clicked from; `noreferrer` would break the check.
            referrerPolicy="origin"
            className="legal__seal"
          >
            {/* A plain <img>, not next/image: the badge is served by the
                registrar from its own host, and routing it through the image
                pipeline would break the verification the seal performs on its
                own request. */}
            <img src={seal.src} alt="نماد اعتماد الکترونیکی" width={130} height={130} />
          </a>
        ) : (
          <p className="legal__missing">
            <strong>نماد اعتماد الکترونیکی هنوز نصب نشده است.</strong> پس از تأیید دامنه در پنل
            اینماد، مقادیر <code dir="ltr">ENAMAD_ID</code> و <code dir="ltr">ENAMAD_CODE</code> را
            روی سرور تنظیم کنید تا نشان واقعی این‌جا نمایش داده شود. تا آن زمان هیچ نشانی نمایش داده
            نمی‌شود — نمادی که صادر نشده باشد جعل است، نه جای‌نگه‌دار.
          </p>
        )}
      </section>
    </article>
  )
}
