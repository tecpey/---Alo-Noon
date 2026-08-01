-- Phase G2: additive tenant foundation. No runtime enforcement or backfill is enabled here.
-- Existing business rows remain valid with nullable tenantId until Phase G3 verification.

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "TenantMembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

CREATE TABLE "Tenant" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "name" TEXT NOT NULL,
  "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "defaultLocale" VARCHAR(16) NOT NULL DEFAULT 'fa-IR',
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantDomain" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "host" VARCHAR(253) NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMembership" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "status" "TenantMembershipStatus" NOT NULL DEFAULT 'INVITED',
  "activeAt" TIMESTAMP(3),
  "suspendedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AuthSession" ADD COLUMN "activeTenantId" UUID;

ALTER TABLE "City" ADD COLUMN "tenantId" UUID;
ALTER TABLE "OperationalZone" ADD COLUMN "tenantId" UUID;
ALTER TABLE "ServiceArea" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Customer" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Household" ADD COLUMN "tenantId" UUID;
ALTER TABLE "HouseholdMember" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Address" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Bakery" ADD COLUMN "tenantId" UUID;
ALTER TABLE "BakeryBranch" ADD COLUMN "tenantId" UUID;
ALTER TABLE "BakeryOperatingHours" ADD COLUMN "tenantId" UUID;
ALTER TABLE "BakeryCapacitySlot" ADD COLUMN "tenantId" UUID;
ALTER TABLE "ProductCategory" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Product" ADD COLUMN "tenantId" UUID;
ALTER TABLE "ProductVariant" ADD COLUMN "tenantId" UUID;
ALTER TABLE "BakeryProductOffering" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Cart" ADD COLUMN "tenantId" UUID;
ALTER TABLE "CartItem" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Quote" ADD COLUMN "tenantId" UUID;
ALTER TABLE "QuoteItem" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Order" ADD COLUMN "tenantId" UUID;
ALTER TABLE "OrderItem" ADD COLUMN "tenantId" UUID;
ALTER TABLE "OrderStateTransition" ADD COLUMN "tenantId" UUID;
ALTER TABLE "CourierPartner" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Courier" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Vehicle" ADD COLUMN "tenantId" UUID;
ALTER TABLE "DeliveryTask" ADD COLUMN "tenantId" UUID;
ALTER TABLE "DeliveryAssignment" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Fulfillment" ADD COLUMN "tenantId" UUID;
ALTER TABLE "CustomerEvent" ADD COLUMN "tenantId" UUID;
ALTER TABLE "SupportCase" ADD COLUMN "tenantId" UUID;
ALTER TABLE "DomainEventOutbox" ADD COLUMN "tenantId" UUID;
ALTER TABLE "AuditEvent" ADD COLUMN "tenantId" UUID;

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_status_createdAt_idx" ON "Tenant"("status", "createdAt");
CREATE UNIQUE INDEX "TenantDomain_host_key" ON "TenantDomain"("host");
CREATE INDEX "TenantDomain_tenantId_isPrimary_idx" ON "TenantDomain"("tenantId", "isPrimary");
CREATE UNIQUE INDEX "TenantMembership_tenantId_accountId_key" ON "TenantMembership"("tenantId", "accountId");
CREATE INDEX "TenantMembership_accountId_status_idx" ON "TenantMembership"("accountId", "status");
CREATE INDEX "TenantMembership_tenantId_status_idx" ON "TenantMembership"("tenantId", "status");
CREATE INDEX "AuthSession_activeTenantId_idx" ON "AuthSession"("activeTenantId");

CREATE INDEX "City_tenantId_idx" ON "City"("tenantId");
CREATE INDEX "OperationalZone_tenantId_idx" ON "OperationalZone"("tenantId");
CREATE INDEX "ServiceArea_tenantId_idx" ON "ServiceArea"("tenantId");
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");
CREATE INDEX "Household_tenantId_idx" ON "Household"("tenantId");
CREATE INDEX "HouseholdMember_tenantId_idx" ON "HouseholdMember"("tenantId");
CREATE INDEX "Address_tenantId_idx" ON "Address"("tenantId");
CREATE INDEX "Bakery_tenantId_idx" ON "Bakery"("tenantId");
CREATE INDEX "BakeryBranch_tenantId_idx" ON "BakeryBranch"("tenantId");
CREATE INDEX "BakeryOperatingHours_tenantId_idx" ON "BakeryOperatingHours"("tenantId");
CREATE INDEX "BakeryCapacitySlot_tenantId_idx" ON "BakeryCapacitySlot"("tenantId");
CREATE INDEX "ProductCategory_tenantId_idx" ON "ProductCategory"("tenantId");
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");
CREATE INDEX "ProductVariant_tenantId_idx" ON "ProductVariant"("tenantId");
CREATE INDEX "BakeryProductOffering_tenantId_idx" ON "BakeryProductOffering"("tenantId");
CREATE INDEX "Cart_tenantId_idx" ON "Cart"("tenantId");
CREATE INDEX "CartItem_tenantId_idx" ON "CartItem"("tenantId");
CREATE INDEX "Quote_tenantId_idx" ON "Quote"("tenantId");
CREATE INDEX "QuoteItem_tenantId_idx" ON "QuoteItem"("tenantId");
CREATE INDEX "Order_tenantId_idx" ON "Order"("tenantId");
CREATE INDEX "OrderItem_tenantId_idx" ON "OrderItem"("tenantId");
CREATE INDEX "OrderStateTransition_tenantId_idx" ON "OrderStateTransition"("tenantId");
CREATE INDEX "CourierPartner_tenantId_idx" ON "CourierPartner"("tenantId");
CREATE INDEX "Courier_tenantId_idx" ON "Courier"("tenantId");
CREATE INDEX "Vehicle_tenantId_idx" ON "Vehicle"("tenantId");
CREATE INDEX "DeliveryTask_tenantId_idx" ON "DeliveryTask"("tenantId");
CREATE INDEX "DeliveryAssignment_tenantId_idx" ON "DeliveryAssignment"("tenantId");
CREATE INDEX "Fulfillment_tenantId_idx" ON "Fulfillment"("tenantId");
CREATE INDEX "CustomerEvent_tenantId_idx" ON "CustomerEvent"("tenantId");
CREATE INDEX "SupportCase_tenantId_idx" ON "SupportCase"("tenantId");
CREATE INDEX "DomainEventOutbox_tenantId_idx" ON "DomainEventOutbox"("tenantId");
CREATE INDEX "AuditEvent_tenantId_idx" ON "AuditEvent"("tenantId");

ALTER TABLE "TenantDomain"
  ADD CONSTRAINT "TenantDomain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMembership"
  ADD CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMembership"
  ADD CONSTRAINT "TenantMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "IdentityAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_activeTenantId_fkey" FOREIGN KEY ("activeTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stable internal tenant identity for controlled Babol migration. Business rows are backfilled in G3.
INSERT INTO "Tenant" ("id", "slug", "name", "status", "defaultLocale", "currency", "createdAt", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'alo-noon-internal', 'Alo Noon Internal', 'ACTIVE', 'fa-IR', 'IRR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "TenantDomain" ("id", "tenantId", "host", "isPrimary", "verifiedAt", "createdAt", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'alonon.ir', true, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("host") DO NOTHING;
