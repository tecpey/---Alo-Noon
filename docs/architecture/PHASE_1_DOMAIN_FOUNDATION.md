# Phase 1 — Domain Foundation & Security Baseline

## هدف

تبدیل Phase 0 از یک اسکلت فنی به پایه‌ای قابل اتکا برای ساخت محصول واقعی الو نون، بدون ورود زودهنگام به پیچیدگی Microservice یا UIهای نمایشی.

## وضعیت ورودی

Phase 0 شامل Monorepo، وب، API، دو اپ موبایل، PostgreSQL/Prisma، قراردادها، تنظیمات، Design Tokens و CI است. مدل داده فعلی تنها Customer، Bakery، Product، Courier، Order و OrderItem را پوشش می‌دهد و برای عملیات واقعی کافی نیست.

## اصول طراحی

- Modular Monolith با مرز دامنه روشن
- PostgreSQL منبع حقیقت
- API-first و event-ready
- Multi-city و scope-aware از ابتدا
- Forward-only migrations
- Idempotency برای عملیات حساس
- Outbox برای رویدادهای قابل اتکا
- کمترین دسترسی و Auditability
- عدم هاردکد بابل، نانوایی، پیک یا قیمت

## دامنه‌ها

### Identity & Access

```text
User
UserIdentity
Session
Device
Role
Permission
RolePermission
UserRoleAssignment
AccessScope
OtpChallenge
MfaMethod
```

Scopeها شامل Platform، City، Zone، Bakery، Branch و Fleet Partner هستند.

### Customer & Household

```text
CustomerProfile
Household
HouseholdMember
Recipient
CustomerPreference
Consent
```

پرداخت‌کننده، سفارش‌دهنده و گیرنده می‌توانند افراد متفاوت باشند.

### Geography & Serviceability

```text
Country
Province
City
ServiceZone
Address
AddressPoint
DeliveryConstraint
```

آدرس باید ساختاریافته، دارای مختصات، دستور تحویل و نسخه normalized باشد. Serviceability بر اساس polygon/zone و سیاست محصول ارزیابی می‌شود.

### Bakery & Partner

```text
PartnerApplication
Bakery
BakeryBranch
BakeryUser
OperatingHour
Capability
ComplianceDocument
PartnerAgreement
```

درخواست همکاری شامل محصول ویژه، ظرفیت، مجوز، تصاویر، شهر و قابلیت‌های تولید/بسته‌بندی است.

### Catalog & Offering

```text
Product
ProductVariant
ProductClass
Ingredient
Allergen
BakeryOffering
PriceRule
AvailabilityWindow
PackagingPolicy
FreshnessPolicy
```

Product تعریف عمومی است؛ BakeryOffering عرضه واقعی یک Variant توسط یک شعبه با قیمت، ظرفیت و SLA مشخص است.

### Production & Capacity

```text
ProductionSlot
ProductionBatch
CapacityReservation
PreparationTask
PackagingTask
QualityCheck
```

نان تازه، محصول بسته‌بندی، Oven Finish و پیش‌سفارش Workflow و ظرفیت‌های متفاوت دارند.

### Cart, Checkout & Order

```text
Cart
CartItem
CheckoutSession
Order
OrderLine
OrderPriceSnapshot
OrderStatusHistory
OrderAdjustment
Cancellation
```

قیمت، مالیات/هزینه، محصول، Offering و سیاست‌ها در زمان سفارش snapshot می‌شوند.

### Pre-order & Subscription

```text
PreorderWindow
Reservation
SubscriptionPlan
CustomerSubscription
SubscriptionSchedule
SubscriptionOccurrence
SkipRequest
```

### Payment & Settlement

```text
PaymentIntent
PaymentAttempt
Refund
LedgerAccount
LedgerEntry
Settlement
SettlementLine
```

مانده‌ها از ledger مشتق می‌شوند و تغییر مستقیم balance ممنوع است.

### Courier, Fleet & Dispatch

```text
Courier
FleetPartner
Vehicle
Shift
Shipment
Package
DispatchAssignment
Route
RouteStop
LocationPing
ProofOfDelivery
```

یک Route می‌تواند چند Shipment/Package و حداقل ۱۰ توقف را پشتیبانی کند. ترتیب توقف versioned است.

### ETA & Tracking

```text
EtaEstimate
EtaFactor
TrackingSession
TrackingEvent
```

ETA نسخه اول ترکیبی از زمان تولید، بسته‌بندی، انتظار پیک، مسیر، توقف‌ها و buffer عملیاتی است.

### Notification, Print & Label

در سند `docs/operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md` تعریف شده است.

### CRM, Support & Quality

```text
CustomerTimelineEvent
SupportCase
CaseMessage
QualityIncident
Rating
Compensation
```

### CMS, Discovery & Growth

```text
ContentEntry
SeoMetadata
Redirect
CityLanding
FaqEntry
Promotion
Coupon
```

