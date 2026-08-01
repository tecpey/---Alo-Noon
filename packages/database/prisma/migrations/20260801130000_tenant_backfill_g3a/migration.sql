-- Phase G3A: verified backfill of all pre-tenancy Alo Noon business rows.
-- This migration is intentionally data-only. G3B adds composite parent/child
-- tenant constraints after the backfill evidence is proven in CI.
--
-- Rollback policy: do not clear tenantId after this migration. Roll forward with
-- a reviewed corrective migration so tenant ownership evidence is preserved.

DO $$
DECLARE
  internal_tenant_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  target_table TEXT;
  total_before BIGINT;
  null_before BIGINT;
  updated_rows BIGINT;
  null_after BIGINT;
  foreign_tenant_rows BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Tenant"
    WHERE "id" = internal_tenant_id
      AND "slug" = 'alo-noon-internal'
      AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'G3A aborted: stable active internal tenant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "TenantDomain"
    WHERE "tenantId" = internal_tenant_id
      AND "host" = 'alonon.ir'
      AND "isPrimary" = true
  ) THEN
    RAISE EXCEPTION 'G3A aborted: internal tenant primary domain is missing';
  END IF;

  CREATE TEMP TABLE g3a_tenant_tables (
    table_name TEXT PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO g3a_tenant_tables (table_name)
  VALUES
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
    ('CourierPartner'),
    ('Courier'),
    ('Vehicle'),
    ('DeliveryTask'),
    ('DeliveryAssignment'),
    ('Fulfillment'),
    ('CustomerEvent'),
    ('SupportCase'),
    ('DomainEventOutbox'),
    ('AuditEvent');

  FOR target_table IN
    SELECT table_name FROM g3a_tenant_tables ORDER BY table_name
  LOOP
    EXECUTE format(
      'SELECT count(*), count(*) FILTER (WHERE "tenantId" IS NULL), count(*) FILTER (WHERE "tenantId" IS NOT NULL AND "tenantId" <> $1) FROM %I',
      target_table
    )
    INTO total_before, null_before, foreign_tenant_rows
    USING internal_tenant_id;

    IF foreign_tenant_rows <> 0 THEN
      RAISE EXCEPTION
        'G3A aborted: table % contains % rows assigned to another tenant',
        target_table,
        foreign_tenant_rows;
    END IF;

    EXECUTE format(
      'UPDATE %I SET "tenantId" = $1 WHERE "tenantId" IS NULL',
      target_table
    )
    USING internal_tenant_id;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows <> null_before THEN
      RAISE EXCEPTION
        'G3A verification failed for %: expected to update %, updated %',
        target_table,
        null_before,
        updated_rows;
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "tenantId" IS NULL',
      target_table
    )
    INTO null_after;

    IF null_after <> 0 THEN
      RAISE EXCEPTION
        'G3A verification failed for %: % tenant-less rows remain',
        target_table,
        null_after;
    END IF;

    RAISE NOTICE
      'G3A verified table=% total_before=% null_before=% updated=% null_after=%',
      target_table,
      total_before,
      null_before,
      updated_rows,
      null_after;
  END LOOP;
END
$$;
