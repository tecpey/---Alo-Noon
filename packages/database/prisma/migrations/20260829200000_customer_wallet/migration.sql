-- The wallet a customer charges and spends from.
--
-- Two ways to pay for bread: a bank gateway, or a balance the customer topped
-- up earlier. The second is the one that makes a daily purchase bearable —
-- nobody wants a gateway redirect at six in the morning for a loaf, and every
-- redirect is a place the purchase can be abandoned.
--
-- The balance is a liability. The platform is holding somebody else's money and
-- owes it back to them, either as bread or as a refund, and an account that
-- said otherwise would make the business look richer than it is by exactly the
-- amount it has already been paid for work it has not done.
--
-- Three postings, and each is a different sentence:
--
--   top-up   DEBIT  cash clearing     CREDIT customer wallet
--            money arrives; we now owe the customer.
--   spend    DEBIT  customer wallet   CREDIT payment clearing
--            no money moves. One obligation becomes another: we stop owing
--            them a balance and start owing the bakery a delivery. Recorded as
--            a PAYMENT_CAPTURE, because that is what it is — the payment was
--            captured, and `method` already says the money came from a balance.
--            A separate transaction type would be a second way to say "this
--            payment succeeded", and the guard that counts captures to decide
--            whether an order is paid would not know about it.
--   refund   DEBIT  payment clearing  CREDIT customer wallet
--            the reverse of a spend, and a later migration's business.
--
-- Spending is not in this migration. It has to move the payment state machine
-- and the order's paid flag in the same transaction as the balance, which is a
-- change to the capture path rather than an addition beside it.

CREATE TYPE "PaymentPurpose" AS ENUM ('ORDER', 'WALLET_TOP_UP');
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';
ALTER TYPE "FinancialTransactionType" ADD VALUE 'WALLET_TOP_UP';

CREATE TYPE "WalletEntryKind" AS ENUM (
  'TOP_UP',
  'ORDER_PAYMENT',
  'REFUND',
  'TRANSFER_IN',
  'TRANSFER_OUT'
);

-- A payment that charges a wallet has no order.
--
-- Reusing the payment aggregate rather than inventing a second one is the whole
-- reason a top-up gets the gateway selection, the callback route, the
-- settlement sweep and the idempotency this platform already has. The cost is
-- that `orderId` stops being mandatory, so the index that enforced one payment
-- per order becomes partial — which says the same thing about orders and says
-- nothing about the rows that have none.
ALTER TABLE "Payment"
  ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'ORDER',
  ALTER COLUMN "orderId" DROP NOT NULL;

DROP INDEX "Payment_orderId_key";
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId") WHERE "orderId" IS NOT NULL;

-- What each purpose is allowed to look like, stated once here rather than
-- trusted to every writer: an order payment names its order, a top-up does not.
ALTER TABLE "Payment"
  ADD CONSTRAINT "payment_purpose_shape_check" CHECK (
    ("purpose" = 'ORDER' AND "orderId" IS NOT NULL)
    OR ("purpose" = 'WALLET_TOP_UP' AND "orderId" IS NULL)
  );

-- And the posting that records it has no order either.
--
-- A top-up is money crossing the platform's edge with nothing to deliver, so
-- the journal names a payment and no order. The column follows the payment it
-- posts for, and the shape is stated the same way: the type that has no order
-- must have none, and every other type must name one. Without the check, a
-- capture that simply forgot its order would post cleanly and then be invisible
-- to every report that reads the ledger by order.
ALTER TABLE "FinancialTransaction" ALTER COLUMN "orderId" DROP NOT NULL;

--
-- Compared as text, not as the enum: WALLET_TOP_UP is added to the type in this
-- same migration, and PostgreSQL refuses to evaluate a value added by a
-- transaction that has not committed. The text form names it without asking the
-- enum whether it exists yet.
ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "financial_transaction_order_shape_check" CHECK (
    ("type"::text = 'WALLET_TOP_UP' AND "orderId" IS NULL)
    OR ("type"::text <> 'WALLET_TOP_UP' AND "orderId" IS NOT NULL)
  );

-- One wallet per customer.
--
-- The balance is kept on the row rather than summed from entries on every read.
-- A running total that has to be recomputed to be trusted is one that gets
-- cached wrongly somewhere; this one is written in the same transaction as the
-- entry that moved it, and the entry records what it became. The check
-- constraint is the real guarantee: no path, however wrong, can leave a
-- customer owing the platform money.
CREATE TABLE "CustomerWallet" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "balanceAmount" BIGINT NOT NULL DEFAULT 0,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  -- Raised by every movement. A spend that reads a balance and writes it back
  -- must lose to a concurrent one rather than overwrite it.
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerWallet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_wallet_balance_check" CHECK ("balanceAmount" >= 0),
  CONSTRAINT "CustomerWallet_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CustomerWallet_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- One wallet per customer, stated on the customer alone.
