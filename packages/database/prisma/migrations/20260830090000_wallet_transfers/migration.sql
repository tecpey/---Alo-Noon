-- Sending part of a balance to somebody else's.
--
-- The whole table exists because of the gap between deciding to send money and
-- proving you meant it. A transfer is chosen by typing a phone number, where a
-- single wrong key sends real money to a real stranger, so the sender is shown
-- who they are about to pay and has to confirm with a code texted to their own
-- handset. That gap needs somewhere to live, and this is it.
--
-- Nothing is held while it waits. Moving the money at request time and putting
-- it back on expiry would invent a balance that belongs to neither party and
-- appears in neither statement; the sender's balance is checked again at
-- confirmation, which is the only moment the answer has to be true.
--
-- No ledger posting, ever. Both balances live under the same control account —
-- L_2400_CUSTOMER_WALLET, what the platform owes its customers — and moving
-- money between two customers does not change that total by one Rial. The
-- double-entry guard would refuse the journal anyway, correctly: a posting
-- whose debit and credit name the same account records nothing. The per-customer
-- detail is the subsidiary ledger, which is exactly what WalletEntry is.

-- TRANSFER_IN and TRANSFER_OUT are already in WalletEntryKind: the kinds were
-- written as the complete set of ways a balance can move, so that the direction
-- table below them could be exhaustive rather than open-ended. This is the
-- migration that gives two of them something to point at.
CREATE TYPE "WalletTransferState" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- The confirmation code is a message an operator writes, like every other
-- message this platform sends, so it is a template purpose rather than a string
-- in the code. The wording of "someone is spending your balance" is exactly the
-- kind of sentence a bakery should be able to get right without a deploy.
ALTER TYPE "MessageTemplatePurpose" ADD VALUE 'WALLET_TRANSFER_CODE';

CREATE TABLE "WalletTransfer" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "senderCustomerId" UUID NOT NULL,
  "recipientCustomerId" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "state" "WalletTransferState" NOT NULL DEFAULT 'PENDING',
  -- The code is never stored. A peppered digest can confirm the one the sender
  -- types and cannot be read back out of a database dump into a text message.
  "codeDigest" VARCHAR(128) NOT NULL,
  "codeExpiresAt" TIMESTAMP(3) NOT NULL,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_transfer_amount_check"
    CHECK ("amount" > 0 AND "failedAttempts" >= 0),
  -- Nobody transfers to themselves. It would be a pair of entries that cancel
  -- out, an SMS charge, and a statement that reads like a bug.
  CONSTRAINT "wallet_transfer_parties_check"
    CHECK ("senderCustomerId" <> "recipientCustomerId"),
  -- A settled transfer knows when; a pending one cannot claim to.
  CONSTRAINT "wallet_transfer_settled_shape_check"
    CHECK (("state" = 'PENDING') = ("settledAt" IS NULL)),
  CONSTRAINT "WalletTransfer_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletTransfer_senderCustomerId_fkey"
    FOREIGN KEY ("senderCustomerId") REFERENCES "Customer"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "WalletTransfer_recipientCustomerId_fkey"
    FOREIGN KEY ("recipientCustomerId") REFERENCES "Customer"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "WalletTransfer_tenant_sender_idempotency_key"
  ON "WalletTransfer"("tenantId", "senderCustomerId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_WalletTransfer_id_tenant_key" ON "WalletTransfer"("id", "tenantId");
-- What the sender's history screen reads, and what an expiry sweep scans.
CREATE INDEX "WalletTransfer_tenant_state_created_idx"
  ON "WalletTransfer"("tenantId", "state", "createdAt" DESC);

/**
 * A transfer's terminal states are terminal.
 *
 * Without this, a completed transfer could be walked back to PENDING and
 * confirmed a second time, moving the money twice off one code. The wallet
 * entry's idempotency key would catch it — but a guard that depends on another
 * table's index for a rule this table can state itself is a guard that stops
 * working the day somebody changes that index.
 */
CREATE FUNCTION guard_wallet_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'PENDING' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'A settled wallet transfer cannot change state';
  END IF;
  IF NEW."amount" <> OLD."amount"
     OR NEW."senderCustomerId" <> OLD."senderCustomerId"
     OR NEW."recipientCustomerId" <> OLD."recipientCustomerId"
     OR NEW."tenantId" <> OLD."tenantId" THEN
    RAISE EXCEPTION 'A wallet transfer cannot change who or how much';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "WalletTransfer_guard"
BEFORE UPDATE ON "WalletTransfer"
FOR EACH ROW EXECUTE FUNCTION guard_wallet_transfer();

CREATE TRIGGER "WalletTransfer_no_delete"
BEFORE DELETE ON "WalletTransfer"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

ALTER TABLE "WalletTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WalletTransfer"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The statement line says which transfer it belongs to, so "به ۰۹۱۲***۴۵۶۷"
-- can be rendered from the row rather than guessed from its timestamp.
ALTER TABLE "WalletEntry" ADD COLUMN "transferId" UUID;
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "WalletEntry_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "WalletTransfer"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Each side of a transfer appears exactly once, which is what makes replaying a
-- confirmation safe no matter how it is retried.
CREATE UNIQUE INDEX "WalletEntry_transfer_kind_key"
  ON "WalletEntry"("transferId", "kind") WHERE "transferId" IS NOT NULL;

ALTER TABLE "WalletTransfer"
  ADD CONSTRAINT "g3b_WalletTransfer_senderCustomerId_tenant_fk"
  FOREIGN KEY ("senderCustomerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletTransfer_senderCustomerId_tenant_idx"
  ON "WalletTransfer"("senderCustomerId", "tenantId");

ALTER TABLE "WalletTransfer"
  ADD CONSTRAINT "g3b_WalletTransfer_recipientCustomerId_tenant_fk"
  FOREIGN KEY ("recipientCustomerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletTransfer_recipientCustomerId_tenant_idx"
  ON "WalletTransfer"("recipientCustomerId", "tenantId");

ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "g3b_WalletEntry_transferId_tenant_fk"
  FOREIGN KEY ("transferId", "tenantId")
  REFERENCES "WalletTransfer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_WalletEntry_transferId_tenant_idx" ON "WalletEntry"("transferId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('WalletTransfer', 'senderCustomerId', 'Customer')
--    ('WalletTransfer', 'recipientCustomerId', 'Customer')
--    ('WalletEntry', 'transferId', 'WalletTransfer')