### Audit & Compliance

```text
AuditEvent
SecurityEvent
DataAccessEvent
ConsentRecord
RetentionPolicy
```

## State Machine سفارش

وضعیت اصلی پیشنهادی:

```text
DRAFT
AWAITING_PAYMENT
PAYMENT_AUTHORIZED
CONFIRMED
ACCEPTED
SCHEDULED
IN_PRODUCTION
PACKAGING
READY_FOR_PICKUP
COURIER_ASSIGNED
PICKED_UP
IN_TRANSIT
ARRIVING
DELIVERED
CANCELLED
FAILED
REFUND_PENDING
REFUNDED
```

قواعد:

- Transitionها whitelist هستند.
- Actor، timestamp، reason، source و correlation ID ثبت می‌شود.
- Client مستقیماً status دلخواه تعیین نمی‌کند.
- هر نوع fulfillment مسیر مجاز خود را دارد.
- تغییر وضعیت‌های حساس idempotency key می‌خواهند.

## ماژول‌های API پیشنهادی

```text
src/modules/identity
src/modules/customers
src/modules/geography
src/modules/partners
src/modules/catalog
src/modules/production
src/modules/orders
src/modules/subscriptions
src/modules/payments
src/modules/logistics
src/modules/notifications
src/modules/printing
src/modules/crm
src/modules/content
src/modules/audit
```

هر ماژول شامل domain، application، infrastructure و transport است؛ وابستگی مستقیم ماژول‌ها به Prisma باید محدود به لایه repository باشد.

## امنیت پایه

### احراز هویت

- OTP با TTL، محدودیت تلاش و rate limit
- hash کردن OTP و عدم log کردن کد
- session امن و قابل revoke
- device/session list
- MFA برای مدیران، مالی و عملیات حساس

### مجوزدهی

- RBAC + scope
- deny-by-default
- کنترل object-level authorization
- تست جداسازی شهر، شعبه و شریک

### داده

- طبقه‌بندی PII
- masking تلفن و آدرس بر اساس نقش
- encrypted transport
- secret manager
- جداسازی test/staging/production
- redaction در log و telemetry

### عملیات حساس

- idempotency
- Audit Log
- approval دوم برای ارسال انبوه، refundهای بزرگ و تغییرات مالی حساس
- signed webhook و replay protection برای providerها

## Outbox و Job Processing

جداول پایه:

```text
OutboxEvent
InboxEvent
Job
JobAttempt
DeadLetter
IdempotencyRecord
```

کاربردها:

- اعلان
- چاپ
- CRM timeline
- پرداخت و webhook
- تخصیص پیک
- تولید اشتراک‌های دوره‌ای

## نقشه Migration

1. افزودن مدل‌های جدید بدون حذف مدل‌های قدیمی
2. Backfill داده‌های موجود
3. dual-read محدود در صورت نیاز
4. انتقال endpointها
5. validation و reconciliation
6. حذف فیلدهای deprecated در Migration جداگانه

Migrationهای مخرب در همان PR معرفی مدل جدید انجام نمی‌شوند.

## تست‌های الزامی

- Unit test برای transitionهای سفارش
- Integration test با PostgreSQL واقعی
- migration deploy از دیتابیس خالی
- migration upgrade از snapshot قبلی
- authorization matrix tests
- idempotency و duplicate delivery tests
- outbox recovery tests
- PII redaction tests
- printer/notification contract tests

## خروجی‌های Phase 1

- ADR مرزبندی دامنه
- Prisma schema ماژولار یا مستندشده
- Migrationهای forward-only
- Identity و RBAC foundation
- Audit foundation
- Outbox/Inbox foundation
- Idempotency middleware/store
- Order state machine library
- قراردادهای versioned event
- تست‌های معماری و دیتابیس
- مستندات threat model اولیه

## خارج از محدوده Phase 1

- پرداخت production
- مسیریابی بهینه واقعی
- اپ کامل مشتری یا پیک
- پنل کامل نانوایی
- AI پیش‌بینی تقاضا
- Microservice extraction

## Definition of Done

- تمام Quality Gateها سبز باشند.
- Migration روی دیتابیس خالی و نسخه قبلی اجرا شود.
- هیچ secret یا PII در test fixture/log وجود نداشته باشد.
- مرز دسترسی حداقل دو شهر و دو نانوایی با تست اثبات شود.
- duplicate request یا event اثر تراکنشی تکراری نسازد.
- اسناد و قراردادها با کد همگام باشند.
- PR شامل rollback و operational impact باشد.

## ترتیب PRها

1. `domain vocabulary + ADR`
2. `geography and partner foundation`
3. `identity, session and scoped RBAC`
4. `catalog and bakery offering`
5. `order state machine and snapshots`
6. `outbox, idempotency and audit`
7. `notification and print contracts`

هر PR باید کوچک، تست‌پذیر و قابل بازگشت باشد.