-- Phase G5: make tenant ownership mandatory and enforce PostgreSQL RLS.
-- Preconditions: G3A proved backfill completeness, G3B proved relational integrity,
-- and G4 made all application writes tenant-aware.

DO $$
DECLARE
  tenant_table text;
  null_count bigint;
BEGIN
  FOR tenant_table IN
    SELECT table_name
    FROM (VALUES
    ('City'),
    ('OperationalZone'),
    ('ServiceArea'),
    ('Customer'),
    ('Household'),
    ('HouseholdMember'),
    ('Address'),
    ('Bakery'),
    ('BakeryBranch'),
    ('BakeryOperatingHours'),
    ('BakeryCapacitySlot'),
    ('ProductCategory'),
    ('Product'),
    ('ProductVariant'),
    ('BakeryProductOffering'),
    ('Cart'),
    ('CartItem'),
    ('Quote'),
    ('QuoteItem'),
    ('Order'),
    ('OrderItem'),
    ('OrderStateTransition'),
    ('Fulfillment'),
    ('CourierPartner'),
    ('Courier'),
    ('Vehicle'),
    ('DeliveryTask'),
    ('DeliveryAssignment'),
    ('CustomerEvent'),
    ('DomainEventOutbox'),
    ('AuditEvent'),
    ('SupportCase')
    ) AS owned(table_name)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', tenant_table)
      INTO null_count;
    IF null_count <> 0 THEN
      RAISE EXCEPTION 'G5 aborted: %.tenantId contains % null rows', tenant_table, null_count;
    END IF;
  END LOOP;

  SELECT count(*) INTO null_count
  FROM "AuthSession"
  WHERE "activeTenantId" IS NULL;
  IF null_count <> 0 THEN
    RAISE EXCEPTION 'G5 aborted: AuthSession.activeTenantId contains % null rows', null_count;
  END IF;
END
$$;

ALTER TABLE "City" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "OperationalZone" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ServiceArea" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Household" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "HouseholdMember" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Bakery" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BakeryBranch" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BakeryOperatingHours" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BakeryCapacitySlot" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ProductCategory" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ProductVariant" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BakeryProductOffering" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Cart" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CartItem" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Quote" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "QuoteItem" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "OrderItem" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "OrderStateTransition" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Fulfillment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CourierPartner" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Courier" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Vehicle" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "DeliveryTask" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "DeliveryAssignment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CustomerEvent" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "DomainEventOutbox" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AuditEvent" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SupportCase" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AuthSession" ALTER COLUMN "activeTenantId" SET NOT NULL;
ALTER TABLE "AuthSession" DROP CONSTRAINT "AuthSession_activeTenantId_fkey";
ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_activeTenantId_fkey"
  FOREIGN KEY ("activeTenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOR tenant_table IN
    SELECT table_name
    FROM (VALUES
    ('City'),
    ('OperationalZone'),
    ('ServiceArea'),
    ('Customer'),
    ('Household'),
    ('HouseholdMember'),
    ('Address'),
    ('Bakery'),
    ('BakeryBranch'),
    ('BakeryOperatingHours'),
    ('BakeryCapacitySlot'),
    ('ProductCategory'),
    ('Product'),
    ('ProductVariant'),
    ('BakeryProductOffering'),
    ('Cart'),
    ('CartItem'),
    ('Quote'),
    ('QuoteItem'),
    ('Order'),
    ('OrderItem'),
    ('OrderStateTransition'),
    ('Fulfillment'),
    ('CourierPartner'),
    ('Courier'),
    ('Vehicle'),
    ('DeliveryTask'),
    ('DeliveryAssignment'),
    ('CustomerEvent'),
    ('DomainEventOutbox'),
    ('AuditEvent'),
    ('SupportCase')
    ) AS owned(table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END
$$;
