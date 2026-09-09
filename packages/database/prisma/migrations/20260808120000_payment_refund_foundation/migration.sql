-- Refunds: the first way money can leave the system.
--
-- Until now a payment could only be captured. The clearing liability grew with
-- every order and nothing could ever draw it down, so a cancelled order left
-- the customer's money sitting in a suspense account with no path out.
--
-- Three things stood in the way, and each is removed here.

-- The two enum values this needs are added by the migration before it, because
-- Postgres will not let a new enum value be used in the transaction that added
-- it.
--
-- A payment could carry exactly one posting, so the refund had nowhere to live.
-- It now carries at most one of each kind: the capture, and the refund that
-- reverses it.
DROP INDEX IF EXISTS "FinancialTransaction_paymentId_key";
CREATE UNIQUE INDEX "FinancialTransaction_payment_type_key"
  ON "FinancialTransaction" ("paymentId", "type");
-- The paid-order projection counted every posting on a payment, so a refunded
-- order would have tripped it. It must count captures only.
CREATE OR REPLACE FUNCTION enforce_order_payment_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payment_state "PaymentAggregateState";
  posting_count INTEGER;
BEGIN
  IF NEW."paymentState" <> 'PAID' THEN RETURN NULL; END IF;

  SELECT payment."state",
         (SELECT COUNT(*) FROM "FinancialTransaction" posting
          WHERE posting."paymentId" = payment."id"
            AND posting."type" = 'PAYMENT_CAPTURE')
  INTO payment_state, posting_count
  FROM "Payment" payment
  WHERE payment."orderId" = NEW."id";

  IF NOT FOUND OR payment_state <> 'CAPTURED' OR posting_count <> 1 THEN
    RAISE EXCEPTION 'Paid order requires exactly one captured payment transaction';
  END IF;

  RETURN NULL;
END;
$$;

-- The payment history guard allowed a captured payment exactly one posting and
-- everything else none, so a refund broke it in both directions. It now knows
-- the three shapes a payment's postings can legitimately take.
CREATE OR REPLACE FUNCTION enforce_payment_history_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_payment_id UUID;
  current_state "PaymentAggregateState";
  current_version INTEGER;
  order_payment_state "PaymentState";
  capture_count INTEGER;
  refund_count INTEGER;
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

  SELECT payment."state", payment."version", orders."paymentState",
         (SELECT COUNT(*) FROM "FinancialTransaction" posting
          WHERE posting."paymentId" = payment."id" AND posting."type" = 'PAYMENT_CAPTURE'),
         (SELECT COUNT(*) FROM "FinancialTransaction" posting
          WHERE posting."paymentId" = payment."id" AND posting."type" = 'PAYMENT_REFUND')
  INTO current_state, current_version, order_payment_state, capture_count, refund_count
  FROM "Payment" payment
  JOIN "Order" orders ON orders."id" = payment."orderId"
  WHERE payment."id" = target_payment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*), (ARRAY_AGG("toState" ORDER BY "version" DESC))[1]
  INTO transition_count, latest_state
  FROM "PaymentStateTransition" WHERE "paymentId" = target_payment_id;

  IF transition_count <> current_version OR latest_state IS DISTINCT FROM current_state THEN
    RAISE EXCEPTION 'Payment state must match contiguous transition history';
  END IF;

  IF current_state = 'CAPTURED'
     AND (order_payment_state <> 'PAID' OR capture_count <> 1 OR refund_count <> 0)
  THEN
    RAISE EXCEPTION 'Captured payment requires a paid order and exactly one financial transaction';
  END IF;

  -- A refund reverses a capture, so the capture has to still be there. Keeping
  -- both postings is what lets the ledger show the money arriving and leaving
  -- rather than quietly netting to nothing.
  IF current_state = 'REFUNDED'
     AND (order_payment_state <> 'REFUNDED' OR capture_count <> 1 OR refund_count <> 1)
  THEN
    RAISE EXCEPTION 'Refunded payment requires a refunded order, one capture, and one refund';
  END IF;

  IF current_state NOT IN ('CAPTURED', 'REFUNDED') AND capture_count + refund_count <> 0 THEN
    RAISE EXCEPTION 'Only a captured payment may own a financial transaction';
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

-- The transition table encodes the payment state machine as a check constraint
-- of its own. It had no step out of CAPTURED, which is the same reason the
-- domain had none: money only ever moved one way.
ALTER TABLE "PaymentStateTransition"
  DROP CONSTRAINT "PaymentTransition_state_machine_check";
ALTER TABLE "PaymentStateTransition"
  ADD CONSTRAINT "PaymentTransition_state_machine_check" CHECK (
    ("fromState" IS NULL AND "toState" = 'CREATED' AND "version" = 1 AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'CREATED' AND "toState" = 'PENDING' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'CREATED' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF')) OR
    ("fromState" = 'PENDING' AND "toState" = 'AUTHORIZED' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'PENDING' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF')) OR
    ("fromState" = 'AUTHORIZED' AND "toState" = 'CAPTURED' AND "actorType" = 'SYSTEM') OR
    ("fromState" = 'AUTHORIZED' AND "toState" = 'FAILED' AND "actorType" IN ('SYSTEM', 'STAFF')) OR
    -- Staff only, and deliberately: nothing automated has any business deciding
    -- to give a customer their money back.
    ("fromState" = 'CAPTURED' AND "toState" = 'REFUNDED' AND "actorType" = 'STAFF')
  );

-- Every posting was required to belong to a captured payment on a paid order,
-- which is true of a capture and never of the refund that reverses it. The rule
-- now depends on what the posting is.
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
  -- to a refunded one — and the capture it reverses is still there, validated
  -- under the same rule when it was written.
  states_agree := CASE transaction_type
    WHEN 'PAYMENT_CAPTURE' THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'  THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
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
