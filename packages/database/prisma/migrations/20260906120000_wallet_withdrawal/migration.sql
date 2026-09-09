-- The way out of the wallet.
--
-- Until now a balance could arrive four ways and leave two: spent on bread, or
-- sent to another customer. A refund therefore became credit and stayed credit
-- forever, which is a policy the platform never chose and could not honour if
-- somebody asked for their money back.
--
-- It also could not be honoured by hand. Support could transfer money at a bank
-- and had no way to take the matching amount out of the balance, so the customer
-- would have been paid twice: once to their card and once still standing on
-- their wallet screen, spendable. The absence of this table was the reason the
-- refund policy could not say the true thing.
--
-- The balance is debited when the request is made, not when the money is sent.
-- A request that only marked an intention would leave the amount spendable while
-- somebody at a bank was already sending it, and the two would race. So the
-- money leaves the wallet immediately and the request holds it; a rejection puts
-- it back, visibly, as its own statement line.
--
-- The ledger posting happens at the same moment, for the same reason a partner
-- payout posts when it is prepared: the platform stops owing the customer the
-- instant it accepts the instruction to pay them, and the bank transfer that
-- follows is evidence recorded against something that already exists.

CREATE TYPE "WalletWithdrawalState" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- WITHDRAWAL joins the other four ways a balance moves. The set is meant to be
-- exhaustive so every reader of a statement can be a total function over it.
ALTER TYPE "WalletEntryKind" ADD VALUE 'WITHDRAWAL';
-- And the reversal, when a request is refused. A separate kind rather than a
-- second WITHDRAWAL with the sign flipped: WalletEntry.amount is always
-- positive by design, and a statement that showed two identical lines for
-- "we took it" and "we gave it back" would be unreadable.
ALTER TYPE "WalletEntryKind" ADD VALUE 'WITHDRAWAL_REVERSAL';

ALTER TYPE "FinancialTransactionType" ADD VALUE 'WALLET_WITHDRAWAL';

