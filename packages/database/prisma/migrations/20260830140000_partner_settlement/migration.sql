-- Paying the people who baked and rode.
-- Until this migration, money arrived and stopped. A capture credited payment
-- clearing and nothing drew it down but a refund, so L_2200_BAKERY_PAYABLE and
-- L_2300_COURIER_PAYABLE had existed in every tenant's chart since the first
-- day and had never had a single entry posted against them. A platform in that
-- state can take orders indefinitely and cannot pay anybody, and its clearing
-- liability grows with every order it completes.
-- Three things arrive together, because any two of them alone would be worse
-- than none:
--   * the rates that say how an order divides,
--   * the earning, posted when the bread is delivered, which turns held money
--     into somebody's receivable and the platform's revenue,
--   * the payout, which discharges that receivable against the bank.
-- Stopping after the second would accumulate payables with no way to settle
-- them; stopping after the first would be two columns nothing reads.

-- The cost of a promotion, which is the platform's and nobody else's.
-- A discount reduces what the customer pays and does not reduce what the bakery
-- is owed — a promotion run to fill a slow Tuesday is not something the person
-- who baked the bread agreed to fund. That difference has to land somewhere,
-- and an expense account is what it is: money the platform chose to spend on
-- demand. It also makes "what did promotions cost us this month" one balance
-- rather than a query nobody will write.
-- Chart v4, additive and separate for the reason v3 was: v1's function ends by
-- asserting it produced exactly fourteen accounts, and editing its template in
-- place would break that assertion for every tenant already provisioned.

CREATE FUNCTION provision_tenant_promotion_chart_v4(
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
    p_tenant_id, 'chart-account-v4:PROMOTION_COST'
  );
  parent_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-account-v1:EXPENSES');
  bootstrap_id UUID := public.financial_deterministic_uuid(p_tenant_id, 'chart-bootstrap-v4');
