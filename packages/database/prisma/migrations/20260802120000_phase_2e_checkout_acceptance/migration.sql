-- Phase 2E runtime acceptance: customer address provenance, authoritative delivery
-- pricing snapshots, and durable capacity-backed Quote-to-Order conversion.
-- Rollout-sensitive snapshot and reservation columns remain nullable for legacy rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DeliveryPricingRule" rule
    JOIN "OperationalZone" zone ON zone."id" = rule."operationalZoneId"
    WHERE rule."operationalZoneId" IS NOT NULL
      AND (zone."tenantId" <> rule."tenantId" OR zone."cityId" <> rule."cityId")
  ) THEN
    RAISE EXCEPTION 'Phase 2E checkout aborted: pricing rule scope is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "DeliveryPricingRule"
    WHERE "isActive"
    GROUP BY "tenantId", "cityId", "operationalZoneId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple active delivery pricing rules exist for one scope';
  END IF;
END $$;

ALTER TABLE "Address"
  ADD COLUMN "serviceAreaId" UUID,
  ADD COLUMN "requestIdempotencyKey" VARCHAR(128);

ALTER TABLE "Quote"
  ADD COLUMN "deliveryServiceAreaIdSnapshot" UUID,
  ADD COLUMN "deliveryOperationalZoneIdSnapshot" UUID,
  ADD COLUMN "deliveryDistanceMeters" INTEGER,
  ADD COLUMN "bakeryNameSnapshot" TEXT,
  ADD COLUMN "bakeryPickupSnapshot" TEXT;

ALTER TABLE "QuoteItem"
  ADD COLUMN "productNameFaSnapshot" TEXT,
  ADD COLUMN "packagingTypeSnapshot" "PackagingType";

ALTER TABLE "Order" ADD COLUMN "bakeryCapacitySlotId" UUID;

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_delivery_distance_check"
  CHECK ("deliveryDistanceMeters" IS NULL OR "deliveryDistanceMeters" >= 0),
  ADD CONSTRAINT "Quote_delivery_pricing_version_check"
  CHECK ("deliveryPricingRuleVersion" IS NULL OR "deliveryPricingRuleVersion" > 0);

-- Do not fabricate historical delivery economics. Legacy active quotes cannot be
-- converted because their delivery/item snapshots are incomplete.
UPDATE "Quote" q
SET "status" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
WHERE q."status" = 'ACTIVE'
  AND (
    q."deliveryAddressId" IS NULL OR
    q."deliveryPricingRuleId" IS NULL OR
    q."deliveryPricingRuleVersion" IS NULL OR
    q."deliveryServiceAreaIdSnapshot" IS NULL OR
    q."deliveryOperationalZoneIdSnapshot" IS NULL OR
    q."deliveryDistanceMeters" IS NULL OR
    q."bakeryNameSnapshot" IS NULL OR
    q."bakeryPickupSnapshot" IS NULL OR
    q."recipientNameSnapshot" IS NULL OR
    q."recipientPhoneSnapshot" IS NULL OR
    q."deliveryAddressSnapshot" IS NULL OR
    q."deliveryLatitudeSnapshot" IS NULL OR
    q."deliveryLongitudeSnapshot" IS NULL OR
    EXISTS (
      SELECT 1 FROM "QuoteItem" qi
      WHERE qi."quoteId" = q."id" AND qi."productNameFaSnapshot" IS NULL
    )
  );

DROP INDEX "Quote_idempotencyKey_key";
DROP INDEX "Order_idempotencyKey_key";

CREATE UNIQUE INDEX "Address_tenant_customer_idempotency_key"
  ON "Address" ("tenantId", "customerId", "requestIdempotencyKey");
CREATE UNIQUE INDEX "Quote_tenant_customer_idempotency_key"
  ON "Quote" ("tenantId", "customerId", "idempotencyKey");
CREATE UNIQUE INDEX "Order_tenant_customer_idempotency_key"
  ON "Order" ("tenantId", "customerId", "idempotencyKey");

CREATE INDEX "g3b_Address_serviceAreaId_tenant_idx"
  ON "Address" ("serviceAreaId", "tenantId");
