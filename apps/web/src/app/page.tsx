import { appMeta } from '@alo-noon/config'

export const foundationStatus = 'زیرساخت سفارش نان آماده است'

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <span className="eyebrow">{appMeta.nameFa}</span>
        <h1>نان تازه، از تنور تا خانه</h1>
        <p>
          سفارش شفاف، آماده‌سازی هماهنگ و تحویل قابل پیگیری؛ یک زیرساخت ساده برای تجربه‌ای روزمره و
          مطمئن.
        </p>
        <div className="status" role="status">
          <span aria-hidden="true" />
          {foundationStatus}
        </div>
      </section>
    </main>
  )
}