BEGIN
  IF char_length(p_idempotency_key) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'Financial bootstrap idempotency key is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" WHERE "id" = p_tenant_id) THEN
    RAISE EXCEPTION 'Financial bootstrap tenant does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount"
    WHERE "id" = parent_id AND "tenantId" = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Financial chart v4 requires v1 to be provisioned first';
  END IF;

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  INSERT INTO public."LedgerAccount" (
    "id", "tenantId", "parentId", "code", "name", "type", "currency",
    "isSystem", "isPostable", "isActive", "systemKey", "templateVersion",
    "governanceVersion", "createdAt", "updatedAt"
  ) VALUES (
    account_id, p_tenant_id, parent_id, 'X_5300_PROMOTION',
    'Promotion cost', 'EXPENSE', 'IRR',
    true, true, true, 'PROMOTION_COST', 4, 1,
    p_occurred_at, p_occurred_at
  ) ON CONFLICT ("tenantId", "code") DO NOTHING;

  -- The same fail-closed check the other versions make: an account that exists
  -- but does not match the template is a chart somebody edited, and posting
  -- into it would put money somewhere nobody expects.
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerAccount" account
    WHERE account."id" = account_id AND account."tenantId" = p_tenant_id
      AND account."parentId" = parent_id
      AND account."code" = 'X_5300_PROMOTION'
      AND account."type" = 'EXPENSE' AND account."currency" = 'IRR'
      AND account."isSystem" AND account."isPostable"
      AND account."systemKey" = 'PROMOTION_COST'
      AND account."templateVersion" = 4
  ) THEN
    RAISE EXCEPTION 'Financial chart conflicts with reserved account X_5300_PROMOTION';
  END IF;

  INSERT INTO public."LedgerAccountGovernanceEvent" (
    "id", "tenantId", "ledgerAccountId", "action", "fromActive", "toActive",
    "actorType", "version", "idempotencyKey", "reason", "correlationId", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-governance-v4:PROMOTION_COST'),
    p_tenant_id, account_id, 'PROVISIONED', NULL, true, 'SYSTEM', 1,
    'chart-v4-provisioned:PROMOTION', 'System chart template v4',
    p_correlation_id, p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;

  INSERT INTO public."TenantFinancialBootstrap" (
    "id", "tenantId", "templateVersion", "accountCount", "idempotencyKey",
    "correlationId", "completedAt"
  ) VALUES (
    bootstrap_id, p_tenant_id, 4, 1, p_idempotency_key, p_correlation_id, p_occurred_at
  ) ON CONFLICT ("tenantId", "templateVersion") DO NOTHING;

  INSERT INTO public."AuditEvent" (
    "id", "tenantId", "actorType", "action", "entityType", "entityId",
    "summary", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    public.financial_deterministic_uuid(p_tenant_id, 'chart-audit-v4'),
    p_tenant_id, 'SYSTEM', 'financial.chart.provisioned', 'LedgerAccount', account_id,
    'Provisioned system chart of accounts v4', p_correlation_id,
    jsonb_build_object('templateVersion', 4, 'accountCount', 1), p_occurred_at
  ) ON CONFLICT ("id") DO NOTHING;
END $$;

GRANT EXECUTE ON FUNCTION provision_tenant_promotion_chart_v4(UUID, TEXT, UUID, TIMESTAMP) TO PUBLIC;

DO $$
DECLARE tenant_record RECORD;
BEGIN
  FOR tenant_record IN SELECT "id", "createdAt" FROM "Tenant" ORDER BY "id" LOOP
    PERFORM provision_tenant_promotion_chart_v4(
      tenant_record."id", 'automatic-chart-bootstrap-v4',
      financial_deterministic_uuid(tenant_record."id", 'chart-correlation-v4'),
      tenant_record."createdAt"
    );
  END LOOP;
END $$;

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
  PERFORM public.provision_tenant_promotion_chart_v4(
    NEW."id", 'automatic-chart-bootstrap-v4',
    public.financial_deterministic_uuid(NEW."id", 'chart-correlation-v4'),
    NEW."createdAt"
  );
  RETURN NEW;
END $$;

-- The general journal stops being a payment journal.
-- `FinancialTransaction.paymentId` has been mandatory since the ledger was
-- built, which was true when payments were the only thing that moved money. A
-- settlement is about an order and a payout is about neither — the money leaves
-- for a bakery's bank account, and there is no payment anywhere in the story.
-- So the column becomes nullable behind a check that states the shape of each
-- type, and the balance guard below learns the two new ones. The check matters
-- more than the nullability: without it, a capture that simply lost its payment
-- would post cleanly and be invisible to every reconciliation that reads the
-- ledger by payment.
ALTER TYPE "FinancialTransactionType" ADD VALUE 'ORDER_SETTLEMENT';
ALTER TYPE "FinancialTransactionType" ADD VALUE 'PARTNER_PAYOUT';

ALTER TABLE "FinancialTransaction" ALTER COLUMN "paymentId" DROP NOT NULL;

-- Compared as text, not as the enum: the two values above are added by this
-- same migration, and PostgreSQL refuses to evaluate a value added by a
-- transaction that has not committed.
ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "financial_transaction_payment_shape_check" CHECK (
    ("type"::text IN ('ORDER_SETTLEMENT', 'PARTNER_PAYOUT') AND "paymentId" IS NULL)
    OR ("type"::text NOT IN ('ORDER_SETTLEMENT', 'PARTNER_PAYOUT') AND "paymentId" IS NOT NULL)
  );

-- And the order shape follows the same rule, restated for the two new types: a
-- settlement names the order it divided, a payout names none.
ALTER TABLE "FinancialTransaction"
  DROP CONSTRAINT "financial_transaction_order_shape_check";
ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "financial_transaction_order_shape_check" CHECK (
    ("type"::text IN ('WALLET_TOP_UP', 'PARTNER_PAYOUT') AND "orderId" IS NULL)
    OR ("type"::text NOT IN ('WALLET_TOP_UP', 'PARTNER_PAYOUT') AND "orderId" IS NOT NULL)
  );

-- The rates that say how an order divides.
-- Basis points, not a decimal. A percentage held as a float is a rounding
-- argument with a partner, once a month, forever — and the argument is always
-- about the platform's favour, because that is the direction a float drifts
-- when somebody writes the multiplication carelessly.
-- Defaults: fifteen percent of the bread to the platform, and the whole
-- delivery fee to the courier partner. The second is the pilot's actual
-- position — the platform earns on bread, and delivery is passed through at
-- cost — and it is a number an operator changes rather than a number this
-- migration decides forever.
ALTER TABLE "Bakery"
  ADD COLUMN "commissionBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  ADD CONSTRAINT "bakery_commission_range_check"
    CHECK ("commissionBasisPoints" BETWEEN 0 AND 10000);

ALTER TABLE "CourierPartner"
  ADD COLUMN "deliveryShareBasisPoints" INTEGER NOT NULL DEFAULT 10000,
  ADD CONSTRAINT "courier_partner_share_range_check"
    CHECK ("deliveryShareBasisPoints" BETWEEN 0 AND 10000);

-- What one delivered order was worth to each party.
-- One row per order, written when it completes, never rewritten. It is not a
-- cache of the ledger — the ledger is the authority — it is the record of
-- *which rates applied on the day*, so a bakery whose commission changes in
-- March cannot make February's payout recompute itself into a different number.
CREATE TABLE "OrderEarning" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "bakeryId" UUID NOT NULL,
  -- Null when nobody was assigned: a collected order, or one a courier never
  -- took. The bakery is still owed; there is simply nobody to pay for a ride.
  "courierPartnerId" UUID,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "subtotalAmount" BIGINT NOT NULL,
  "deliveryFeeAmount" BIGINT NOT NULL,
  "discountAmount" BIGINT NOT NULL,
  "totalAmount" BIGINT NOT NULL,
  "commissionBasisPoints" INTEGER NOT NULL,
  "courierBasisPoints" INTEGER NOT NULL,
  "commissionAmount" BIGINT NOT NULL,
  "bakeryShareAmount" BIGINT NOT NULL,
  "courierShareAmount" BIGINT NOT NULL,
  "promotionCostAmount" BIGINT NOT NULL,
  -- Set when a payout run has claimed this earning. Two columns rather than
  -- one, because a bakery and a courier are paid on different days by different
  -- people, and an earning is only fully discharged when both have been.
  "bakeryPayoutId" UUID,
  "courierPayoutId" UUID,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderEarning_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_earning_amounts_check" CHECK (
    "subtotalAmount" >= 0 AND "deliveryFeeAmount" >= 0 AND "discountAmount" >= 0
    AND "totalAmount" > 0 AND "commissionAmount" >= 0 AND "bakeryShareAmount" >= 0
    AND "courierShareAmount" >= 0 AND "promotionCostAmount" >= 0
    AND "commissionAmount" + "bakeryShareAmount" = "subtotalAmount"
    AND "totalAmount" = "subtotalAmount" + "deliveryFeeAmount" - "discountAmount"
  ),
  CONSTRAINT "order_earning_rate_range_check" CHECK (
    "commissionBasisPoints" BETWEEN 0 AND 10000
    AND "courierBasisPoints" BETWEEN 0 AND 10000
  ),
  -- A courier share with nobody to pay it to is money owed to nobody.
  CONSTRAINT "order_earning_courier_shape_check" CHECK (
    "courierPartnerId" IS NOT NULL OR "courierShareAmount" = 0
  ),
  CONSTRAINT "order_earning_courier_payout_shape_check" CHECK (
    "courierPayoutId" IS NULL OR "courierPartnerId" IS NOT NULL
  ),
  CONSTRAINT "OrderEarning_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "OrderEarning_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "OrderEarning_bakeryId_fkey"
    FOREIGN KEY ("bakeryId") REFERENCES "Bakery"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "OrderEarning_courierPartnerId_fkey"
    FOREIGN KEY ("courierPartnerId") REFERENCES "CourierPartner"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

