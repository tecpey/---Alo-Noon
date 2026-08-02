-- Payment and double-entry ledger foundation. This migration creates only new
-- financial structures plus additive parent keys; it does not rewrite legacy data.

CREATE TYPE "PaymentAggregateState" AS ENUM (
  'CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED'
);
CREATE TYPE "LedgerAccountType" AS ENUM (
  'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'
);
CREATE TYPE "LedgerEntrySide" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "FinancialTransactionType" AS ENUM ('PAYMENT_CAPTURE');

CREATE TABLE "Payment" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "publicId" VARCHAR(32) NOT NULL,
  "orderId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "state" "PaymentAggregateState" NOT NULL DEFAULT 'CREATED',
  "amount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "version" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Payment_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "Payment_version_check" CHECK ("version" > 0),
  CONSTRAINT "Payment_currency_check" CHECK ("currency" = 'IRR')
);

CREATE TABLE "PaymentStateTransition" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "fromState" "PaymentAggregateState",
  "toState" "PaymentAggregateState" NOT NULL,
  "actorType" "ActorType" NOT NULL,
  "actorId" UUID,
  "version" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentStateTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentTransition_version_check" CHECK ("version" > 0),
  CONSTRAINT "PaymentTransition_authority_check" CHECK (
    ("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR
    ("actorType" = 'STAFF' AND "actorId" IS NOT NULL)
  ),
  CONSTRAINT "PaymentTransition_state_machine_check" CHECK (
    ("fromState" IS NULL AND "toState" = 'CREATED' AND "version" = 1 AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'CREATED' AND "toState" = 'PENDING' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'CREATED' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF')) OR
    ("fromState" = 'PENDING' AND "toState" = 'AUTHORIZED' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'PENDING' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF')) OR
    ("fromState" = 'AUTHORIZED' AND "toState" = 'CAPTURED' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'AUTHORIZED' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF'))
  )
);

CREATE TABLE "LedgerAccount" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" TEXT NOT NULL,
  "type" "LedgerAccountType" NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerAccount_currency_check" CHECK ("currency" = 'IRR'),
  CONSTRAINT "LedgerAccount_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE "FinancialTransaction" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "type" "FinancialTransactionType" NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialTransaction_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "FinancialTransaction_currency_check" CHECK ("currency" = 'IRR')
);

CREATE TABLE "LedgerEntry" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "financialTransactionId" UUID NOT NULL,
  "ledgerAccountId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "side" "LedgerEntrySide" NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerEntry_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "LedgerEntry_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "LedgerEntry_currency_check" CHECK ("currency" = 'IRR')
);

CREATE UNIQUE INDEX "Payment_publicId_key" ON "Payment" ("publicId");
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment" ("orderId");
CREATE UNIQUE INDEX "Payment_tenant_customer_idempotency_key"
  ON "Payment" ("tenantId", "customerId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_Payment_id_tenant_key" ON "Payment" ("id", "tenantId");
CREATE INDEX "g3b_Payment_orderId_tenant_idx" ON "Payment" ("orderId", "tenantId");
CREATE INDEX "g3b_Payment_customerId_tenant_idx" ON "Payment" ("customerId", "tenantId");
CREATE INDEX "Payment_tenant_state_createdAt_idx" ON "Payment" ("tenantId", "state", "createdAt");

CREATE UNIQUE INDEX "PaymentTransition_scoped_idempotency_key"
  ON "PaymentStateTransition" ("tenantId", "paymentId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentTransition_payment_version_key"
  ON "PaymentStateTransition" ("paymentId", "version");
CREATE INDEX "PaymentStateTransition_paymentId_occurredAt_idx"
  ON "PaymentStateTransition" ("paymentId", "occurredAt");
CREATE INDEX "g3b_PaymentStateTransition_paymentId_tenant_idx"
  ON "PaymentStateTransition" ("paymentId", "tenantId");
CREATE INDEX "PaymentStateTransition_tenantId_correlationId_idx"
  ON "PaymentStateTransition" ("tenantId", "correlationId");

CREATE UNIQUE INDEX "LedgerAccount_tenant_code_key"
  ON "LedgerAccount" ("tenantId", "code");
CREATE UNIQUE INDEX "g3b_LedgerAccount_id_tenant_key"
  ON "LedgerAccount" ("id", "tenantId");
CREATE INDEX "LedgerAccount_tenant_type_active_idx"
  ON "LedgerAccount" ("tenantId", "type", "isActive");

CREATE UNIQUE INDEX "FinancialTransaction_paymentId_key"
  ON "FinancialTransaction" ("paymentId");
CREATE UNIQUE INDEX "FinancialTransaction_tenant_idempotency_key"
  ON "FinancialTransaction" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_FinancialTransaction_id_tenant_key"
  ON "FinancialTransaction" ("id", "tenantId");
CREATE INDEX "g3b_FinancialTransaction_paymentId_tenant_idx"
  ON "FinancialTransaction" ("paymentId", "tenantId");
CREATE INDEX "g3b_FinancialTransaction_orderId_tenant_idx"
  ON "FinancialTransaction" ("orderId", "tenantId");
CREATE INDEX "FinancialTransaction_tenant_occurredAt_idx"
  ON "FinancialTransaction" ("tenantId", "occurredAt");

CREATE UNIQUE INDEX "LedgerEntry_transaction_sequence_key"
  ON "LedgerEntry" ("financialTransactionId", "sequence");
CREATE INDEX "g3b_LedgerEntry_financialTransactionId_tenant_idx"
  ON "LedgerEntry" ("financialTransactionId", "tenantId");
CREATE INDEX "g3b_LedgerEntry_ledgerAccountId_tenant_idx"
  ON "LedgerEntry" ("ledgerAccountId", "tenantId");
CREATE INDEX "LedgerEntry_tenant_account_createdAt_idx"
  ON "LedgerEntry" ("tenantId", "ledgerAccountId", "createdAt");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_id_tenant_customer_key" UNIQUE ("id", "tenantId", "customerId");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Payment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_Payment_orderId_tenant_fk"
    FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "g3b_Payment_customerId_tenant_fk"
    FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "Payment_order_tenant_customer_fk"
    FOREIGN KEY ("orderId", "tenantId", "customerId")
    REFERENCES "Order" ("id", "tenantId", "customerId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "PaymentStateTransition"
  ADD CONSTRAINT "PaymentStateTransition_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_PaymentStateTransition_paymentId_tenant_fk"
    FOREIGN KEY ("paymentId", "tenantId")
  REFERENCES "Payment" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "FinancialTransaction_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinancialTransaction_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_FinancialTransaction_paymentId_tenant_fk"
    FOREIGN KEY ("paymentId", "tenantId")
  REFERENCES "Payment" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "g3b_FinancialTransaction_orderId_tenant_fk"
    FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_financialTransactionId_fkey"
    FOREIGN KEY ("financialTransactionId") REFERENCES "FinancialTransaction" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LedgerEntry_ledgerAccountId_fkey"
    FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_LedgerEntry_financialTransactionId_tenant_fk"
    FOREIGN KEY ("financialTransactionId", "tenantId")
  REFERENCES "FinancialTransaction" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "g3b_LedgerEntry_ledgerAccountId_tenant_fk"
    FOREIGN KEY ("ledgerAccountId", "tenantId")
  REFERENCES "LedgerAccount" ("id", "tenantId")
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION enforce_payment_history_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_payment_id UUID;
  current_state "PaymentAggregateState";
  current_version INTEGER;
  transition_count INTEGER;
  latest_state "PaymentAggregateState";
BEGIN
  IF TG_TABLE_NAME = 'Payment' THEN
    target_payment_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_payment_id := OLD."paymentId";
  ELSE
    target_payment_id := NEW."paymentId";
  END IF;

  SELECT "state", "version" INTO current_state, current_version
  FROM "Payment" WHERE "id" = target_payment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*), (ARRAY_AGG("toState" ORDER BY "version" DESC))[1]
  INTO transition_count, latest_state
  FROM "PaymentStateTransition" WHERE "paymentId" = target_payment_id;

  IF transition_count <> current_version OR latest_state IS DISTINCT FROM current_state THEN
    RAISE EXCEPTION 'Payment state must match contiguous transition history';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "version", "fromState", "toState",
        LAG("toState") OVER (ORDER BY "version") AS previous_state
      FROM "PaymentStateTransition" WHERE "paymentId" = target_payment_id
    ) history
    WHERE ("version" = 1 AND ("fromState" IS NOT NULL OR "toState" <> 'CREATED'))
       OR ("version" > 1 AND "fromState" IS DISTINCT FROM previous_state)
  ) THEN
    RAISE EXCEPTION 'Payment transition history is not contiguous';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "Payment_history_consistency"
AFTER INSERT OR UPDATE ON "Payment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_history_consistency();
CREATE CONSTRAINT TRIGGER "PaymentTransition_history_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "PaymentStateTransition"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_history_consistency();

CREATE FUNCTION enforce_financial_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_transaction_id UUID;
  transaction_amount BIGINT;
  transaction_currency "Currency";
  transaction_tenant UUID;
  transaction_payment UUID;
  transaction_order UUID;
  payment_amount BIGINT;
  payment_currency "Currency";
  payment_state "PaymentAggregateState";
  payment_order UUID;
  order_payment_state "PaymentState";
  entry_count INTEGER;
  distinct_account_count INTEGER;
  debit_total BIGINT;
  credit_total BIGINT;
  invalid_entry_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'FinancialTransaction' THEN
    target_transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_transaction_id := OLD."financialTransactionId";
  ELSE
    target_transaction_id := NEW."financialTransactionId";
  END IF;

  SELECT tx."amount", tx."currency", tx."tenantId", tx."paymentId", tx."orderId",
         p."amount", p."currency", p."state", p."orderId", o."paymentState"
  INTO transaction_amount, transaction_currency, transaction_tenant, transaction_payment,
       transaction_order, payment_amount, payment_currency, payment_state, payment_order,
       order_payment_state
  FROM "FinancialTransaction" tx
  JOIN "Payment" p ON p."id" = tx."paymentId"
  JOIN "Order" o ON o."id" = tx."orderId"
  WHERE tx."id" = target_transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*), COUNT(DISTINCT entry."ledgerAccountId"),
    COALESCE(SUM(entry."amount") FILTER (WHERE entry."side" = 'DEBIT'), 0),
    COALESCE(SUM(entry."amount") FILTER (WHERE entry."side" = 'CREDIT'), 0),
    COUNT(*) FILTER (
      WHERE entry."tenantId" <> transaction_tenant
        OR entry."currency" <> transaction_currency
        OR account."currency" <> transaction_currency
        OR NOT account."isActive"
    )
  INTO entry_count, distinct_account_count, debit_total, credit_total, invalid_entry_count
  FROM "LedgerEntry" entry
  JOIN "LedgerAccount" account ON account."id" = entry."ledgerAccountId"
  WHERE entry."financialTransactionId" = target_transaction_id;

  IF payment_state <> 'CAPTURED'
     OR order_payment_state <> 'PAID'
     OR payment_order <> transaction_order
     OR payment_amount <> transaction_amount
     OR payment_currency <> transaction_currency
     OR entry_count < 2
     OR distinct_account_count < 2
     OR invalid_entry_count <> 0
     OR debit_total <> credit_total
     OR debit_total <> transaction_amount
  THEN
    RAISE EXCEPTION 'Financial transaction must be a captured, balanced double-entry posting';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "FinancialTransaction_balance_guard"
