-- Cash on delivery.
--
-- In this market cash is not a fallback. For a great many customers it is the
-- only way they will buy bread from a stranger's application, and a platform
-- that cannot take it is a platform half the city cannot use.
--
-- It is also the one payment path where the money never touches the bank. A
-- courier takes a handful of notes at a door, and from that moment the platform
-- is owed that money *by the courier* — a completely different fact from money
-- sitting at a gateway. Posting the two the same way is how a delivery business
-- discovers, months later, that its cash position was never real.

CREATE TYPE "PaymentMethod" AS ENUM ('ONLINE_GATEWAY', 'CASH_ON_DELIVERY');

-- A courier handing in cash is not a payment event — the order was paid when
-- the notes changed hands — but it moves the same money from a pocket to a
-- bank, and it is a posting like any other.
ALTER TYPE "FinancialTransactionType" ADD VALUE IF NOT EXISTS 'CASH_REMITTANCE';

-- Whether a city takes cash, and on what terms.
--
-- Per city rather than per tenant because it is a market decision: a launch
-- city where nobody knows the brand yet may need cash to sell anything, and an
-- established one may be ready to stop carrying the risk. Off by default —
-- taking cash is a deliberate act, not something a city inherits.
ALTER TABLE "City"
  ADD COLUMN "cashOnDeliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cashOnDeliveryCeiling" BIGINT,
  ADD COLUMN "cashOnDeliveryMinimumOrders" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "City"
  ADD CONSTRAINT "city_cash_on_delivery_policy_check" CHECK (
    ("cashOnDeliveryCeiling" IS NULL OR "cashOnDeliveryCeiling" > 0)
    AND "cashOnDeliveryMinimumOrders" >= 0
  );

ALTER TABLE "Quote" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'ONLINE_GATEWAY';
ALTER TABLE "Order" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'ONLINE_GATEWAY';
ALTER TABLE "Payment" ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'ONLINE_GATEWAY';

