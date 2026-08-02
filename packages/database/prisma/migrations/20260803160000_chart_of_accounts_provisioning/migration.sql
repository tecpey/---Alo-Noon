-- Additive financial-operations foundation. The migration provisions only
-- deterministic account structure; it does not rewrite entries or economic values.

-- Fail closed before structural DDL if a tenant already uses a reserved v1 code.
DO $$
DECLARE conflicting_code TEXT;
BEGIN
  SELECT account."code" INTO conflicting_code
  FROM "LedgerAccount" account
  WHERE account."code" IN (
    'A_1000', 'A_1100_CASH_CLEARING', 'L_2000', 'L_2100_PAYMENT_CLEARING',
    'L_2200_BAKERY_PAYABLE', 'L_2300_COURIER_PAYABLE', 'E_3000',
    'E_3100_RETAINED_EARNINGS', 'R_4000', 'R_4100_PRODUCT_SALES',
    'R_4200_DELIVERY', 'X_5000', 'X_5100_DELIVERY', 'X_5200_PAYMENT_PROCESSING'
  )
  LIMIT 1;
  IF conflicting_code IS NOT NULL THEN
    RAISE EXCEPTION 'Chart provisioning preflight failed: reserved account code % is already in use', conflicting_code;
  END IF;
END $$;

CREATE TYPE "LedgerAccountGovernanceAction" AS ENUM (
  'PROVISIONED', 'ACTIVATED', 'DEACTIVATED'
);

ALTER TABLE "LedgerAccount"
  ADD COLUMN "parentId" UUID,
  ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isPostable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "systemKey" VARCHAR(64),
  ADD COLUMN "templateVersion" INTEGER,
  ADD COLUMN "governanceVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "LedgerAccount_template_check" CHECK (
    (NOT "isSystem" AND "systemKey" IS NULL AND "templateVersion" IS NULL) OR
    ("isSystem" AND "systemKey" IS NOT NULL AND "templateVersion" > 0)
  ),
  ADD CONSTRAINT "LedgerAccount_governance_version_check" CHECK ("governanceVersion" >= 0),
  ADD CONSTRAINT "LedgerAccount_parent_self_check" CHECK ("parentId" IS NULL OR "parentId" <> "id");

CREATE TABLE "TenantFinancialBootstrap" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "templateVersion" INTEGER NOT NULL,
  "accountCount" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantFinancialBootstrap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantFinancialBootstrap_version_check" CHECK ("templateVersion" > 0),
  CONSTRAINT "TenantFinancialBootstrap_count_check" CHECK ("accountCount" > 0),
  CONSTRAINT "TenantFinancialBootstrap_idempotency_check" CHECK (
    char_length("idempotencyKey") BETWEEN 16 AND 128
  )
);