-- One earning per order. This is what makes completing an order twice — a
-- retried request, a duplicated event — credit a bakery once.
CREATE UNIQUE INDEX "OrderEarning_orderId_key" ON "OrderEarning"("orderId");
CREATE UNIQUE INDEX "g3b_OrderEarning_id_tenant_key" ON "OrderEarning"("id", "tenantId");
-- What a payout run scans: everything a partner has earned and not been paid.
CREATE INDEX "OrderEarning_bakery_unpaid_idx"
  ON "OrderEarning"("tenantId", "bakeryId", "occurredAt")
  WHERE "bakeryPayoutId" IS NULL;
CREATE INDEX "OrderEarning_courier_unpaid_idx"
  ON "OrderEarning"("tenantId", "courierPartnerId", "occurredAt")
  WHERE "courierPayoutId" IS NULL AND "courierPartnerId" IS NOT NULL;

CREATE TYPE "PartnerPayoutParty" AS ENUM ('BAKERY', 'COURIER');
CREATE TYPE "PartnerPayoutState" AS ENUM ('DRAFT', 'PAID', 'CANCELLED');

-- One transfer to one partner, covering a set of earnings.
-- Two states that matter and one that admits reality: a run is prepared, then
-- somebody actually sends the money and records the bank's reference. The
-- money leaves the platform's account outside this system — an Iranian
-- interbank transfer is a person at a keyboard — so what is stored is the
-- decision and its evidence, not a pretence of having moved it.
CREATE TABLE "PartnerPayout" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "party" "PartnerPayoutParty" NOT NULL,
  -- Exactly one of these, matching the party. A payout to both at once would be
  -- one transfer nobody could reconcile.
  "bakeryId" UUID,
  "courierPartnerId" UUID,
  "state" "PartnerPayoutState" NOT NULL DEFAULT 'DRAFT',
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "amount" BIGINT NOT NULL,
  "orderCount" INTEGER NOT NULL,
  -- The window the run covered, so two runs cannot silently overlap and a
  -- partner can be told which days they were paid for.
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  -- The bank's own reference for the transfer, once somebody has made it.
  "bankReference" VARCHAR(128),
  "preparedByAccountId" UUID NOT NULL,
  "paidByAccountId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "PartnerPayout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_payout_amount_check" CHECK ("amount" > 0 AND "orderCount" > 0),
  CONSTRAINT "partner_payout_period_check" CHECK ("periodEnd" > "periodStart"),
  CONSTRAINT "partner_payout_party_shape_check" CHECK (
    ("party" = 'BAKERY' AND "bakeryId" IS NOT NULL AND "courierPartnerId" IS NULL)
    OR ("party" = 'COURIER' AND "courierPartnerId" IS NOT NULL AND "bakeryId" IS NULL)
  ),
  -- A paid payout knows when, by whom, and against what reference; a draft
  -- cannot claim any of it.
  CONSTRAINT "partner_payout_paid_shape_check" CHECK (
    ("state" = 'PAID') = ("paidAt" IS NOT NULL)
    AND ("state" = 'PAID') = ("paidByAccountId" IS NOT NULL)
    AND ("state" = 'PAID') = ("bankReference" IS NOT NULL)
  ),
  CONSTRAINT "PartnerPayout_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PartnerPayout_bakeryId_fkey"
    FOREIGN KEY ("bakeryId") REFERENCES "Bakery"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PartnerPayout_courierPartnerId_fkey"
    FOREIGN KEY ("courierPartnerId") REFERENCES "CourierPartner"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "PartnerPayout_tenant_idempotency_key"
  ON "PartnerPayout"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_PartnerPayout_id_tenant_key" ON "PartnerPayout"("id", "tenantId");
