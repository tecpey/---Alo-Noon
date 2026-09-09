-- The account that says what the platform owes its customers.
--
-- A wallet balance is money the platform is holding and has not earned. Until
-- it is spent on bread or handed back, it is a liability — and it has to be its
-- own liability, separate from payment clearing, because the two are owed to
-- different people. Payment clearing is what is owed to the bakery and the
-- courier for work in progress. This is what is owed to the customer for work
-- not started.
--
-- Collapsing them would make a morning look identical whether a hundred
-- customers had topped up or a hundred orders were awaiting delivery, and those
-- are opposite situations: one is money the business can plan around, the other
-- is a queue of obligations it has to work off today.
--
-- Chart v3, additive and separate from v1 for the reason v2 was: the v1
-- function ends by asserting it produced exactly fourteen accounts, and editing
-- its template list in place would make that assertion fail for every tenant
-- already provisioned.

CREATE FUNCTION provision_tenant_wallet_chart_v3(
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
    p_tenant_id, 'chart-account-v3:CUSTOMER_WALLET'
  );
  parent_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-account-v1:LIABILITIES');
  bootstrap_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-bootstrap-v3');
BEGIN
  IF char_length(p_idempotency_key) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'Financial bootstrap idempotency key is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" WHERE "id" = p_tenant_id) THEN
    RAISE EXCEPTION 'Financial bootstrap tenant does not exist';
  END IF;
  -- v3 hangs off the v1 liability root. A tenant without v1 has no tree to hang
  -- it on, and inventing one here would produce a second, silently different
  -- chart.
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount"
    WHERE "id" = parent_id AND "tenantId" = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Financial chart v3 requires v1 to be provisioned first';
  END IF;

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  INSERT INTO public."LedgerAccount" (
    "id", "tenantId", "parentId", "code", "name", "type", "currency",
    "isSystem", "isPostable", "isActive", "systemKey", "templateVersion",
    "governanceVersion", "createdAt", "updatedAt"
  ) VALUES (
    account_id, p_tenant_id, parent_id, 'L_2400_CUSTOMER_WALLET',
    'Customer wallet', 'LIABILITY', 'IRR',
    true, true, true, 'CUSTOMER_WALLET', 3, 1,
    p_occurred_at, p_occurred_at
  ) ON CONFLICT ("tenantId", "code") DO NOTHING;

  -- The same fail-closed check v1 makes: an account that exists but does not
  -- match the template is a chart somebody edited, and posting into it would
  -- put money somewhere nobody expects.
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount" account
    WHERE account."id" = account_id AND account."tenantId" = p_tenant_id
      AND account."parentId" = parent_id
      AND account."code" = 'L_2400_CUSTOMER_WALLET'
      AND account."type" = 'LIABILITY' AND account."currency" = 'IRR'
      AND account."isSystem" AND account."isPostable"
      AND account."systemKey" = 'CUSTOMER_WALLET'
      AND account."templateVersion" = 3
  ) THEN
    RAISE EXCEPTION 'Financial chart conflicts with reserved account L_2400_CUSTOMER_WALLET';
  END IF;

  INSERT INTO public."LedgerAccountGovernanceEvent" (
    "id", "tenantId", "ledgerAccountId", "action", "fromActive", "toActive",
    "actorType", "version", "idempotencyKey", "reason", "correlationId", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-governance-v3:CUSTOMER_WALLET'),
    p_tenant_id, account_id, 'PROVISIONED', NULL, true, 'SYSTEM', 1,
    'chart-v3-provisioned:CUSTOMER_WALLET', 'System chart template v3',
    p_correlation_id, p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;

  INSERT INTO public."TenantFinancialBootstrap" (
    "id", "tenantId", "templateVersion", "accountCount", "idempotencyKey",
    "correlationId", "completedAt"
  ) VALUES (
    bootstrap_id, p_tenant_id, 3, 1, p_idempotency_key, p_correlation_id, p_occurred_at
  ) ON CONFLICT ("tenantId", "templateVersion") DO NOTHING;

  INSERT INTO public."AuditEvent" (
    "id", "tenantId", "actorType", "action", "entityType", "entityId",
    "summary", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-audit-v3'),
    p_tenant_id, 'SYSTEM', 'financial.chart.provisioned', 'LedgerAccount', account_id,
    'Provisioned system chart of accounts v3', p_correlation_id,
    jsonb_build_object('templateVersion', 3, 'accountCount', 1), p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;
END $$;

GRANT EXECUTE ON FUNCTION provision_tenant_wallet_chart_v3(UUID, TEXT, UUID, TIMESTAMP) TO PUBLIC;

-- Every tenant that already exists gets the account. Additive and idempotent:
-- no journal, amount or existing account is touched.
DO $$
DECLARE tenant_record RECORD;
BEGIN
  FOR tenant_record IN SELECT "id", "createdAt" FROM "Tenant" ORDER BY "id" LOOP
    PERFORM provision_tenant_wallet_chart_v3(
      tenant_record."id", 'automatic-chart-bootstrap-v3',
      financial_deterministic_uuid(tenant_record."id", 'chart-correlation-v3'),
      tenant_record."createdAt"
    );
  END LOOP;
END $$;

-- And every tenant created from now on.
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
  PERFORM public.provision_tenant_wallet_chart_v3(
    NEW."id", 'automatic-chart-bootstrap-v3',
    public.financial_deterministic_uuid(NEW."id", 'chart-correlation-v3'),
    NEW."createdAt"
  );
  RETURN NEW;
END $$;

-- The double-entry guard learns two postings and one absence.
--
-- A top-up has no order, so the join that reached one has to become an outer
-- join or every wallet charge would be silently unguarded — the function
-- returns early when the row is not found, which for a top-up would mean no
-- check at all rather than a failed one.
--
-- A wallet paying for an order is a PAYMENT_CAPTURE like any other — the money
-- came from a balance rather than a card, which `method` already records — so
-- only the top-up needs a case of its own:
--   WALLET_TOP_UP  a captured payment whose purpose is a top-up, and no order.
CREATE OR REPLACE FUNCTION enforce_financial_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_transaction_id UUID; transaction_amount BIGINT; transaction_currency "Currency";
  transaction_tenant UUID; transaction_payment UUID; transaction_order UUID;
  transaction_type "FinancialTransactionType";
  payment_amount BIGINT; payment_currency "Currency"; payment_state "PaymentAggregateState";
  payment_order UUID; payment_purpose "PaymentPurpose"; order_payment_state "PaymentState";
  entry_count INTEGER;
  distinct_account_count INTEGER; debit_total BIGINT; credit_total BIGINT; invalid_entry_count INTEGER;
  states_agree BOOLEAN; order_agrees BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'FinancialTransaction' THEN target_transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_transaction_id := OLD."financialTransactionId";
  ELSE target_transaction_id := NEW."financialTransactionId"; END IF;
  SELECT tx."amount", tx."currency", tx."tenantId", tx."paymentId", tx."orderId", tx."type",
         p."amount", p."currency", p."state", p."orderId", p."purpose", o."paymentState"
  INTO transaction_amount, transaction_currency, transaction_tenant, transaction_payment,
       transaction_order, transaction_type,
       payment_amount, payment_currency, payment_state, payment_order, payment_purpose,
       order_payment_state
  FROM "FinancialTransaction" tx JOIN "Payment" p ON p."id" = tx."paymentId"
  LEFT JOIN "Order" o ON o."id" = tx."orderId" WHERE tx."id" = target_transaction_id;
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

  states_agree := CASE transaction_type
    WHEN 'PAYMENT_CAPTURE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'   THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
    WHEN 'WALLET_TOP_UP'    THEN payment_state = 'CAPTURED' AND payment_purpose = 'WALLET_TOP_UP'
                                 AND transaction_order IS NULL AND payment_order IS NULL
    ELSE FALSE
  END;

  -- A top-up names no order and must not; everything else names the one its
  -- payment belongs to.
  order_agrees := CASE
    WHEN transaction_type = 'WALLET_TOP_UP' THEN transaction_order IS NULL
    ELSE payment_order = transaction_order
  END;

  IF NOT states_agree OR NOT order_agrees
     OR payment_amount <> transaction_amount
     OR payment_currency <> transaction_currency OR entry_count < 2
     OR distinct_account_count < 2 OR invalid_entry_count <> 0
     OR debit_total <> credit_total OR debit_total <> transaction_amount
  THEN RAISE EXCEPTION 'Financial transaction must be a balanced double-entry posting matching its payment state'; END IF;
  RETURN NULL;
END $$;
