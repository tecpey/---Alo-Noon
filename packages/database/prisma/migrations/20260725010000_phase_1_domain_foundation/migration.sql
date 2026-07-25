-- Phase 0 contained development-only placeholder tables with no stable domain
-- contract. Refuse replacement if any of those tables contain data so that a
-- deliberate export/backfill migration can be prepared instead of losing data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Customer" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "Bakery" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "Product" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "Courier" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "Order" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "OrderItem" LIMIT 1)
  THEN
    RAISE EXCEPTION 'Phase 1 migration requires empty Phase 0 placeholder tables; export and backfill data explicitly before retrying';
  END IF;
END $$;

DROP TABLE "OrderItem";
DROP TABLE "Order";
DROP TABLE "Courier";
DROP TABLE "Product";
DROP TABLE "Bakery";
DROP TABLE "Customer";
DROP TYPE "OrderStatus";

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('IRR');

-- CreateEnum
CREATE TYPE "CustomerLifecycleStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "HouseholdMemberRole" AS ENUM ('OWNER', 'ADULT', 'DEPENDENT', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "AddressVerificationState" AS ENUM ('UNVERIFIED', 'CUSTOMER_CONFIRMED', 'OPERATIONS_VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BakeryPartnerStatus" AS ENUM ('PROSPECT', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "BranchOperationalStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'TEMPORARILY_SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QualityStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'WATCHLIST', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProductFulfillmentClass" AS ENUM ('SIGNATURE_FRESH', 'PACKAGED_TRADITIONAL', 'PACKAGED_FANTASY', 'PACKAGED_DIETARY', 'LIMITED_EDITION');

-- CreateEnum
CREATE TYPE "FreshnessClaim" AS ENUM ('FRESHLY_PRODUCED', 'PACKAGED', 'SHELF_STABLE', 'NONE');

-- CreateEnum
CREATE TYPE "ProductionMode" AS ENUM ('MADE_TO_ORDER', 'SCHEDULED_BATCH', 'READY_STOCK', 'EXTERNAL_PACKAGED_SUPPLY');

-- CreateEnum
CREATE TYPE "FulfillmentControl" AS ENUM ('CONTROLLED_PICKUP', 'PARTNER_HANDOFF', 'PLATFORM_STOCK', 'THIRD_PARTY_SUPPLY');

-- CreateEnum
CREATE TYPE "PackagingType" AS ENUM ('ALO_NOON_SEALED', 'PARTNER_SEALED', 'MANUFACTURER_PACKAGED');

-- CreateEnum
CREATE TYPE "ProductLifecycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "OfferingAvailabilityStatus" AS ENUM ('DRAFT', 'AVAILABLE', 'PAUSED', 'SOLD_OUT', 'RETIRED');

-- CreateEnum
CREATE TYPE "OrderState" AS ENUM ('DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'IN_FULFILLMENT', 'CANCEL_REQUESTED', 'DELIVERY_FAILED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('NOT_STARTED', 'PENDING', 'PAID', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ProductionState" AS ENUM ('NOT_REQUIRED', 'UNSCHEDULED', 'SCHEDULED', 'IN_PRODUCTION', 'READY', 'HANDED_OFF');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('NOT_REQUIRED', 'UNASSIGNED', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('CUSTOMER', 'STAFF', 'BAKERY', 'COURIER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('BAKERY_PICKUP_DELIVERY', 'PLATFORM_STOCK_DELIVERY', 'CUSTOMER_PICKUP');

-- CreateEnum
CREATE TYPE "FulfillmentState" AS ENUM ('PLANNED', 'PREPARING', 'READY', 'HANDED_OFF', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CourierStatus" AS ENUM ('ONBOARDING', 'AVAILABLE', 'UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BICYCLE', 'MOTORCYCLE', 'ELECTRIC_MOTORCYCLE', 'CAR', 'VAN', 'ON_FOOT');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "DeliveryTaskState" AS ENUM ('UNASSIGNED', 'ASSIGNMENT_PENDING', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryAssignmentState" AS ENUM ('OFFERED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "EventPurpose" AS ENUM ('DOMAIN', 'AUDIT', 'ENGAGEMENT');

-- CreateEnum
CREATE TYPE "ConsentBasis" AS ENUM ('NOT_REQUIRED', 'TRANSACTIONAL', 'EXPLICIT_CONSENT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'MITIGATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "City" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tehran',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalZone" (
    "id" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceArea" (
    "id" UUID NOT NULL,
    "operationalZoneId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "boundaryGeoJson" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "mobileE164" VARCHAR(16) NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "lifecycleStatus" "CustomerLifecycleStatus" NOT NULL DEFAULT 'PROSPECT',
    "crmProfileRef" VARCHAR(128),
    "transactionalConsentAt" TIMESTAMP(3),
    "marketingConsentAt" TIMESTAMP(3),
    "marketingOptOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMember" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "customerId" UUID,
    "displayName" TEXT NOT NULL,
    "mobileE164" VARCHAR(16),
    "role" "HouseholdMemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "operationalZoneId" UUID,
    "label" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientPhoneE164" VARCHAR(16) NOT NULL,
    "addressLine" TEXT NOT NULL,
    "postalCode" VARCHAR(10),
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "deliveryInstructions" TEXT,
    "verificationState" "AddressVerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bakery" (
    "id" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayNameFa" TEXT NOT NULL,
    "partnerStatus" "BakeryPartnerStatus" NOT NULL DEFAULT 'PROSPECT',
    "agreementRef" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bakery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BakeryBranch" (
    "id" UUID NOT NULL,
    "bakeryId" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "operationalZoneId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "pickupInstructions" TEXT,
    "operationalStatus" "BranchOperationalStatus" NOT NULL DEFAULT 'ONBOARDING',
    "qualityStatus" "QualityStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "suspendedUntil" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BakeryBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BakeryOperatingHours" (
    "id" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensAtMinute" INTEGER NOT NULL,
    "closesAtMinute" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BakeryOperatingHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BakeryCapacitySlot" (
    "id" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "serviceDate" DATE NOT NULL,
    "maxOrders" INTEGER NOT NULL,
    "reservedOrders" INTEGER NOT NULL DEFAULT 0,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BakeryCapacitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "descriptionFa" TEXT,
    "mediaRef" VARCHAR(500),
    "lifecycle" "ProductLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "nameFa" TEXT NOT NULL,
    "fulfillmentClass" "ProductFulfillmentClass" NOT NULL,
    "freshnessClaim" "FreshnessClaim" NOT NULL,
    "productionMode" "ProductionMode" NOT NULL,
    "fulfillmentControl" "FulfillmentControl" NOT NULL,
    "packagingType" "PackagingType",
    "shelfLifeMinutes" INTEGER,
    "productionWindowMinutes" INTEGER,
    "pickupWithinMinutes" INTEGER,
    "freshnessWindowMinutes" INTEGER,
    "ingredients" TEXT[],
    "allergens" TEXT[],
    "dietaryAttributes" TEXT[],
    "lifecycle" "ProductLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BakeryProductOffering" (
    "id" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "productVariantId" UUID NOT NULL,
    "priceAmount" BIGINT NOT NULL,
    "priceCurrency" "Currency" NOT NULL DEFAULT 'IRR',
    "availability" "OfferingAvailabilityStatus" NOT NULL DEFAULT 'DRAFT',
    "dailyCapacity" INTEGER,
    "preparationMinutes" INTEGER,
    "availableFrom" TIMESTAMP(3),
    "availableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BakeryProductOffering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "customerId" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "operationalZoneId" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "savedAddressId" UUID,
    "state" "OrderState" NOT NULL DEFAULT 'DRAFT',
    "paymentState" "PaymentState" NOT NULL DEFAULT 'NOT_STARTED',
    "productionState" "ProductionState" NOT NULL DEFAULT 'UNSCHEDULED',
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'UNASSIGNED',
    "recipientNameSnapshot" TEXT NOT NULL,
    "recipientPhoneSnapshot" VARCHAR(16) NOT NULL,
    "deliveryAddressSnapshot" TEXT NOT NULL,
    "deliveryLatitudeSnapshot" DECIMAL(10,7) NOT NULL,
    "deliveryLongitudeSnapshot" DECIMAL(10,7) NOT NULL,
    "deliveryInstructionsSnapshot" TEXT,
    "bakeryNameSnapshot" TEXT NOT NULL,
    "bakeryPickupSnapshot" TEXT,
    "subtotalAmount" BIGINT NOT NULL,
    "deliveryFeeAmount" BIGINT NOT NULL DEFAULT 0,
    "discountAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'IRR',
    "customerNotes" TEXT,
    "cancellationReasonCode" VARCHAR(64),
    "cancellationNotes" TEXT,
    "requestedDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productVariantId" UUID NOT NULL,
    "bakeryProductOfferingId" UUID NOT NULL,
    "skuSnapshot" VARCHAR(64) NOT NULL,
    "productNameFaSnapshot" TEXT NOT NULL,
    "variantNameFaSnapshot" TEXT NOT NULL,
    "fulfillmentClassSnapshot" "ProductFulfillmentClass" NOT NULL,
    "freshnessClaimSnapshot" "FreshnessClaim" NOT NULL,
    "packagingTypeSnapshot" "PackagingType",
    "quantity" INTEGER NOT NULL,
    "unitPriceAmount" BIGINT NOT NULL,
    "lineTotalAmount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'IRR',

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStateTransition" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromState" "OrderState" NOT NULL,
    "toState" "OrderState" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "reasonCode" VARCHAR(64),
    "notes" TEXT,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "correlationId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fulfillment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "bakeryBranchId" UUID,
    "type" "FulfillmentType" NOT NULL,
    "state" "FulfillmentState" NOT NULL DEFAULT 'PLANNED',
    "scheduledProductionAt" TIMESTAMP(3),
    "readyAtEstimate" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "pickupDeadline" TIMESTAMP(3),
    "freshnessDeadline" TIMESTAMP(3),
    "packagingCompletedAt" TIMESTAMP(3),
    "handoffAt" TIMESTAMP(3),
    "pickupProofRef" VARCHAR(500),
    "deliveryProofRef" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierPartner" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Courier" (
    "id" UUID NOT NULL,
    "courierPartnerId" UUID NOT NULL,
    "externalRef" VARCHAR(128),
    "mobileE164" VARCHAR(16) NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "CourierStatus" NOT NULL DEFAULT 'ONBOARDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" UUID NOT NULL,
    "courierPartnerId" UUID NOT NULL,
    "type" "VehicleType" NOT NULL,
    "plateMasked" VARCHAR(32),
    "status" "VehicleStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTask" (
    "id" UUID NOT NULL,
    "fulfillmentId" UUID NOT NULL,
    "state" "DeliveryTaskState" NOT NULL DEFAULT 'UNASSIGNED',
    "pickupAfter" TIMESTAMP(3),
    "pickupBefore" TIMESTAMP(3),
    "deliverBefore" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "failureReasonCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" UUID NOT NULL,
    "deliveryTaskId" UUID NOT NULL,
    "courierId" UUID NOT NULL,
    "vehicleId" UUID,
    "state" "DeliveryAssignmentState" NOT NULL DEFAULT 'OFFERED',
    "offeredAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEvent" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "purpose" "EventPurpose" NOT NULL DEFAULT 'ENGAGEMENT',
    "consentBasis" "ConsentBasis" NOT NULL,
    "subjectType" VARCHAR(80) NOT NULL,
    "subjectId" UUID NOT NULL,
    "correlationId" UUID NOT NULL,
    "causationId" UUID,
    "properties" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEventOutbox" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "aggregateType" VARCHAR(80) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "correlationId" UUID NOT NULL,
    "causationId" UUID,
    "consentBasis" "ConsentBasis" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(80) NOT NULL,
    "entityId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "correlationId" UUID NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" UUID NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "customerId" UUID,
    "orderId" UUID,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'NORMAL',
    "category" VARCHAR(64) NOT NULL,
    "subject" TEXT NOT NULL,
    "assignedStaffId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseNote" (
    "id" UUID NOT NULL,
    "supportCaseId" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIncident" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "fulfillmentId" UUID,
    "deliveryTaskId" UUID,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "IncidentSeverity" NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "summary" TEXT NOT NULL,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "City_code_key" ON "City"("code");

-- CreateIndex
CREATE INDEX "OperationalZone_cityId_isActive_idx" ON "OperationalZone"("cityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalZone_cityId_code_key" ON "OperationalZone"("cityId", "code");

-- CreateIndex
CREATE INDEX "ServiceArea_operationalZoneId_isActive_idx" ON "ServiceArea"("operationalZoneId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceArea_operationalZoneId_code_key" ON "ServiceArea"("operationalZoneId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_mobileE164_key" ON "Customer"("mobileE164");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_crmProfileRef_key" ON "Customer"("crmProfileRef");

-- CreateIndex
CREATE INDEX "Customer_lifecycleStatus_createdAt_idx" ON "Customer"("lifecycleStatus", "createdAt");

-- CreateIndex
CREATE INDEX "HouseholdMember_householdId_role_idx" ON "HouseholdMember"("householdId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdMember_householdId_customerId_key" ON "HouseholdMember"("householdId", "customerId");

-- CreateIndex
CREATE INDEX "Address_customerId_archivedAt_idx" ON "Address"("customerId", "archivedAt");

-- CreateIndex
CREATE INDEX "Address_cityId_operationalZoneId_verificationState_idx" ON "Address"("cityId", "operationalZoneId", "verificationState");

-- CreateIndex
CREATE UNIQUE INDEX "Bakery_agreementRef_key" ON "Bakery"("agreementRef");

-- CreateIndex
CREATE INDEX "Bakery_partnerStatus_idx" ON "Bakery"("partnerStatus");

-- CreateIndex
CREATE INDEX "BakeryBranch_operationalZoneId_operationalStatus_qualitySta_idx" ON "BakeryBranch"("operationalZoneId", "operationalStatus", "qualityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BakeryBranch_cityId_code_key" ON "BakeryBranch"("cityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BakeryOperatingHours_bakeryBranchId_dayOfWeek_key" ON "BakeryOperatingHours"("bakeryBranchId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "BakeryCapacitySlot_bakeryBranchId_serviceDate_key" ON "BakeryCapacitySlot"("bakeryBranchId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_code_key" ON "ProductCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_categoryId_lifecycle_idx" ON "Product"("categoryId", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE INDEX "ProductVariant_fulfillmentClass_lifecycle_idx" ON "ProductVariant"("fulfillmentClass", "lifecycle");

-- CreateIndex
CREATE INDEX "BakeryProductOffering_bakeryBranchId_availability_idx" ON "BakeryProductOffering"("bakeryBranchId", "availability");

-- CreateIndex
CREATE UNIQUE INDEX "BakeryProductOffering_bakeryBranchId_productVariantId_key" ON "BakeryProductOffering"("bakeryBranchId", "productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_publicId_key" ON "Order"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_cityId_operationalZoneId_state_idx" ON "Order"("cityId", "operationalZoneId", "state");

-- CreateIndex
CREATE INDEX "Order_bakeryBranchId_productionState_createdAt_idx" ON "Order"("bakeryBranchId", "productionState", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productVariantId_idx" ON "OrderItem"("productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStateTransition_idempotencyKey_key" ON "OrderStateTransition"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderStateTransition_orderId_occurredAt_idx" ON "OrderStateTransition"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "OrderStateTransition_correlationId_idx" ON "OrderStateTransition"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_orderId_key" ON "Fulfillment"("orderId");

-- CreateIndex
CREATE INDEX "Fulfillment_bakeryBranchId_state_readyAtEstimate_idx" ON "Fulfillment"("bakeryBranchId", "state", "readyAtEstimate");

-- CreateIndex
CREATE UNIQUE INDEX "CourierPartner_code_key" ON "CourierPartner"("code");

-- CreateIndex
CREATE INDEX "Courier_courierPartnerId_status_idx" ON "Courier"("courierPartnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Courier_courierPartnerId_externalRef_key" ON "Courier"("courierPartnerId", "externalRef");

-- CreateIndex
CREATE INDEX "Vehicle_courierPartnerId_type_status_idx" ON "Vehicle"("courierPartnerId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTask_fulfillmentId_key" ON "DeliveryTask"("fulfillmentId");

-- CreateIndex
CREATE INDEX "DeliveryTask_state_pickupBefore_idx" ON "DeliveryTask"("state", "pickupBefore");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_deliveryTaskId_state_idx" ON "DeliveryAssignment"("deliveryTaskId", "state");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_courierId_state_offeredAt_idx" ON "DeliveryAssignment"("courierId", "state", "offeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEvent_eventId_key" ON "CustomerEvent"("eventId");

-- CreateIndex
CREATE INDEX "CustomerEvent_customerId_occurredAt_idx" ON "CustomerEvent"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "CustomerEvent_name_occurredAt_idx" ON "CustomerEvent"("name", "occurredAt");

-- CreateIndex
CREATE INDEX "CustomerEvent_correlationId_idx" ON "CustomerEvent"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventOutbox_eventId_key" ON "DomainEventOutbox"("eventId");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_status_createdAt_idx" ON "DomainEventOutbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_aggregateType_aggregateId_occurredAt_idx" ON "DomainEventOutbox"("aggregateType", "aggregateId", "occurredAt");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_correlationId_idx" ON "DomainEventOutbox"("correlationId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_occurredAt_idx" ON "AuditEvent"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorType_actorId_occurredAt_idx" ON "AuditEvent"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_publicId_key" ON "SupportCase"("publicId");

-- CreateIndex
CREATE INDEX "SupportCase_status_priority_createdAt_idx" ON "SupportCase"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_customerId_createdAt_idx" ON "SupportCase"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_orderId_idx" ON "SupportCase"("orderId");

-- CreateIndex
CREATE INDEX "SupportCaseNote_supportCaseId_createdAt_idx" ON "SupportCaseNote"("supportCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalIncident_status_severity_createdAt_idx" ON "OperationalIncident"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalIncident_orderId_idx" ON "OperationalIncident"("orderId");

-- CreateIndex
CREATE INDEX "OperationalIncident_deliveryTaskId_idx" ON "OperationalIncident"("deliveryTaskId");

-- AddForeignKey
ALTER TABLE "OperationalZone" ADD CONSTRAINT "OperationalZone_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_operationalZoneId_fkey" FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_operationalZoneId_fkey" FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryBranch" ADD CONSTRAINT "BakeryBranch_bakeryId_fkey" FOREIGN KEY ("bakeryId") REFERENCES "Bakery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryBranch" ADD CONSTRAINT "BakeryBranch_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryBranch" ADD CONSTRAINT "BakeryBranch_operationalZoneId_fkey" FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryOperatingHours" ADD CONSTRAINT "BakeryOperatingHours_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryCapacitySlot" ADD CONSTRAINT "BakeryCapacitySlot_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryProductOffering" ADD CONSTRAINT "BakeryProductOffering_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BakeryProductOffering" ADD CONSTRAINT "BakeryProductOffering_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_operationalZoneId_fkey" FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_savedAddressId_fkey" FOREIGN KEY ("savedAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_bakeryProductOfferingId_fkey" FOREIGN KEY ("bakeryProductOfferingId") REFERENCES "BakeryProductOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStateTransition" ADD CONSTRAINT "OrderStateTransition_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Courier" ADD CONSTRAINT "Courier_courierPartnerId_fkey" FOREIGN KEY ("courierPartnerId") REFERENCES "CourierPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_courierPartnerId_fkey" FOREIGN KEY ("courierPartnerId") REFERENCES "CourierPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_deliveryTaskId_fkey" FOREIGN KEY ("deliveryTaskId") REFERENCES "DeliveryTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEvent" ADD CONSTRAINT "CustomerEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseNote" ADD CONSTRAINT "SupportCaseNote_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_deliveryTaskId_fkey" FOREIGN KEY ("deliveryTaskId") REFERENCES "DeliveryTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain invariants enforced at the persistence boundary as a second line of defense.
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_classification_check" CHECK (
  (
    "fulfillmentClass" = 'SIGNATURE_FRESH'
    AND "freshnessClaim" = 'FRESHLY_PRODUCED'
    AND "productionMode" IN ('MADE_TO_ORDER', 'SCHEDULED_BATCH')
    AND "fulfillmentControl" IN ('CONTROLLED_PICKUP', 'PARTNER_HANDOFF')
    AND "productionWindowMinutes" > 0
    AND "pickupWithinMinutes" > 0
    AND "freshnessWindowMinutes" > 0
  )
  OR (
    "fulfillmentClass" IN ('PACKAGED_TRADITIONAL', 'PACKAGED_FANTASY', 'PACKAGED_DIETARY')
    AND "freshnessClaim" IN ('PACKAGED', 'SHELF_STABLE')
    AND "packagingType" IS NOT NULL
    AND "shelfLifeMinutes" > 0
  )
  OR (
    "fulfillmentClass" = 'LIMITED_EDITION'
    AND "freshnessClaim" <> 'FRESHLY_PRODUCED'
  )
);

ALTER TABLE "BakeryProductOffering" ADD CONSTRAINT "BakeryProductOffering_price_check"
  CHECK ("priceAmount" >= 0 AND ("dailyCapacity" IS NULL OR "dailyCapacity" >= 0));
ALTER TABLE "BakeryCapacitySlot" ADD CONSTRAINT "BakeryCapacitySlot_capacity_check"
  CHECK ("maxOrders" >= 0 AND "reservedOrders" >= 0 AND "reservedOrders" <= "maxOrders");
ALTER TABLE "BakeryOperatingHours" ADD CONSTRAINT "BakeryOperatingHours_time_check"
  CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "opensAtMinute" BETWEEN 0 AND 1439 AND "closesAtMinute" BETWEEN 1 AND 1440);
ALTER TABLE "Order" ADD CONSTRAINT "Order_money_check"
  CHECK ("subtotalAmount" >= 0 AND "deliveryFeeAmount" >= 0 AND "discountAmount" >= 0 AND "totalAmount" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_money_quantity_check"
  CHECK ("quantity" > 0 AND "unitPriceAmount" >= 0 AND "lineTotalAmount" = "unitPriceAmount" * "quantity");
