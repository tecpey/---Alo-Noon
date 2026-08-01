# نقشه مستندات الو نون

این پوشه منبع تصمیم‌های محصول، عملیات، امنیت و معماری الو نون است. تصمیم‌های مهم
نباید فقط در گفتگو، کد یا حافظه افراد باقی بمانند.

> اسناد هدف و معماری آینده را از قابلیت‌های پیاده‌سازی‌شده تفکیک می‌کنند. وضعیت
> واقعی هر فاز در `architecture/README.md`، `architecture/DOMAIN_BOUNDARIES.md`
> و اسناد فاز انگلیسی ثبت شده است.

## ترتیب مطالعه برای مدیر محصول و عملیات

1. `00-governance/ALO_NOON_PROJECT_GOVERNANCE_FA.md`
2. `00-vision/PRODUCT_VISION_FA.md`
3. `01-product/CATALOG_AND_FRESHNESS_MODEL_FA.md`
4. `02-operations/BABOL_PILOT_OPERATING_MODEL_FA.md`
5. `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`
6. `04-crm/CRM_BLUEPRINT_FA.md`
7. `05-logistics/LOGISTICS_PRICING_AND_PROVIDER_MODEL_FA.md`
8. `07-roadmap/MVP_ROADMAP_FA.md`

## ترتیب مطالعه برای مهندسی

1. `00-governance/ALO_NOON_PROJECT_GOVERNANCE_FA.md`
2. `architecture/README.md`
3. `03-architecture/API_FIRST_ARCHITECTURE_FA.md`
4. `03-architecture/DOMAIN_MODEL_FA.md`
5. `architecture/PHASE_1_DOMAIN_FOUNDATION.md`
6. `architecture/PHASE_2B_IDENTITY_ACCESS.md`
7. `architecture/PHASE_2C_CUSTOMER_APP_INTEGRATION.md`
8. `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`
9. `06-security/SECURITY_BASELINE_FA.md`
10. `decisions/`

## اسناد جدید مرجع

### `architecture/PHASE_1_DOMAIN_FOUNDATION.md`

مرز دامنه‌ها، مدل‌های هدف، State Machine سفارش، RBAC محدوده‌محور، Outbox،
Idempotency، Migration، تست و ترتیب PRهای فاز یک را تعریف می‌کند.

### `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`

اعلان‌های هوشمند و دستی برای مشتری، نانوا، پیک و عملیات؛ چاپ خودکار Kitchen
Ticket و لیبل چسبی؛ Print Agent، مدل داده، حریم خصوصی، Retry، خطا و معیار پذیرش
MVP را تعریف می‌کند.

### `architecture/PHASE_2B_IDENTITY_ACCESS.md`

OTP امن، Session opaque و قابل ابطال، مدل نقش/مجوز/Scope، Audit بدون افشای
Secret یا PII و مرز اتصال آینده ارائه‌دهنده پیامک را تعریف می‌کند.

### `architecture/PHASE_2C_CUSTOMER_APP_INTEGRATION.md`

اتصال واقعی اپ مشتری به Session، شهرهای فعال، مجوز موقعیت، محدوده سرویس و
کاتالوگ و همچنین قواعد CORS و برچسب‌گذاری دقیق تازگی محصول را تعریف می‌کند.

## طبقه‌بندی اسناد

- **Authority**: تصمیم پایه و الزام‌آور؛ تغییر آن نیازمند ADR یا تایید رسمی است.
- **Target Architecture**: وضعیت مطلوب آینده، نه لزوماً وضعیت فعلی.
- **Living Document**: همراه محصول و عملیات به‌روز می‌شود.
- **Runbook**: راهنمای اجرای عملیات یا پاسخ به خطا.
- **Generated**: خروجی خودکار ابزارها و قابل ویرایش دستی نیست.

## قواعد مستندسازی

- قابلیت پیاده‌سازی‌شده و قابلیت برنامه‌ریزی‌شده باید صریحاً تفکیک شوند.
- هر تغییر مدل داده، API، امنیت، پرداخت، چاپ یا لجستیک باید مستند شود.
- تصمیم‌های معماری مهم در `decisions/` به‌صورت ADR ثبت شوند.
- اسناد نباید secret، داده شخصی واقعی یا اطلاعات پرداخت داشته باشند.
- مسیرها، نام‌ها و اصطلاحات باید با کد و قراردادهای API همگام باشند.
- هر PR مهم باید بخش‌های API/data model، security/privacy، operational impact،
  tests و rollback را تکمیل کند.

## وضعیت فعلی

ریپو پس از Phase 2D Commerce و Phase G2 Tenant Foundation قرار دارد.
Cart و Quote سروری، OTP، Session قابل ابطال، RBAC، قراردادهای نسخه‌دار،
PostgreSQL/Prisma و Tenant foundation افزایشی پیاده‌سازی و در CI تایید
شده‌اند. Phase G3A برای Backfill کنترل‌شده داده‌های پیش از چندمستاجری در حال
بررسی است. TenantContext اجباری، تست‌های منفی Cross-tenant، RLS، پرداخت،
Quote-to-Order، اعلان Delivery و چاپ اجرایی هنوز تکمیل نشده‌اند و نباید
قابلیت تحویل‌شده معرفی شوند.

## منابع معتبر وضعیت فعلی

1. `product/PRODUCT_REQUIREMENTS.md`
2. `architecture/DOMAIN_BOUNDARIES.md`
3. `architecture/DOMAIN_MODEL.md`
4. `architecture/DOMAIN_EVENT_MODEL.md`
5. `architecture/DATA_OWNERSHIP.md`
6. `architecture/SERVICE_BOUNDARIES.md`
7. `decisions/ADR-0004` تا `ADR-0007`
8. `architecture/PHASE_2B_IDENTITY_ACCESS.md`
9. `architecture/PHASE_2C_CUSTOMER_APP_INTEGRATION.md`
