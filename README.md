# الو نون — Alo Noon Platform

**پلتفرم API-first و چندشهری برای عرضه نان‌های تازه امضادار، نان‌های سنتی بسته‌بندی‌شده، محصولات فانتزی و رژیمی، CRM یکپارچه، کیف پول و ارکستراسیون لجستیک.**

> وضعیت: Foundation / Pre-MVP — شروع پایلوت عملیاتی از بابل، مازندران

## تعریف محصول

الو نون یک اپ ساده سفارش نان نیست. این پروژه یک زیرساخت عملیاتی و تجاری است که مشتری، خانواده، مرکز تماس، نانوایی، تأمین‌کننده، شریک لجستیکی، پیک، کیف پول، CRM و پشتیبانی را در یک هسته مشترک متصل می‌کند.

### دسته‌های محصول

1. **نان تازه امضادار هر نانوایی** — محصول پرمیوم و ویژه کاربران الو نون، تولید کنترل‌شده و ارسال با جریان اختصاصی.
2. **نان سنتی بسته‌بندی‌شده** — نان‌های ساده با بسته‌بندی و کنترل کیفیت الو نون.
3. **نان‌های فانتزی و رژیمی بسته‌ای** — با ادعاهای سلامت کنترل‌شده و قابل اثبات.
4. **محصولات محدود آینده** — کیک‌ها و شیرینی‌های منتخب، سفارشی و محدود.

الو نون وعده «نان گرم» نمی‌دهد. وعده محصول، **نان تازه با تعریف، زمان، استاندارد و رهگیری شفاف** است.

## اصول غیرقابل مذاکره

- API-first و backend-as-source-of-truth
- آماده برای چند شهر، چند تأمین‌کننده و چند شریک لجستیکی
- عدم وابستگی معماری به شریک پیک اولیه بابل
- CRM به‌عنوان حافظه مرکزی مشتری، خانواده، نانوایی، پیک و پشتیبانی
- دفترکل مالی تغییرناپذیر برای کیف پول و تسویه‌ها
- سفارش از اپ، وب، تلفن و پنل اپراتور در یک Order Management System
- حفظ حریم خصوصی، امنیت، قابلیت حسابرسی و کنترل دسترسی

## ساختار Monorepo

```text
apps/
  api/             Fastify API and domain modules
  web/             Customer-facing web application
packages/
  contracts/       OpenAPI and shared API contracts
  database/        Prisma schema and database package
  shared/          Shared domain primitives
docs/
  00-vision/       Vision and positioning
  01-product/      Catalog and product rules
  02-operations/   Babol pilot operations
  03-architecture/ API-first architecture and domain model
  04-crm/          CRM blueprint
  05-logistics/    Pricing and provider orchestration
  06-security/     Security and privacy baseline
  07-roadmap/      MVP execution roadmap
  decisions/       Architecture Decision Records
```

## شروع محلی

```bash
cp .env.example .env
docker compose up -d
corepack enable
pnpm install
pnpm db:generate
pnpm dev
```

- API: `http://localhost:4000`
- Health: `http://localhost:4000/health`
- Web: `http://localhost:3000`
- OpenAPI: `packages/contracts/openapi/alo-noon.v1.yaml`

## مستندات کلیدی

- [چشم‌انداز محصول](docs/00-vision/PRODUCT_VISION_FA.md)
- [مدل کاتالوگ و تازگی](docs/01-product/CATALOG_AND_FRESHNESS_MODEL_FA.md)
- [مدل عملیات پایلوت بابل](docs/02-operations/BABOL_PILOT_OPERATING_MODEL_FA.md)
- [معماری API-first](docs/03-architecture/API_FIRST_ARCHITECTURE_FA.md)
- [بلوپرینت CRM](docs/04-crm/CRM_BLUEPRINT_FA.md)
- [لجستیک و قیمت‌گذاری](docs/05-logistics/LOGISTICS_PRICING_AND_PROVIDER_MODEL_FA.md)
- [خط مبنای امنیت](docs/06-security/SECURITY_BASELINE_FA.md)
- [نقشه راه MVP](docs/07-roadmap/MVP_ROADMAP_FA.md)

## مالکیت

این مخزن خصوصی و اختصاصی است. استفاده، انتشار یا بازتوزیع بدون اجازه کتبی مالک ممنوع است.