CREATE INDEX "PartnerPayout_tenant_state_created_idx"
  ON "PartnerPayout"("tenantId", "state", "createdAt" DESC);

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "OrderEarning_bakeryPayoutId_fkey"
  FOREIGN KEY ("bakeryPayoutId") REFERENCES "PartnerPayout"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "OrderEarning_courierPayoutId_fkey"
  FOREIGN KEY ("courierPayoutId") REFERENCES "PartnerPayout"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- An earning is a fact about an order that has already been delivered.
-- Nothing about the money may change after it is written: the rates that
-- applied, the shares they produced, and which order they belong to are the
-- evidence behind a posting the ledger has already made. Only the two payout
-- links move, and only from empty to set — a partner cannot be un-paid by an
-- UPDATE, and a payout cannot quietly reassign somebody else's earnings.
CREATE FUNCTION guard_order_earning()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId"
     OR NEW."orderId" <> OLD."orderId"
     OR NEW."bakeryId" <> OLD."bakeryId"
     OR NEW."courierPartnerId" IS DISTINCT FROM OLD."courierPartnerId"
     OR NEW."subtotalAmount" <> OLD."subtotalAmount"
     OR NEW."deliveryFeeAmount" <> OLD."deliveryFeeAmount"
     OR NEW."discountAmount" <> OLD."discountAmount"
     OR NEW."totalAmount" <> OLD."totalAmount"
     OR NEW."commissionBasisPoints" <> OLD."commissionBasisPoints"
     OR NEW."courierBasisPoints" <> OLD."courierBasisPoints"
     OR NEW."commissionAmount" <> OLD."commissionAmount"
     OR NEW."bakeryShareAmount" <> OLD."bakeryShareAmount"
     OR NEW."courierShareAmount" <> OLD."courierShareAmount"
     OR NEW."promotionCostAmount" <> OLD."promotionCostAmount" THEN
    RAISE EXCEPTION 'An order earning is immutable once posted';
  END IF;
  IF OLD."bakeryPayoutId" IS NOT NULL AND NEW."bakeryPayoutId" IS DISTINCT FROM OLD."bakeryPayoutId" THEN
    RAISE EXCEPTION 'An earning already paid to a bakery cannot be reassigned';
  END IF;
  IF OLD."courierPayoutId" IS NOT NULL AND NEW."courierPayoutId" IS DISTINCT FROM OLD."courierPayoutId" THEN
    RAISE EXCEPTION 'An earning already paid to a courier cannot be reassigned';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OrderEarning_guard"