AFTER INSERT OR UPDATE ON "FinancialTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_financial_transaction_balance();
CREATE CONSTRAINT TRIGGER "LedgerEntry_balance_guard"
AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_financial_transaction_balance();

CREATE FUNCTION protect_financial_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER "PaymentTransition_append_only"
BEFORE UPDATE OR DELETE ON "PaymentStateTransition"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER "FinancialTransaction_append_only"
BEFORE UPDATE OR DELETE ON "FinancialTransaction"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER "LedgerEntry_append_only"
BEFORE UPDATE OR DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

CREATE FUNCTION protect_payment_economics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payments cannot be deleted'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId"
  THEN
    RAISE EXCEPTION 'Payment economic identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Payment_economics_immutable"
BEFORE UPDATE OR DELETE ON "Payment"
FOR EACH ROW EXECUTE FUNCTION protect_payment_economics();

CREATE FUNCTION protect_ledger_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Ledger accounts cannot be deleted'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
  THEN
    RAISE EXCEPTION 'Ledger account identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "LedgerAccount_identity_immutable"
BEFORE UPDATE OR DELETE ON "LedgerAccount"
FOR EACH ROW EXECUTE FUNCTION protect_ledger_account_identity();

CREATE FUNCTION protect_order_payment_economics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Payment" WHERE "orderId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Orders with payments cannot be deleted'; END IF;
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
      OR NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
    THEN
      RAISE EXCEPTION 'Paid order economic identity is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Order_payment_economics_immutable"
BEFORE UPDATE OR DELETE ON "Order"
FOR EACH ROW EXECUTE FUNCTION protect_order_payment_economics();

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Payment"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentStateTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentStateTransition" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentStateTransition"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "LedgerAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LedgerAccount"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "FinancialTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialTransaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinancialTransaction"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "LedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LedgerEntry"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registered tenant-owned relations added by this migration:
--    ('FinancialTransaction', 'orderId', 'Order')
--    ('FinancialTransaction', 'paymentId', 'Payment')
--    ('LedgerEntry', 'financialTransactionId', 'FinancialTransaction')
--    ('LedgerEntry', 'ledgerAccountId', 'LedgerAccount')
--    ('Payment', 'customerId', 'Customer')
--    ('Payment', 'orderId', 'Order')
--    ('PaymentStateTransition', 'paymentId', 'Payment')