CREATE INDEX "g3b_Order_bakeryCapacitySlotId_tenant_idx"
  ON "Order" ("bakeryCapacitySlotId", "tenantId");

ALTER TABLE "ServiceArea"
  ADD CONSTRAINT "g3b_ServiceArea_id_tenant_key" UNIQUE ("id", "tenantId"),
  ADD CONSTRAINT "ServiceArea_id_tenant_zone_key"
    UNIQUE ("id", "tenantId", "operationalZoneId");
ALTER TABLE "BakeryCapacitySlot"
  ADD CONSTRAINT "g3b_BakeryCapacitySlot_id_tenant_key" UNIQUE ("id", "tenantId"),
  ADD CONSTRAINT "BakeryCapacitySlot_id_tenant_branch_key"
    UNIQUE ("id", "tenantId", "bakeryBranchId");
ALTER TABLE "OperationalZone"
  ADD CONSTRAINT "OperationalZone_id_tenant_city_key"
    UNIQUE ("id", "tenantId", "cityId");

ALTER TABLE "Address"
  ADD CONSTRAINT "Address_serviceAreaId_fkey"
    FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_Address_serviceAreaId_tenant_fk"
    FOREIGN KEY ("serviceAreaId", "tenantId")
  REFERENCES "ServiceArea" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "Address_serviceArea_tenant_zone_fk"
    FOREIGN KEY ("serviceAreaId", "tenantId", "operationalZoneId")
    REFERENCES "ServiceArea" ("id", "tenantId", "operationalZoneId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_bakeryCapacitySlotId_fkey"
    FOREIGN KEY ("bakeryCapacitySlotId") REFERENCES "BakeryCapacitySlot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_Order_bakeryCapacitySlotId_tenant_fk"
    FOREIGN KEY ("bakeryCapacitySlotId", "tenantId")
  REFERENCES "BakeryCapacitySlot" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "Order_capacity_tenant_branch_fk"
    FOREIGN KEY ("bakeryCapacitySlotId", "tenantId", "bakeryBranchId")
    REFERENCES "BakeryCapacitySlot" ("id", "tenantId", "bakeryBranchId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "DeliveryPricingRule"
  ADD CONSTRAINT "DeliveryPricingRule_zone_tenant_city_fk"
    FOREIGN KEY ("operationalZoneId", "tenantId", "cityId")
    REFERENCES "OperationalZone" ("id", "tenantId", "cityId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX "DeliveryPricingRule_one_active_zone_scope_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "operationalZoneId")
  WHERE "isActive" AND "operationalZoneId" IS NOT NULL;
CREATE UNIQUE INDEX "DeliveryPricingRule_one_active_city_scope_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId")
  WHERE "isActive" AND "operationalZoneId" IS NULL;

CREATE FUNCTION protect_referenced_delivery_pricing_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Quote" WHERE "deliveryPricingRuleId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Referenced delivery pricing rules cannot be deleted';
    END IF;
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."cityId" IS DISTINCT FROM OLD."cityId"
      OR NEW."operationalZoneId" IS DISTINCT FROM OLD."operationalZoneId"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."calculationMode" IS DISTINCT FROM OLD."calculationMode"
      OR NEW."baseFeeAmount" IS DISTINCT FROM OLD."baseFeeAmount"
      OR NEW."perKilometerFeeAmount" IS DISTINCT FROM OLD."perKilometerFeeAmount"
      OR NEW."minimumOrderAmount" IS DISTINCT FROM OLD."minimumOrderAmount"
      OR NEW."freeDeliveryThreshold" IS DISTINCT FROM OLD."freeDeliveryThreshold"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
    THEN
      RAISE EXCEPTION 'Referenced delivery pricing economics are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DeliveryPricingRule_referenced_economics_immutable"
BEFORE UPDATE OR DELETE ON "DeliveryPricingRule"
FOR EACH ROW EXECUTE FUNCTION protect_referenced_delivery_pricing_rule();

-- Registered tenant-owned relations added by this migration:
--    ('Address', 'serviceAreaId', 'ServiceArea')
--    ('Order', 'bakeryCapacitySlotId', 'BakeryCapacitySlot')