CREATE TABLE "WalletWithdrawal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "state" "WalletWithdrawalState" NOT NULL DEFAULT 'REQUESTED',
  -- Where the money is going. Stored masked, never in full: the platform needs
  -- to know which card a customer meant and has no business holding a complete
  -- PAN. The customer types it; only the last four and the holder's name are
  -- kept, which is what a bank transfer form actually needs.
  "cardLastFour" VARCHAR(4) NOT NULL,
  "cardHolderName" VARCHAR(120) NOT NULL,
  -- Optional: an IBAN is what a real transfer is made against, and a customer
  -- who has one saves support a phone call.
  "iban" VARCHAR(26),
  -- What the bank called the transfer, once somebody sent it.
  "bankReference" VARCHAR(128),
  -- Why it was refused, in the operator's own words. A rejection with no reason
  -- is a support ticket the customer has to open to find out anything.
  "rejectionReason" VARCHAR(500),
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "settledByAccountId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  CONSTRAINT "WalletWithdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_withdrawal_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "wallet_withdrawal_card_check"
    CHECK ("cardLastFour" ~ '^[0-9]{4}$' AND length(btrim("cardHolderName")) > 0),
  -- An IBAN in this country is IR followed by twenty-four digits. Checked here
  -- so a typo is refused at the boundary rather than discovered at a bank.
  CONSTRAINT "wallet_withdrawal_iban_check"
    CHECK ("iban" IS NULL OR "iban" ~ '^IR[0-9]{24}$'),
  -- A settled request knows when and by whom; an open one cannot claim to.
  CONSTRAINT "wallet_withdrawal_settled_shape_check"
    CHECK (
      ("state" = 'REQUESTED') = ("settledAt" IS NULL)
      AND ("state" = 'REQUESTED') = ("settledByAccountId" IS NULL)
    ),
  -- Paid means there is a reference to look it up by; refused means there is a
  -- reason. Neither is optional, because both are the only thing the customer
  -- has afterwards.
  CONSTRAINT "wallet_withdrawal_outcome_shape_check"
    CHECK (
      ("state"::text = 'PAID') = ("bankReference" IS NOT NULL)
      AND ("state"::text = 'REJECTED') = ("rejectionReason" IS NOT NULL)
    ),
  CONSTRAINT "WalletWithdrawal_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletWithdrawal_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletWithdrawal_settledByAccountId_fkey"
    FOREIGN KEY ("settledByAccountId") REFERENCES "IdentityAccount"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "WalletWithdrawal_tenant_customer_idempotency_key"
  ON "WalletWithdrawal"("tenantId", "customerId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_WalletWithdrawal_id_tenant_key" ON "WalletWithdrawal"("id", "tenantId");
-- What the operator's queue reads: everything still open, oldest first.
CREATE INDEX "WalletWithdrawal_tenant_state_requested_idx"
  ON "WalletWithdrawal"("tenantId", "state", "requestedAt");

-- Terminal states are terminal, and the amount and destination never change.
-- Without this a paid withdrawal could be walked back to REQUESTED and paid a
-- second time out of a balance that was only debited once.
CREATE FUNCTION guard_wallet_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state"::text <> 'REQUESTED' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'A settled wallet withdrawal cannot change state';
  END IF;
  IF NEW."amount" <> OLD."amount"
     OR NEW."customerId" <> OLD."customerId"
     OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."cardLastFour" <> OLD."cardLastFour" THEN
    RAISE EXCEPTION 'A wallet withdrawal cannot change who, how much, or where to';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "WalletWithdrawal_guard"
BEFORE UPDATE ON "WalletWithdrawal"
FOR EACH ROW EXECUTE FUNCTION guard_wallet_withdrawal();

CREATE TRIGGER "WalletWithdrawal_no_delete"
BEFORE DELETE ON "WalletWithdrawal"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

ALTER TABLE "WalletWithdrawal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletWithdrawal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WalletWithdrawal"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The statement line says which request it belongs to, so "برداشت به کارت
-- ***۴۵۶۷" can be rendered from the row rather than guessed from its timestamp.
ALTER TABLE "WalletEntry" ADD COLUMN "withdrawalId" UUID;
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "WalletEntry_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES "WalletWithdrawal"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Each side of a withdrawal appears exactly once — the debit when it is asked
-- for, and the credit back if it is refused — which is what makes replaying
-- either safe however it is retried.
CREATE UNIQUE INDEX "WalletEntry_withdrawal_kind_key"
  ON "WalletEntry"("withdrawalId", "kind") WHERE "withdrawalId" IS NOT NULL;

ALTER TABLE "WalletWithdrawal"
  ADD CONSTRAINT "g3b_WalletWithdrawal_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletWithdrawal_customerId_tenant_idx"
  ON "WalletWithdrawal"("customerId", "tenantId");

ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "g3b_WalletEntry_withdrawalId_tenant_fk"
  FOREIGN KEY ("withdrawalId", "tenantId")
  REFERENCES "WalletWithdrawal" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletEntry_withdrawalId_tenant_idx"
  ON "WalletEntry"("withdrawalId", "tenantId");

-- A withdrawal posting names no order and no payment: it is the platform
-- discharging what it owes a customer, straight out of the bank. The balance
-- check has to know that, or every one of them would be refused.
CREATE OR REPLACE FUNCTION enforce_financial_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_transaction_id UUID; transaction_amount BIGINT; transaction_currency "Currency";
  transaction_tenant UUID; transaction_payment UUID; transaction_order UUID;
  transaction_type "FinancialTransactionType";
  payment_amount BIGINT; payment_currency "Currency"; payment_state "PaymentAggregateState";
  payment_order UUID; payment_purpose "PaymentPurpose"; order_payment_state "PaymentState";
  order_state "OrderState";
  entry_count INTEGER;
  distinct_account_count INTEGER; debit_total BIGINT; credit_total BIGINT; invalid_entry_count INTEGER;
  states_agree BOOLEAN; order_agrees BOOLEAN; payment_agrees BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'FinancialTransaction' THEN target_transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_transaction_id := OLD."financialTransactionId";
  ELSE target_transaction_id := NEW."financialTransactionId"; END IF;
  SELECT tx."amount", tx."currency", tx."tenantId", tx."paymentId", tx."orderId", tx."type",
         p."amount", p."currency", p."state", p."orderId", p."purpose",
         o."paymentState", o."state"
  INTO transaction_amount, transaction_currency, transaction_tenant, transaction_payment,
       transaction_order, transaction_type,
       payment_amount, payment_currency, payment_state, payment_order, payment_purpose,
       order_payment_state, order_state
  FROM "FinancialTransaction" tx
  LEFT JOIN "Payment" p ON p."id" = tx."paymentId"
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

  states_agree := CASE transaction_type::text
    WHEN 'PAYMENT_CAPTURE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'   THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
    WHEN 'WALLET_TOP_UP'    THEN payment_state = 'CAPTURED' AND payment_purpose = 'WALLET_TOP_UP'
                                 AND transaction_order IS NULL AND payment_order IS NULL
    -- An order is divided when it has been delivered, never before. Splitting
    -- earlier would credit a bakery for bread that may yet be cancelled.
    WHEN 'ORDER_SETTLEMENT' THEN order_state = 'COMPLETED' AND order_payment_state = 'PAID'
    WHEN 'PARTNER_PAYOUT'   THEN TRUE
    -- Money leaving the platform for a customer. The withdrawal row's own
    -- constraints and trigger say when that is allowed; there is no payment or
    -- order state for this posting to agree with.
    WHEN 'WALLET_WITHDRAWAL' THEN TRUE
    ELSE FALSE
  END;

  -- A top-up, a payout and a withdrawal name no order; everything else names
  -- the one it is about, and for the payment-backed types that must be the
  -- payment's own.
  order_agrees := CASE
    WHEN transaction_type::text IN ('WALLET_TOP_UP', 'PARTNER_PAYOUT', 'WALLET_WITHDRAWAL')
      THEN transaction_order IS NULL
    WHEN transaction_type::text = 'ORDER_SETTLEMENT' THEN transaction_order IS NOT NULL
    ELSE payment_order = transaction_order
  END;

  -- A posting with a payment must match its amount and currency exactly. One
  -- without a payment has no amount to match, and the balance below is the
  -- whole of its arithmetic.
  payment_agrees := CASE
    WHEN transaction_type::text IN ('ORDER_SETTLEMENT', 'PARTNER_PAYOUT', 'WALLET_WITHDRAWAL')
      THEN transaction_payment IS NULL
    ELSE payment_amount = transaction_amount AND payment_currency = transaction_currency
  END;

  IF NOT states_agree OR NOT order_agrees OR NOT payment_agrees
     OR entry_count < 2
     OR distinct_account_count < 2 OR invalid_entry_count <> 0
     OR debit_total <> credit_total OR debit_total <> transaction_amount
  THEN RAISE EXCEPTION 'Financial transaction must be a balanced double-entry posting matching its payment state'; END IF;
  RETURN NULL;
END $$;

-- Both shape checks have to admit the new type, or a withdrawal posting is
-- refused before the balance trigger ever sees it. Compared as text because the
-- enum value above was added in this same transaction and PostgreSQL will not
-- evaluate a value whose transaction has not committed.
ALTER TABLE "FinancialTransaction"
  DROP CONSTRAINT "financial_transaction_payment_shape_check";
ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "financial_transaction_payment_shape_check"
  CHECK (
    ("type"::text IN ('ORDER_SETTLEMENT', 'PARTNER_PAYOUT', 'WALLET_WITHDRAWAL'))
    = ("paymentId" IS NULL)
  );

-- A withdrawal names no order: it is not about one. It is the platform paying
-- back a balance that may have come from a dozen of them, or from a top-up that
-- was never spent.
ALTER TABLE "FinancialTransaction"
  DROP CONSTRAINT "financial_transaction_order_shape_check";
ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "financial_transaction_order_shape_check"
  CHECK (
    ("type"::text IN ('WALLET_TOP_UP', 'PARTNER_PAYOUT', 'WALLET_WITHDRAWAL'))
    = ("orderId" IS NULL)
  );

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('WalletWithdrawal', 'customerId', 'Customer')
--    ('WalletEntry', 'withdrawalId', 'WalletWithdrawal')