BEFORE UPDATE ON "OrderEarning"
FOR EACH ROW EXECUTE FUNCTION guard_order_earning();

CREATE TRIGGER "OrderEarning_no_delete"
BEFORE DELETE ON "OrderEarning"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

-- A payout that has been made cannot be unmade, and its money cannot change.
-- The transfer happened at a bank. Editing the amount afterwards would make the
-- record disagree with the statement, and the record is the only thing anybody
-- will have when a partner asks why they were paid what they were paid.
CREATE FUNCTION guard_partner_payout()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'A settled partner payout cannot change state';
  END IF;
  IF NEW."amount" <> OLD."amount"
     OR NEW."orderCount" <> OLD."orderCount"
     OR NEW."party" <> OLD."party"
     OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."bakeryId" IS DISTINCT FROM OLD."bakeryId"
     OR NEW."courierPartnerId" IS DISTINCT FROM OLD."courierPartnerId" THEN
    RAISE EXCEPTION 'A partner payout cannot change who or how much';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PartnerPayout_guard"
BEFORE UPDATE ON "PartnerPayout"
FOR EACH ROW EXECUTE FUNCTION guard_partner_payout();

CREATE TRIGGER "PartnerPayout_no_delete"
BEFORE DELETE ON "PartnerPayout"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

ALTER TABLE "OrderEarning" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderEarning" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrderEarning"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "PartnerPayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerPayout" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PartnerPayout"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "g3b_OrderEarning_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderEarning_orderId_tenant_idx" ON "OrderEarning"("orderId", "tenantId");

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "g3b_OrderEarning_bakeryId_tenant_fk"
  FOREIGN KEY ("bakeryId", "tenantId")
  REFERENCES "Bakery" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderEarning_bakeryId_tenant_idx" ON "OrderEarning"("bakeryId", "tenantId");

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "g3b_OrderEarning_courierPartnerId_tenant_fk"
  FOREIGN KEY ("courierPartnerId", "tenantId")
  REFERENCES "CourierPartner" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderEarning_courierPartnerId_tenant_idx"
  ON "OrderEarning"("courierPartnerId", "tenantId");

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "g3b_OrderEarning_bakeryPayoutId_tenant_fk"
  FOREIGN KEY ("bakeryPayoutId", "tenantId")
  REFERENCES "PartnerPayout" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderEarning_bakeryPayoutId_tenant_idx"
  ON "OrderEarning"("bakeryPayoutId", "tenantId");

