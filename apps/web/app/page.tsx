const categories = [
  ["نان تازه امضادار", "محصول ویژه هر نانوایی، مخصوص کاربران الو نون"],
  ["نان سنتی بسته‌بندی", "انتخاب روزمره با بسته‌بندی و کنترل کیفیت الو نون"],
  ["فانتزی و رژیمی", "محصولات بسته‌ای منتخب با اطلاعات شفاف"],
  ["محصولات محدود", "کیک و شیرینی‌های ویژه در فاز بعدی"]
];

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <span className="eyebrow">شروع از بابل</span>
        <h1>الو نون</h1>
        <p>نان متفاوت، انتخاب‌شده و مطمئن؛ با سفارش از اپ، وب یا تلفن.</p>
        <div className="actions">
          <button type="button">به‌زودی سفارش آنلاین</button>
          <a href="#model">مدل محصولات</a>
        </div>
      </section>

      <section id="model" className="grid" aria-label="دسته‌بندی محصولات">
        {categories.map(([title, description]) => (
          <article key={title}>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="principles">
        <h2>قول ما نان گرم نیست؛ تازگی قابل‌تعریف و قابل‌اعتماد است.</h2>
        <p>زمان تولید، بسته‌بندی، آماده‌سازی و تحویل هر محصول باید شفاف و قابل رهگیری باشد.</p>
      </section>
    </main>
  );
}
