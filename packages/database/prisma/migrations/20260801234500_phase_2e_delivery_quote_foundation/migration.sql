-- Phase 2E foundation: delivery pricing and immutable Quote-to-Order provenance.
-- Additive by design: new Quote snapshot columns remain nullable until the service
-- backfills active data and the atomic conversion gate is deployed.

CREATE TYPE "DeliveryPricingCalculationMode" AS ENUM ('FLAT', 'DISTANCE_BANDED');

CREATE TABLE "DeliveryPricingRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "operationalZoneId" UUID,
    "version" INTEGER NOT NULL,
    "calculationMode" "DeliveryPricingCalculationMode" NOT NULL DEFAULT 'FLAT',
    "baseFeeAmount" BIGINT NOT NULL,
    "perKilometerFeeAmount" BIGINT NOT NULL DEFAULT 0,
    "minimumOrderAmount" BIGINT,
    "freeDeliveryThreshold" BIGINT,
    "currency" "Currency" NOT NULL DEFAULT 'IRR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryPricingRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryPricingRule_non_negative_amounts_check"
      CHECK (
        "baseFeeAmount" >= 0 AND
        "perKilometerFeeAmount" >= 0 AND
        ("minimumOrderAmount" IS NULL OR "minimumOrderAmount" >= 0) AND
        ("freeDeliveryThreshold" IS NULL OR "freeDeliveryThreshold" >= 0)
      ),
    CONSTRAINT "DeliveryPricingRule_effective_window_check"
      CHECK ("effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom"),
    CONSTRAINT "DeliveryPricingRule_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "DeliveryPricingRule_scope_version_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "operationalZoneId", "version");

CREATE UNIQUE INDEX "DeliveryPricingRule_scope_version_null_zone_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "version")
  WHERE "operationalZoneId" IS NULL;

CREATE UNIQUE INDEX "g3b_DeliveryPricingRule_id_tenant_key"
  ON "DeliveryPricingRule" ("id", "tenantId");

CREATE INDEX "g3b_DeliveryPricingRule_cityId_tenant_idx"
  ON "DeliveryPricingRule" ("cityId", "tenantId");
CREATE INDEX "g3b_DeliveryPricingRule_operationalZoneId_tenant_idx"
  ON "DeliveryPricingRule" ("operationalZoneId", "tenantId");
CREATE INDEX "DeliveryPricingRule_active_scope_idx"
  ON "DeliveryPricingRule" (
    "tenantId",
    "cityId",
    "operationalZoneId",
    "isActive",
    "effectiveFrom"
  );

ALTER TABLE "Quote"
  ADD COLUMN "deliveryAddressId" UUID,
  ADD COLUMN "deliveryPricingRuleId" UUID,
  ADD COLUMN "deliveryPricingRuleVersion" INTEGER,
  ADD COLUMN "recipientNameSnapshot" TEXT,
  ADD COLUMN "recipientPhoneSnapshot" VARCHAR(16),
  ADD COLUMN "deliveryAddressSnapshot" TEXT,
  ADD COLUMN "deliveryLatitudeSnapshot" DECIMAL(10,7),
  ADD COLUMN "deliveryLongitudeSnapshot" DECIMAL(10,7),
  ADD COLUMN "deliveryInstructionsSnapshot" TEXT;

ALTER TABLE "Order" ADD COLUMN "quoteId" UUID;

CREATE INDEX "Quote_deliveryAddressId_idx" ON "Quote" ("deliveryAddressId");
CREATE INDEX "Quote_deliveryPricingRuleId_idx" ON "Quote" ("deliveryPricingRuleId");
CREATE INDEX "g3b_Quote_deliveryAddressId_tenant_idx"
  ON "Quote" ("deliveryAddressId", "tenantId");
CREATE INDEX "g3b_Quote_deliveryPricingRuleId_tenant_idx"
  ON "Quote" ("deliveryPricingRuleId", "tenantId");
CREATE INDEX "g3b_Order_quoteId_tenant_idx" ON "Order" ("quoteId", "tenantId");
CREATE UNIQUE INDEX "Order_quoteId_key" ON "Order" ("quoteId");

ALTER TABLE "DeliveryPricingRule"
  ADD CONSTRAINT "DeliveryPricingRule_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DeliveryPricingRule_cityId_fkey"
  FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DeliveryPricingRule_operationalZoneId_fkey"
  FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_DeliveryPricingRule_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "g3b_DeliveryPricingRule_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_deliveryAddressId_fkey"
  FOREIGN KEY ("deliveryAddressId") REFERENCES "Address"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Quote_deliveryPricingRuleId_fkey"
  FOREIGN KEY ("deliveryPricingRuleId") REFERENCES "DeliveryPricingRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_Quote_deliveryAddressId_tenant_fk"
  FOREIGN KEY ("deliveryAddressId", "tenantId")
  REFERENCES "Address" ("id", "tenantId")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "g3b_Quote_deliveryPricingRuleId_tenant_fk"
  FOREIGN KEY ("deliveryPricingRuleId", "tenantId")
  REFERENCES "DeliveryPricingRule" ("id", "tenantId")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_Order_quoteId_tenant_fk"
  FOREIGN KEY ("quoteId", "tenantId")
  REFERENCES "Quote" ("id", "tenantId")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- Delivery pricing is tenant-owned operational policy. Keep the table deny-by-default
-- under the same transaction-local tenant authority as every other business aggregate.
ALTER TABLE "DeliveryPricingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryPricingRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DeliveryPricingRule"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registered tenant-owned relations for the G3B integrity manifest:
--    ('DeliveryPricingRule', 'cityId', 'City')
--    ('DeliveryPricingRule', 'operationalZoneId', 'OperationalZone')
--    ('Order', 'quoteId', 'Quote')
--    ('Quote', 'deliveryAddressId', 'Address')
--    ('Quote', 'deliveryPricingRuleId', 'DeliveryPricingRule')
