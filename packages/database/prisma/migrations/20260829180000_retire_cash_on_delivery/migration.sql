-- Taking cash out of the platform.
--
-- The business has one payment model: money arrives before the order is final,
-- through a bank gateway or from a wallet the customer has already charged.
-- Cash at the door was built on a different assumption — that an order could be
-- confirmed on a promise and settled at the step — and everything it needed
-- follows from that assumption: a ceiling per city, a minimum order count to
-- keep first-time fraud down, a receivable for money in a courier's pocket, a
-- remittance act to move it into the bank, and an alert for when it sat there
-- too long.
--
-- None of that has a job any more. It is removed rather than switched off
-- because nothing has launched on it: there are no couriers holding notes, no
-- remittances to reconcile, and no orders whose history would lose meaning. A
-- disabled feature that nobody can reach is a second system to keep compiling,
-- migrating and reasoning about for as long as it exists.

-- Nothing may be carrying cash. If anything is, this migration must stop rather
-- than delete the record of money somebody is holding.
DO $$
DECLARE
  outstanding BIGINT;
BEGIN
  SELECT count(*) INTO outstanding FROM "CourierCashRemittanceItem";
  IF outstanding > 0 THEN
    RAISE EXCEPTION
      'Cannot retire cash on delivery: % remittance items exist. Settle the courier cash first.',
      outstanding;
  END IF;

  SELECT count(*) INTO outstanding
  FROM "LedgerEntry" e
  JOIN "LedgerAccount" a ON a."id" = e."ledgerAccountId"
  WHERE a."code" = 'A_1200_COURIER_CASH_RECEIVABLE';
  IF outstanding > 0 THEN
    RAISE EXCEPTION
      'Cannot retire cash on delivery: the courier cash account has % postings.',
      outstanding;
  END IF;

  -- And nothing may still name the method. The enum rebuild below casts every
  -- one of these columns through text, so such a row would fail the cast in the
  -- middle of the rebuild — true, but as an error about a type rather than
  -- about the business. Counting them here says what is actually wrong, before
  -- a single table has been touched.
  SELECT (SELECT count(*) FROM "Quote"   WHERE "paymentMethod"::text = 'CASH_ON_DELIVERY')
       + (SELECT count(*) FROM "Order"   WHERE "paymentMethod"::text = 'CASH_ON_DELIVERY')
       + (SELECT count(*) FROM "Payment" WHERE "method"::text        = 'CASH_ON_DELIVERY')
  INTO outstanding;
  IF outstanding > 0 THEN
    RAISE EXCEPTION
      'Cannot retire cash on delivery: % quotes, orders or payments still name it.',
      outstanding;
  END IF;
END
$$;

DROP TABLE "CourierCashRemittanceItem";
DROP TABLE "CourierCashRemittance";

-- The courier cash receivable is deliberately left exactly as it is.
--
-- Three separate guards in this schema refuse to let a migration tidy it away,
-- and all three are right. Accounts cannot be deleted. Their identity — code,
-- type, whether they are postable — is immutable, because an account that
-- changed shape underneath its own history would make every past posting mean
-- something else. And a state change must be accompanied by a contiguous
-- governance record naming who made it, which a migration cannot supply because
-- a migration is nobody.
--
-- So the account stops being provisioned rather than being closed here: it
-- leaves the chart template in the domain, so no tenant gets it again. The one
-- that exists holds nothing — the guard above proved it never carried a
-- posting — and nothing can reach it once this code is gone. An operator who
-- wants it off their chart deactivates it from the panel, which is the path
-- that records who decided.

-- New tenants stop being given the account at all.
--
-- Chart v2 existed to add exactly one account, the courier cash receivable, and
-- it is hung off v1's asset root by a trigger that runs on every tenant insert.
-- The trigger goes back to provisioning v1 alone and the v2 function is
-- dropped. The version number itself stays at 2: a tenant provisioned last
-- month really was provisioned under v2, and renumbering that would be a lie
-- about their chart's history rather than a tidy-up of ours.
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
  RETURN NEW;
END $$;