-- Chart of accounts, version 2.
--
-- One account, and it is the whole reason cash needs its own version of the
-- chart: an asset that means "a courier is carrying our money", separate from
-- cash clearing, which means "money we can spend". Collapsing the two would
-- make the platform's cash position look healthy on an evening when every rial
-- of it is in twenty different jacket pockets.
--
-- Additive and separate from the v1 function rather than an edit to it. The v1
-- function ends by asserting it produced exactly fourteen accounts; changing
-- its template list in place would make that assertion fail for every tenant
-- already provisioned.
CREATE FUNCTION provision_tenant_cash_chart_v2(
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
  account_id UUID := public.financial_deterministic_uuid(
    p_tenant_id, 'chart-account-v2:COURIER_CASH_RECEIVABLE'
  );
  parent_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-account-v1:ASSETS');
  bootstrap_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-bootstrap-v2');
BEGIN
  IF char_length(p_idempotency_key) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'Financial bootstrap idempotency key is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" WHERE "id" = p_tenant_id) THEN
    RAISE EXCEPTION 'Financial bootstrap tenant does not exist';
  END IF;
  -- v2 hangs off the v1 asset root. A tenant without v1 has no tree to hang it
  -- on, and inventing one here would produce a second, silently different chart.
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount"
    WHERE "id" = parent_id AND "tenantId" = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Financial chart v2 requires v1 to be provisioned first';
  END IF;

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  INSERT INTO public."LedgerAccount" (
    "id", "tenantId", "parentId", "code", "name", "type", "currency",
    "isSystem", "isPostable", "isActive", "systemKey", "templateVersion",
    "governanceVersion", "createdAt", "updatedAt"
  ) VALUES (
    account_id, p_tenant_id, parent_id, 'A_1200_COURIER_CASH_RECEIVABLE',
    'Courier cash receivable', 'ASSET', 'IRR',
    true, true, true, 'COURIER_CASH_RECEIVABLE', 2, 1,
    p_occurred_at, p_occurred_at
  ) ON CONFLICT ("tenantId", "code") DO NOTHING;

  -- The same fail-closed check v1 makes: an account that exists but does not
  -- match the template is a chart somebody edited, and posting into it would
  -- put money somewhere nobody expects.
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount" account
    WHERE account."id" = account_id AND account."tenantId" = p_tenant_id
      AND account."parentId" = parent_id
      AND account."code" = 'A_1200_COURIER_CASH_RECEIVABLE'
      AND account."type" = 'ASSET' AND account."currency" = 'IRR'
      AND account."isSystem" AND account."isPostable"
      AND account."systemKey" = 'COURIER_CASH_RECEIVABLE'
      AND account."templateVersion" = 2
  ) THEN
    RAISE EXCEPTION 'Financial chart conflicts with reserved account A_1200_COURIER_CASH_RECEIVABLE';
  END IF;

  INSERT INTO public."LedgerAccountGovernanceEvent" (
    "id", "tenantId", "ledgerAccountId", "action", "fromActive", "toActive",
    "actorType", "version", "idempotencyKey", "reason", "correlationId", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-governance-v2:COURIER_CASH_RECEIVABLE'),
    p_tenant_id, account_id, 'PROVISIONED', NULL, true, 'SYSTEM', 1,
    'chart-v2-provisioned:COURIER_CASH_RECEIVABLE', 'System chart template v2',
    p_correlation_id, p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;

  INSERT INTO public."TenantFinancialBootstrap" (
    "id", "tenantId", "templateVersion", "accountCount", "idempotencyKey",
    "correlationId", "completedAt"
  ) VALUES (
    bootstrap_id, p_tenant_id, 2, 1, p_idempotency_key, p_correlation_id, p_occurred_at
  ) ON CONFLICT ("tenantId", "templateVersion") DO NOTHING;

  INSERT INTO public."AuditEvent" (
    "id", "tenantId", "actorType", "action", "entityType", "entityId",
    "summary", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-audit-v2'),
    p_tenant_id, 'SYSTEM', 'financial.chart.provisioned', 'LedgerAccount', account_id,
    'Provisioned system chart of accounts v2', p_correlation_id,
    jsonb_build_object('templateVersion', 2, 'accountCount', 1), p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;
END $$;

GRANT EXECUTE ON FUNCTION provision_tenant_cash_chart_v2(UUID, TEXT, UUID, TIMESTAMP) TO PUBLIC;

-- Every tenant that already exists gets the account. Additive and idempotent:
-- no journal, amount or existing account is touched.
DO $$
DECLARE tenant_record RECORD;
BEGIN
  FOR tenant_record IN SELECT "id", "createdAt" FROM "Tenant" ORDER BY "id" LOOP
    PERFORM provision_tenant_cash_chart_v2(
      tenant_record."id", 'automatic-chart-bootstrap-v2',
      financial_deterministic_uuid(tenant_record."id", 'chart-correlation-v2'),
      tenant_record."createdAt"
    );
  END LOOP;
END $$;

-- And every tenant created from now on. Replacing the trigger function rather
-- than adding a second trigger keeps the ordering explicit: v2 hangs off v1's
-- asset root, so v1 has to run first.
CREATE OR REPLACE FUNCTION provision_chart_after_tenant_insert()
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
  PERFORM public.provision_tenant_cash_chart_v2(
    NEW."id", 'automatic-chart-bootstrap-v2',
    public.financial_deterministic_uuid(NEW."id", 'chart-correlation-v2'),
    NEW."createdAt"
  );
  RETURN NEW;
END $$;

-- A courier handing in the cash they collected.
CREATE TABLE "CourierCashRemittance" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "courierId" UUID NOT NULL,
  -- Derived from the orders being settled, never typed in.
  "expectedAmount" BIGINT NOT NULL,
  -- What was actually counted onto the desk.
  "declaredAmount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  -- The staff account that counted it. A remittance nobody signed for is a
  -- remittance nobody can be asked about. Unconstrained, like every other
  -- actor id here: identity accounts are not tenant-owned, so a foreign key
  -- from a tenant-scoped table would reach across the boundary this schema
  -- spends its whole effort keeping closed.
  "countedById" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourierCashRemittance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "courier_cash_remittance_amount_check" CHECK (
    "expectedAmount" > 0 AND "declaredAmount" > 0
  ),
  CONSTRAINT "CourierCashRemittance_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CourierCashRemittance_courierId_fkey" FOREIGN KEY ("courierId")
    REFERENCES "Courier"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "CourierCashRemittance_tenant_idempotency_key"
  ON "CourierCashRemittance"("tenantId", "idempotencyKey");
CREATE INDEX "CourierCashRemittance_tenantId_occurredAt_idx"
  ON "CourierCashRemittance"("tenantId", "occurredAt");
ALTER TABLE "CourierCashRemittance"
  ADD CONSTRAINT "g3b_CourierCashRemittance_id_tenant_key" UNIQUE ("id", "tenantId");

CREATE TABLE "CourierCashRemittanceItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "remittanceId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  -- Snapshotted from the payment. What the courier was carrying for this order
  -- does not change because something was edited afterwards.
  "amount" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourierCashRemittanceItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "courier_cash_remittance_item_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "CourierCashRemittanceItem_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CourierCashRemittanceItem_remittanceId_fkey" FOREIGN KEY ("remittanceId")
    REFERENCES "CourierCashRemittance"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "CourierCashRemittanceItem_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CourierCashRemittanceItem_paymentId_fkey" FOREIGN KEY ("paymentId")
    REFERENCES "Payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- An order's cash belongs to one remittance. The ledger enforces the same thing
-- through its unique posting per payment; this says it where an operator can be
-- told about it before any money moves.
CREATE UNIQUE INDEX "CourierCashRemittanceItem_tenant_order_key"
  ON "CourierCashRemittanceItem"("tenantId", "orderId");
CREATE INDEX "CourierCashRemittanceItem_remittanceId_idx"
  ON "CourierCashRemittanceItem"("remittanceId");
ALTER TABLE "CourierCashRemittanceItem"
  ADD CONSTRAINT "g3b_CourierCashRemittanceItem_id_tenant_key" UNIQUE ("id", "tenantId");

-- Row-level security, forced, on the same terms as every other tenant-owned
-- table: the tenant is read from the session variable, and a connection that
-- has not set one sees nothing at all.
ALTER TABLE "CourierCashRemittance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourierCashRemittance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CourierCashRemittance"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "CourierCashRemittanceItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourierCashRemittanceItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CourierCashRemittanceItem"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Composite tenant foreign keys.
--
-- Every one of these says the same thing: a child row and the parent it points
-- at belong to the same tenant. A plain foreign key cannot say that, and
-- without it a row could reference a parent in another tenant that row-level
-- security would then happily hide — leaving a dangling pointer nobody can see
-- to diagnose.
ALTER TABLE "CourierCashRemittance"
  ADD CONSTRAINT "g3b_CourierCashRemittance_courierId_tenant_fk"
  FOREIGN KEY ("courierId", "tenantId")
  REFERENCES "Courier" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CourierCashRemittance_courierId_tenant_idx"
  ON "CourierCashRemittance"("courierId", "tenantId");

ALTER TABLE "CourierCashRemittanceItem"
  ADD CONSTRAINT "g3b_CourierCashRemittanceItem_remittanceId_tenant_fk"
  FOREIGN KEY ("remittanceId", "tenantId")
  REFERENCES "CourierCashRemittance" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CourierCashRemittanceItem_remittanceId_tenant_idx"
  ON "CourierCashRemittanceItem"("remittanceId", "tenantId");

ALTER TABLE "CourierCashRemittanceItem"
  ADD CONSTRAINT "g3b_CourierCashRemittanceItem_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CourierCashRemittanceItem_orderId_tenant_idx"
  ON "CourierCashRemittanceItem"("orderId", "tenantId");

ALTER TABLE "CourierCashRemittanceItem"
  ADD CONSTRAINT "g3b_CourierCashRemittanceItem_paymentId_tenant_fk"
  FOREIGN KEY ("paymentId", "tenantId")
  REFERENCES "Payment" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CourierCashRemittanceItem_paymentId_tenant_idx"
  ON "CourierCashRemittanceItem"("paymentId", "tenantId");

-- The posting guard has to learn what a remittance is.
--
-- It refuses any transaction type it does not recognise, which is the right
-- default and is why this cannot be left alone: without the new branch every
-- remittance would be rejected at write time with a message about balance,
-- which is not what would actually be wrong.
--
-- A remittance belongs to a payment that was captured on a paid order — the
-- cash was collected at the door before any of it could be handed in — so it
-- shares the capture's state rule. Everything else about the posting (balanced,
-- two accounts, right tenant and currency, amount equal to the payment) is
-- checked below exactly as before.
CREATE OR REPLACE FUNCTION enforce_financial_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_transaction_id UUID; transaction_amount BIGINT; transaction_currency "Currency";
  transaction_tenant UUID; transaction_payment UUID; transaction_order UUID;
  transaction_type "FinancialTransactionType";
  payment_amount BIGINT; payment_currency "Currency"; payment_state "PaymentAggregateState";
  payment_order UUID; order_payment_state "PaymentState"; entry_count INTEGER;
  distinct_account_count INTEGER; debit_total BIGINT; credit_total BIGINT; invalid_entry_count INTEGER;
  states_agree BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'FinancialTransaction' THEN target_transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_transaction_id := OLD."financialTransactionId";
  ELSE target_transaction_id := NEW."financialTransactionId"; END IF;
  SELECT tx."amount", tx."currency", tx."tenantId", tx."paymentId", tx."orderId", tx."type",
         p."amount", p."currency", p."state", p."orderId", o."paymentState"
  INTO transaction_amount, transaction_currency, transaction_tenant, transaction_payment,
       transaction_order, transaction_type,
       payment_amount, payment_currency, payment_state, payment_order, order_payment_state
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

  -- A capture belongs to a captured payment on a paid order. A refund belongs
  -- to a refunded one. A cash remittance belongs to a captured payment too: the
  -- money was taken at the door long before anybody carried it back to a desk.
  states_agree := CASE transaction_type
    WHEN 'PAYMENT_CAPTURE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'   THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
    WHEN 'CASH_REMITTANCE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    ELSE FALSE
  END;

  IF NOT states_agree
     OR payment_order <> transaction_order OR payment_amount <> transaction_amount
     OR payment_currency <> transaction_currency OR entry_count < 2
     OR distinct_account_count < 2 OR invalid_entry_count <> 0
     OR debit_total <> credit_total OR debit_total <> transaction_amount
  THEN RAISE EXCEPTION 'Financial transaction must be a balanced double-entry posting matching its payment state'; END IF;
  RETURN NULL;
END $$;

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('CourierCashRemittance', 'courierId', 'Courier')
--    ('CourierCashRemittanceItem', 'remittanceId', 'CourierCashRemittance')
--    ('CourierCashRemittanceItem', 'orderId', 'Order')
--    ('CourierCashRemittanceItem', 'paymentId', 'Payment')