--
-- A customer belongs to exactly one tenant, so "one per tenant per customer"
-- would be a weaker restatement of the same rule — and a weaker one is the kind
-- that lets a second wallet appear the day somebody writes a query that forgets
-- the tenant.
CREATE UNIQUE INDEX "CustomerWallet_customerId_key" ON "CustomerWallet"("customerId");
CREATE UNIQUE INDEX "CustomerWallet_tenant_customer_key"
  ON "CustomerWallet"("tenantId", "customerId");
CREATE UNIQUE INDEX "g3b_CustomerWallet_id_tenant_key" ON "CustomerWallet"("id", "tenantId");

-- Every movement, and what the balance became.
--
-- Append-only and never updated. This is what answers "where did my money go",
-- and a row that could be edited afterwards could not answer it. `balanceAfter`
-- is stored rather than derived so a statement can be read without replaying
-- the customer's whole history, and so a balance that ever disagrees with its
-- entries is visible rather than merely wrong.
CREATE TABLE "WalletEntry" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "kind" "WalletEntryKind" NOT NULL,
  -- Always positive. Which way it moved is the kind's business, not the sign's
  -- — a negative amount somewhere in a ledger is how a credit becomes a debit
  -- by accident.
  "amount" BIGINT NOT NULL,
  "balanceAfter" BIGINT NOT NULL,
  -- Which movement this was, counting from one. A statement ordered by time
  -- alone is not an order at all: two movements in the same millisecond come
  -- back in whichever sequence the index feels like, and the newest line — the
  -- one whose balance the customer recognises as theirs — is a coin flip.
  -- Numbering them also makes a lost entry visible as a gap rather than as a
  -- balance that quietly stops adding up.
  "sequence" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  -- The payment that funded a top-up, or null for everything else.
  "paymentId" UUID,
  -- The order a spend or refund belongs to, or null for everything else.
  "orderId" UUID,
  -- What the caller called this movement. Makes a retried request replay onto
  -- the same entry instead of moving the money twice.
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_entry_amount_check"
    CHECK ("amount" > 0 AND "balanceAfter" >= 0 AND "sequence" > 0),
  CONSTRAINT "WalletEntry_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletEntry_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "CustomerWallet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletEntry_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletEntry_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "WalletEntry_tenant_wallet_idempotency_key"
  ON "WalletEntry"("tenantId", "walletId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_WalletEntry_id_tenant_key" ON "WalletEntry"("id", "tenantId");
-- The statement's own order, and the guarantee that no two movements claim the
-- same place in it.
CREATE UNIQUE INDEX "WalletEntry_wallet_sequence_key"
  ON "WalletEntry"("walletId", "sequence" DESC);

-- An entry is a fact about money that already moved.
CREATE OR REPLACE FUNCTION guard_wallet_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Wallet entries are append-only';
END $$;

CREATE TRIGGER wallet_entry_guard
BEFORE UPDATE OR DELETE ON "WalletEntry"
FOR EACH ROW EXECUTE FUNCTION guard_wallet_entry();

ALTER TABLE "CustomerWallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerWallet" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CustomerWallet"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "WalletEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WalletEntry"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "CustomerWallet"
  ADD CONSTRAINT "g3b_CustomerWallet_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CustomerWallet_customerId_tenant_idx"
  ON "CustomerWallet"("customerId", "tenantId");

ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "g3b_WalletEntry_walletId_tenant_fk"
  FOREIGN KEY ("walletId", "tenantId")
  REFERENCES "CustomerWallet" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletEntry_walletId_tenant_idx" ON "WalletEntry"("walletId", "tenantId");

ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "g3b_WalletEntry_paymentId_tenant_fk"
  FOREIGN KEY ("paymentId", "tenantId")
  REFERENCES "Payment" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletEntry_paymentId_tenant_idx" ON "WalletEntry"("paymentId", "tenantId");

ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "g3b_WalletEntry_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletEntry_orderId_tenant_idx" ON "WalletEntry"("orderId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('CustomerWallet', 'customerId', 'Customer')
--    ('WalletEntry', 'walletId', 'CustomerWallet')
--    ('WalletEntry', 'paymentId', 'Payment')
--    ('WalletEntry', 'orderId', 'Order')