DROP FUNCTION provision_tenant_cash_chart_v2(UUID, TEXT, UUID, TIMESTAMP(3));

ALTER TABLE "City"
  DROP CONSTRAINT "city_cash_on_delivery_policy_check",
  DROP COLUMN "cashOnDeliveryEnabled",
  DROP COLUMN "cashOnDeliveryCeiling",
  DROP COLUMN "cashOnDeliveryMinimumOrders";

-- PostgreSQL cannot drop a value from an enum, so each of the three is rebuilt
-- without the one it no longer has a use for. Every column is rewritten through
-- its text form, which is why the guard above matters: a row still saying
-- CASH_ON_DELIVERY would fail the cast, loudly, rather than be quietly
-- reinterpreted.
--
-- ONLINE_GATEWAY on its own looks thin. It is the truth at this commit — the
-- wallet is the next one, and it adds its value to this type rather than
-- rebuilding it again.
ALTER TABLE "Quote" ALTER COLUMN "paymentMethod" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "paymentMethod" DROP DEFAULT;
ALTER TABLE "Payment" ALTER COLUMN "method" DROP DEFAULT;

ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_retired";
CREATE TYPE "PaymentMethod" AS ENUM ('ONLINE_GATEWAY');

ALTER TABLE "Quote"
  ALTER COLUMN "paymentMethod" TYPE "PaymentMethod" USING "paymentMethod"::text::"PaymentMethod";
ALTER TABLE "Order"
  ALTER COLUMN "paymentMethod" TYPE "PaymentMethod" USING "paymentMethod"::text::"PaymentMethod";
ALTER TABLE "Payment"
  ALTER COLUMN "method" TYPE "PaymentMethod" USING "method"::text::"PaymentMethod";

ALTER TABLE "Quote" ALTER COLUMN "paymentMethod" SET DEFAULT 'ONLINE_GATEWAY';
ALTER TABLE "Order" ALTER COLUMN "paymentMethod" SET DEFAULT 'ONLINE_GATEWAY';
ALTER TABLE "Payment" ALTER COLUMN "method" SET DEFAULT 'ONLINE_GATEWAY';

DROP TYPE "PaymentMethod_retired";

ALTER TYPE "FinancialTransactionType" RENAME TO "FinancialTransactionType_retired";
CREATE TYPE "FinancialTransactionType" AS ENUM ('PAYMENT_CAPTURE', 'PAYMENT_REFUND');
ALTER TABLE "FinancialTransaction"
  ALTER COLUMN "type" TYPE "FinancialTransactionType"
  USING "type"::text::"FinancialTransactionType";
DROP TYPE "FinancialTransactionType_retired";

-- The alert asked "has a courier been carrying our money too long". Nobody is.
DELETE FROM "OperatorAlertDispatch" WHERE "kind" = 'COURIER_CASH_OUTSTANDING';

ALTER TYPE "OperatorAlertKind" RENAME TO "OperatorAlertKind_retired";
CREATE TYPE "OperatorAlertKind" AS ENUM (
  'PAYMENT_GATEWAY_UNHEALTHY',
  'OUTBOX_EVENTS_PARKED',
  'PAYMENTS_AWAITING_SETTLEMENT',
  'SMS_PROVIDER_UNAVAILABLE'
);
ALTER TABLE "OperatorAlertDispatch"
  ALTER COLUMN "kind" TYPE "OperatorAlertKind" USING "kind"::text::"OperatorAlertKind";
DROP TYPE "OperatorAlertKind_retired";

-- The double-entry guard branched on the retired transaction type.
--
-- A PL/pgSQL function resolves enum literals when it runs, not when it is
-- created, so rebuilding the type above left this one raising `invalid input
-- value` on every capture and every refund — that is, on all money movement,
-- not just the cash it used to describe. Restored without the arm it no longer
-- has a case for, and otherwise byte-for-byte what it was.
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
  -- to a refunded one. Nothing else is a posting this platform makes.
  states_agree := CASE transaction_type
    WHEN 'PAYMENT_CAPTURE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'   THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
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