ALTER TABLE "OrderEarning"
  ADD CONSTRAINT "g3b_OrderEarning_courierPayoutId_tenant_fk"
  FOREIGN KEY ("courierPayoutId", "tenantId")
  REFERENCES "PartnerPayout" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderEarning_courierPayoutId_tenant_idx"
  ON "OrderEarning"("courierPayoutId", "tenantId");

ALTER TABLE "PartnerPayout"
  ADD CONSTRAINT "g3b_PartnerPayout_bakeryId_tenant_fk"
  FOREIGN KEY ("bakeryId", "tenantId")
  REFERENCES "Bakery" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PartnerPayout_bakeryId_tenant_idx" ON "PartnerPayout"("bakeryId", "tenantId");

ALTER TABLE "PartnerPayout"
  ADD CONSTRAINT "g3b_PartnerPayout_courierPartnerId_tenant_fk"
  FOREIGN KEY ("courierPartnerId", "tenantId")
  REFERENCES "CourierPartner" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PartnerPayout_courierPartnerId_tenant_idx"
  ON "PartnerPayout"("courierPartnerId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('OrderEarning', 'orderId', 'Order')
--    ('OrderEarning', 'bakeryId', 'Bakery')
--    ('OrderEarning', 'courierPartnerId', 'CourierPartner')
--    ('OrderEarning', 'bakeryPayoutId', 'PartnerPayout')
--    ('OrderEarning', 'courierPayoutId', 'PartnerPayout')
--    ('PartnerPayout', 'bakeryId', 'Bakery')
--    ('PartnerPayout', 'courierPartnerId', 'CourierPartner')

-- The double-entry guard learns two postings with no payment behind them.
-- The join to Payment has to become an outer one or every settlement and every
-- payout would be silently unguarded: the function returns early when the row
-- is not found, which for a posting with no payment would mean no check at all
-- rather than a failed one. That is the same trap the wallet top-up sprang, and
-- it is worth restating because the shape of this function invites it.
--   ORDER_SETTLEMENT  no payment, and an order that has actually been delivered
--   PARTNER_PAYOUT    no payment and no order; the money left for a bank
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

  states_agree := CASE transaction_type
    WHEN 'PAYMENT_CAPTURE'  THEN payment_state = 'CAPTURED' AND order_payment_state = 'PAID'
    WHEN 'PAYMENT_REFUND'   THEN payment_state = 'REFUNDED' AND order_payment_state = 'REFUNDED'
    WHEN 'WALLET_TOP_UP'    THEN payment_state = 'CAPTURED' AND payment_purpose = 'WALLET_TOP_UP'
                                 AND transaction_order IS NULL AND payment_order IS NULL
    -- An order is divided when it has been delivered, never before. Splitting
    -- earlier would credit a bakery for bread that may yet be cancelled.
    WHEN 'ORDER_SETTLEMENT' THEN order_state = 'COMPLETED' AND order_payment_state = 'PAID'
    WHEN 'PARTNER_PAYOUT'   THEN TRUE
    ELSE FALSE
  END;

  -- A top-up and a payout name no order; everything else names the one it is
  -- about, and for the payment-backed types that must be the payment's own.
  order_agrees := CASE
    WHEN transaction_type IN ('WALLET_TOP_UP', 'PARTNER_PAYOUT') THEN transaction_order IS NULL
    WHEN transaction_type = 'ORDER_SETTLEMENT' THEN transaction_order IS NOT NULL
    ELSE payment_order = transaction_order
  END;

  -- A posting with a payment must match its amount and currency exactly. One
  -- without a payment has no amount to match, and the balance below is the
  -- whole of its arithmetic.
  payment_agrees := CASE
    WHEN transaction_type IN ('ORDER_SETTLEMENT', 'PARTNER_PAYOUT')
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