CREATE TABLE "LedgerAccountGovernanceEvent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "ledgerAccountId" UUID NOT NULL,
  "action" "LedgerAccountGovernanceAction" NOT NULL,
  "fromActive" BOOLEAN,
  "toActive" BOOLEAN NOT NULL,
  "actorType" "ActorType" NOT NULL,
  "actorId" UUID,
  "version" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerAccountGovernanceEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerGovernance_version_check" CHECK ("version" > 0),
  CONSTRAINT "LedgerGovernance_idempotency_check" CHECK (
    char_length("idempotencyKey") BETWEEN 16 AND 128
  ),
  CONSTRAINT "LedgerGovernance_reason_check" CHECK (char_length(trim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "LedgerGovernance_authority_check" CHECK (
    ("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR
    ("actorType" = 'STAFF' AND "actorId" IS NOT NULL)
  ),
  CONSTRAINT "LedgerGovernance_state_check" CHECK (
    ("action" = 'PROVISIONED' AND "fromActive" IS NULL AND "toActive" AND "version" = 1 AND "actorType" = 'SYSTEM') OR
    ("action" = 'ACTIVATED' AND NOT "fromActive" AND "toActive") OR
    ("action" = 'DEACTIVATED' AND "fromActive" AND NOT "toActive")
  )
);

CREATE UNIQUE INDEX "LedgerAccount_tenant_system_key"
  ON "LedgerAccount" ("tenantId", "systemKey");
CREATE INDEX "g3b_LedgerAccount_parentId_tenant_idx"
  ON "LedgerAccount" ("parentId", "tenantId");
CREATE INDEX "LedgerAccount_tenant_system_postable_active_idx"
  ON "LedgerAccount" ("tenantId", "isSystem", "isPostable", "isActive");

CREATE UNIQUE INDEX "TenantFinancialBootstrap_tenant_version_key"
  ON "TenantFinancialBootstrap" ("tenantId", "templateVersion");
CREATE UNIQUE INDEX "TenantFinancialBootstrap_tenant_idempotency_key"
  ON "TenantFinancialBootstrap" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_TenantFinancialBootstrap_id_tenant_key"
  ON "TenantFinancialBootstrap" ("id", "tenantId");
CREATE INDEX "TenantFinancialBootstrap_tenant_completedAt_idx"
  ON "TenantFinancialBootstrap" ("tenantId", "completedAt");

CREATE UNIQUE INDEX "LedgerGovernance_scoped_idempotency_key"
  ON "LedgerAccountGovernanceEvent" ("tenantId", "ledgerAccountId", "idempotencyKey");
CREATE UNIQUE INDEX "LedgerGovernance_account_version_key"
  ON "LedgerAccountGovernanceEvent" ("ledgerAccountId", "version");
CREATE UNIQUE INDEX "g3b_LedgerAccountGovernanceEvent_id_tenant_key"
  ON "LedgerAccountGovernanceEvent" ("id", "tenantId");
CREATE INDEX "g3b_LedgerAccountGovernanceEvent_ledgerAccountId_tenant_idx"
  ON "LedgerAccountGovernanceEvent" ("ledgerAccountId", "tenantId");
CREATE INDEX "LedgerAccountGovernanceEvent_tenant_correlation_idx"
  ON "LedgerAccountGovernanceEvent" ("tenantId", "correlationId");

ALTER TABLE "LedgerAccount"
  ADD CONSTRAINT "LedgerAccount_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "LedgerAccount" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_LedgerAccount_parentId_tenant_fk"
    FOREIGN KEY ("parentId", "tenantId")
  REFERENCES "LedgerAccount" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "LedgerAccountGovernanceEvent"
  ADD CONSTRAINT "LedgerAccountGovernanceEvent_ledgerAccountId_fkey"
    FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_LedgerAccountGovernanceEvent_ledgerAccountId_tenant_fk"
    FOREIGN KEY ("ledgerAccountId", "tenantId")
  REFERENCES "LedgerAccount" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "TenantFinancialBootstrap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantFinancialBootstrap" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenantFinancialBootstrap"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "LedgerAccountGovernanceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerAccountGovernanceEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LedgerAccountGovernanceEvent"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION financial_deterministic_uuid(p_tenant_id UUID, p_value TEXT)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT (
    substr(md5(p_tenant_id::text || ':' || p_value), 1, 8) || '-' ||
    substr(md5(p_tenant_id::text || ':' || p_value), 9, 4) || '-4' ||
    substr(md5(p_tenant_id::text || ':' || p_value), 14, 3) || '-8' ||
    substr(md5(p_tenant_id::text || ':' || p_value), 18, 3) || '-' ||
    substr(md5(p_tenant_id::text || ':' || p_value), 21, 12)
  )::uuid
$$;

CREATE FUNCTION provision_tenant_financial_chart(
  p_tenant_id UUID,
  p_idempotency_key TEXT,
  p_correlation_id UUID,
  p_occurred_at TIMESTAMP(3)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prior_tenant TEXT := current_setting('app.tenant_id', true);
  template RECORD;
  account_id UUID;
  parent_id UUID;
  bootstrap_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-bootstrap-v1');
  template_count CONSTANT INTEGER := 14;
BEGIN
  IF char_length(p_idempotency_key) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'Financial bootstrap idempotency key is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" WHERE "id" = p_tenant_id) THEN
    RAISE EXCEPTION 'Financial bootstrap tenant does not exist';
  END IF;

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  FOR template IN
    SELECT * FROM (VALUES
      ('ASSETS', 'A_1000', 'Assets', 'ASSET'::public."LedgerAccountType", NULL::TEXT, false),
      ('CASH_CLEARING', 'A_1100_CASH_CLEARING', 'Cash clearing', 'ASSET'::public."LedgerAccountType", 'ASSETS', true),
      ('LIABILITIES', 'L_2000', 'Liabilities', 'LIABILITY'::public."LedgerAccountType", NULL::TEXT, false),
      ('PAYMENT_CLEARING', 'L_2100_PAYMENT_CLEARING', 'Payment clearing', 'LIABILITY'::public."LedgerAccountType", 'LIABILITIES', true),
      ('BAKERY_PAYABLE', 'L_2200_BAKERY_PAYABLE', 'Bakery payable', 'LIABILITY'::public."LedgerAccountType", 'LIABILITIES', true),
      ('COURIER_PAYABLE', 'L_2300_COURIER_PAYABLE', 'Courier payable', 'LIABILITY'::public."LedgerAccountType", 'LIABILITIES', true),
      ('EQUITY', 'E_3000', 'Equity', 'EQUITY'::public."LedgerAccountType", NULL::TEXT, false),
      ('RETAINED_EARNINGS', 'E_3100_RETAINED_EARNINGS', 'Retained earnings', 'EQUITY'::public."LedgerAccountType", 'EQUITY', true),
      ('REVENUE', 'R_4000', 'Revenue', 'REVENUE'::public."LedgerAccountType", NULL::TEXT, false),
      ('PRODUCT_SALES_REVENUE', 'R_4100_PRODUCT_SALES', 'Product sales revenue', 'REVENUE'::public."LedgerAccountType", 'REVENUE', true),
      ('DELIVERY_REVENUE', 'R_4200_DELIVERY', 'Delivery revenue', 'REVENUE'::public."LedgerAccountType", 'REVENUE', true),
      ('EXPENSES', 'X_5000', 'Expenses', 'EXPENSE'::public."LedgerAccountType", NULL::TEXT, false),
      ('DELIVERY_EXPENSE', 'X_5100_DELIVERY', 'Delivery expense', 'EXPENSE'::public."LedgerAccountType", 'EXPENSES', true),
      ('PAYMENT_PROCESSING_EXPENSE', 'X_5200_PAYMENT_PROCESSING', 'Payment processing expense', 'EXPENSE'::public."LedgerAccountType", 'EXPENSES', true)
    ) AS chart(system_key, code, name, account_type, parent_key, is_postable)
  LOOP
    account_id := public.financial_deterministic_uuid(p_tenant_id, 'chart-account-v1:' || template.system_key);
    parent_id := CASE WHEN template.parent_key IS NULL THEN NULL
      ELSE public.financial_deterministic_uuid(p_tenant_id, 'chart-account-v1:' || template.parent_key)
    END;

    INSERT INTO public."LedgerAccount" (
      "id", "tenantId", "parentId", "code", "name", "type", "currency",
      "isSystem", "isPostable", "isActive", "systemKey", "templateVersion",
      "governanceVersion", "createdAt", "updatedAt"
    ) VALUES (
      account_id, p_tenant_id, parent_id, template.code, template.name, template.account_type,
      'IRR', true, template.is_postable, true, template.system_key, 1, 1,
      p_occurred_at, p_occurred_at
    ) ON CONFLICT ("tenantId", "code") DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM public."LedgerAccount" account
      WHERE account."id" = account_id AND account."tenantId" = p_tenant_id
        AND account."parentId" IS NOT DISTINCT FROM parent_id
        AND account."code" = template.code AND account."name" = template.name
        AND account."type" = template.account_type AND account."currency" = 'IRR'
        AND account."isSystem" AND account."isPostable" = template.is_postable
        AND account."systemKey" = template.system_key AND account."templateVersion" = 1
    ) THEN
      RAISE EXCEPTION 'Financial chart conflicts with reserved account %', template.code;
    END IF;

    INSERT INTO public."LedgerAccountGovernanceEvent" (
      "id", "tenantId", "ledgerAccountId", "action", "fromActive", "toActive",
      "actorType", "version", "idempotencyKey", "reason", "correlationId", "occurredAt"
    ) VALUES (
      public.financial_deterministic_uuid(p_tenant_id, 'chart-governance-v1:' || template.system_key),
      p_tenant_id, account_id, 'PROVISIONED', NULL, true, 'SYSTEM', 1,
      'chart-v1-provisioned:' || template.system_key, 'System chart template v1',
      p_correlation_id, p_occurred_at
    ) ON CONFLICT ("id") DO NOTHING;
  END LOOP;

  INSERT INTO public."TenantFinancialBootstrap" (
    "id", "tenantId", "templateVersion", "accountCount", "idempotencyKey",
    "correlationId", "completedAt"
  ) VALUES (
    bootstrap_id, p_tenant_id, 1, template_count, p_idempotency_key,
    p_correlation_id, p_occurred_at
  ) ON CONFLICT ("tenantId", "templateVersion") DO NOTHING;

  IF (SELECT COUNT(*) FROM public."LedgerAccount"
      WHERE "tenantId" = p_tenant_id AND "isSystem" AND "templateVersion" = 1) <> template_count
  THEN RAISE EXCEPTION 'Financial chart v1 is incomplete'; END IF;

  INSERT INTO public."AuditEvent" (
    "id", "tenantId", "actorType", "action", "entityType", "entityId",
    "summary", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-audit-v1'), p_tenant_id,
    'SYSTEM', 'financial.chart_provisioned', 'tenant_financial_bootstrap', bootstrap_id,
    'Deterministic system chart of accounts v1 provisioned', p_correlation_id,
    jsonb_build_object('templateVersion', 1, 'accountCount', template_count), p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;

  INSERT INTO public."DomainEventOutbox" (
    "id", "tenantId", "eventId", "name", "version", "aggregateType", "aggregateId",
    "actorType", "correlationId", "consentBasis", "payload", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-outbox-row-v1'), p_tenant_id,
    public.financial_deterministic_uuid(p_tenant_id, 'chart-event-v1'),
    'financial.chart_provisioned', 1, 'tenant_financial_bootstrap', bootstrap_id,
    'SYSTEM', p_correlation_id, 'TRANSACTIONAL',
    jsonb_build_object('tenantId', p_tenant_id, 'templateVersion', 1, 'accountCount', template_count),
    p_occurred_at
  ) ON CONFLICT ("eventId") DO NOTHING;

  PERFORM set_config('app.tenant_id', COALESCE(prior_tenant, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.tenant_id', COALESCE(prior_tenant, ''), true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION financial_deterministic_uuid(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_tenant_financial_chart(UUID, TEXT, UUID, TIMESTAMP) FROM PUBLIC;

CREATE FUNCTION request_tenant_financial_chart(
  p_tenant_id UUID,
  p_idempotency_key TEXT,
  p_correlation_id UUID,
  p_occurred_at TIMESTAMP(3)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Financial bootstrap tenant context mismatch';
  END IF;
  PERFORM public.provision_tenant_financial_chart(
    p_tenant_id, p_idempotency_key, p_correlation_id, p_occurred_at
  );
END $$;
GRANT EXECUTE ON FUNCTION request_tenant_financial_chart(UUID, TEXT, UUID, TIMESTAMP) TO PUBLIC;

-- Provision every existing tenant. The function is naturally idempotent and
-- inserts structural templates only; existing journals and amounts are untouched.
DO $$
DECLARE tenant_record RECORD;
BEGIN
  FOR tenant_record IN SELECT "id", "createdAt" FROM "Tenant" ORDER BY "id" LOOP
    PERFORM provision_tenant_financial_chart(
      tenant_record."id", 'automatic-chart-bootstrap-v1',
      financial_deterministic_uuid(tenant_record."id", 'chart-correlation-v1'),
      tenant_record."createdAt"
    );
  END LOOP;
END $$;

CREATE FUNCTION provision_chart_after_tenant_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.provision_tenant_financial_chart(
    NEW."id", 'automatic-chart-bootstrap-v1',
    public.financial_deterministic_uuid(NEW."id", 'chart-correlation-v1'),
    NEW."createdAt"
  );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION provision_chart_after_tenant_insert() FROM PUBLIC;

CREATE TRIGGER "Tenant_financial_chart_bootstrap"
AFTER INSERT ON "Tenant"
FOR EACH ROW EXECUTE FUNCTION provision_chart_after_tenant_insert();

CREATE FUNCTION enforce_ledger_account_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent_record RECORD;
BEGIN
  IF NEW."parentId" IS NULL THEN
    IF NEW."isSystem" AND NEW."isPostable" THEN
      RAISE EXCEPTION 'System root accounts must be non-postable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "tenantId", "type", "currency", "isSystem", "isPostable"
  INTO parent_record FROM "LedgerAccount" WHERE "id" = NEW."parentId";
  IF NOT FOUND OR parent_record."tenantId" <> NEW."tenantId"
     OR parent_record."type" <> NEW."type" OR parent_record."currency" <> NEW."currency"
     OR parent_record."isPostable" OR (NEW."isSystem" AND NOT parent_record."isSystem")
  THEN RAISE EXCEPTION 'Ledger account parent must be a same-tenant header of the same type and currency'; END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors("id", "parentId") AS (
      SELECT account."id", account."parentId" FROM "LedgerAccount" account WHERE account."id" = NEW."parentId"
      UNION ALL
      SELECT account."id", account."parentId" FROM "LedgerAccount" account
      JOIN ancestors ON account."id" = ancestors."parentId"
    ) SELECT 1 FROM ancestors WHERE "id" = NEW."id"
  ) THEN RAISE EXCEPTION 'Ledger account hierarchy cannot contain cycles'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "LedgerAccount_hierarchy_guard"
BEFORE INSERT OR UPDATE OF "parentId", "tenantId", "type", "currency", "isSystem", "isPostable"
ON "LedgerAccount" FOR EACH ROW EXECUTE FUNCTION enforce_ledger_account_hierarchy();

CREATE OR REPLACE FUNCTION protect_ledger_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Ledger accounts cannot be deleted'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."parentId" IS DISTINCT FROM OLD."parentId"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."isSystem" IS DISTINCT FROM OLD."isSystem"
    OR NEW."isPostable" IS DISTINCT FROM OLD."isPostable"
    OR NEW."systemKey" IS DISTINCT FROM OLD."systemKey"
    OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
    OR (OLD."isSystem" AND NEW."name" IS DISTINCT FROM OLD."name")
  THEN RAISE EXCEPTION 'Ledger account identity is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_ledger_governance_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_account_id UUID; account_active BOOLEAN; governance_version INTEGER;
  event_count INTEGER; first_version INTEGER; latest_active BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'LedgerAccount' THEN target_account_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_account_id := OLD."ledgerAccountId";
  ELSE target_account_id := NEW."ledgerAccountId"; END IF;
  SELECT "isActive", "governanceVersion" INTO account_active, governance_version
  FROM "LedgerAccount" WHERE "id" = target_account_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COUNT(*), MIN("version"), (ARRAY_AGG("toActive" ORDER BY "version" DESC))[1]
  INTO event_count, first_version, latest_active FROM "LedgerAccountGovernanceEvent"
  WHERE "ledgerAccountId" = target_account_id;
  IF governance_version = 0 THEN
    IF event_count <> 0 THEN RAISE EXCEPTION 'Ungoverned account cannot have governance history'; END IF;
  ELSIF event_count <> governance_version OR first_version <> 1 OR latest_active IS DISTINCT FROM account_active THEN
    RAISE EXCEPTION 'Ledger account state must match contiguous governance history';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT "version", "fromActive", LAG("toActive") OVER (ORDER BY "version") previous_active
      FROM "LedgerAccountGovernanceEvent" WHERE "ledgerAccountId" = target_account_id
    ) history WHERE "version" > 1 AND "fromActive" IS DISTINCT FROM previous_active
  ) THEN RAISE EXCEPTION 'Ledger account governance history is not contiguous'; END IF;
  IF EXISTS (
    SELECT 1 FROM "LedgerAccountGovernanceEvent" event
    WHERE event."ledgerAccountId" = target_account_id AND event."action" <> 'PROVISIONED'
      AND (
        NOT EXISTS (
          SELECT 1 FROM "AuditEvent" audit
          WHERE audit."tenantId" = event."tenantId"
            AND audit."entityId" = event."ledgerAccountId"
            AND audit."action" = 'financial.ledger_account_state_changed'
            AND audit."correlationId" = event."correlationId"
        )
        OR NOT EXISTS (
          SELECT 1 FROM "DomainEventOutbox" outbox
          WHERE outbox."tenantId" = event."tenantId" AND outbox."eventId" = event."id"
            AND outbox."name" = 'financial.ledger_account_state_changed'
        )
      )
  ) THEN RAISE EXCEPTION 'Ledger governance changes require committed audit and outbox records'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "LedgerAccount_governance_consistency"
AFTER INSERT OR UPDATE ON "LedgerAccount"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_ledger_governance_history();
CREATE CONSTRAINT TRIGGER "LedgerGovernance_history_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "LedgerAccountGovernanceEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_ledger_governance_history();

CREATE FUNCTION enforce_active_account_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."isActive" AND NEW."parentId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "LedgerAccount" parent WHERE parent."id" = NEW."parentId" AND NOT parent."isActive"
  ) THEN RAISE EXCEPTION 'Active ledger account requires an active parent'; END IF;
  IF NOT NEW."isActive" AND EXISTS (
    SELECT 1 FROM "LedgerAccount" child WHERE child."parentId" = NEW."id" AND child."isActive"
  ) THEN RAISE EXCEPTION 'Ledger account with active children cannot be deactivated'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "LedgerAccount_active_hierarchy"
AFTER INSERT OR UPDATE OF "isActive" ON "LedgerAccount"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_active_account_hierarchy();

CREATE TRIGGER "LedgerGovernance_append_only"
BEFORE UPDATE OR DELETE ON "LedgerAccountGovernanceEvent"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

-- Header accounts are structural only and can never receive ledger entries.
CREATE OR REPLACE FUNCTION enforce_financial_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_transaction_id UUID; transaction_amount BIGINT; transaction_currency "Currency";
  transaction_tenant UUID; transaction_payment UUID; transaction_order UUID;
  payment_amount BIGINT; payment_currency "Currency"; payment_state "PaymentAggregateState";
  payment_order UUID; order_payment_state "PaymentState"; entry_count INTEGER;
  distinct_account_count INTEGER; debit_total BIGINT; credit_total BIGINT; invalid_entry_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'FinancialTransaction' THEN target_transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_transaction_id := OLD."financialTransactionId";
  ELSE target_transaction_id := NEW."financialTransactionId"; END IF;
  SELECT tx."amount", tx."currency", tx."tenantId", tx."paymentId", tx."orderId",
         p."amount", p."currency", p."state", p."orderId", o."paymentState"
  INTO transaction_amount, transaction_currency, transaction_tenant, transaction_payment,
       transaction_order, payment_amount, payment_currency, payment_state, payment_order, order_payment_state
  FROM "FinancialTransaction" tx JOIN "Payment" p ON p."id" = tx."paymentId"
  JOIN "Order" o ON o."id" = tx."orderId" WHERE tx."id" = target_transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COUNT(*), COUNT(DISTINCT entry."ledgerAccountId"),
    COALESCE(SUM(entry."amount") FILTER (WHERE entry."side" = 'DEBIT'), 0),
    COALESCE(SUM(entry."amount") FILTER (WHERE entry."side" = 'CREDIT'), 0),
    COUNT(*) FILTER (WHERE entry."tenantId" <> transaction_tenant
      OR entry."currency" <> transaction_currency OR account."currency" <> transaction_currency
      OR NOT account."isActive" OR NOT account."isPostable")
  INTO entry_count, distinct_account_count, debit_total, credit_total, invalid_entry_count
  FROM "LedgerEntry" entry JOIN "LedgerAccount" account ON account."id" = entry."ledgerAccountId"
  WHERE entry."financialTransactionId" = target_transaction_id;
  IF payment_state <> 'CAPTURED' OR order_payment_state <> 'PAID'
     OR payment_order <> transaction_order OR payment_amount <> transaction_amount
     OR payment_currency <> transaction_currency OR entry_count < 2
     OR distinct_account_count < 2 OR invalid_entry_count <> 0
     OR debit_total <> credit_total OR debit_total <> transaction_amount
  THEN RAISE EXCEPTION 'Financial transaction must be a captured, balanced double-entry posting'; END IF;
  RETURN NULL;
END $$;

-- Registered tenant-owned relations added by this migration:
--    ('LedgerAccount', 'parentId', 'LedgerAccount')
--    ('LedgerAccountGovernanceEvent', 'ledgerAccountId', 'LedgerAccount')
