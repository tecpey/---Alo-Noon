-- Discount codes, and the ledger that stops one being spent twice.
--
-- `Quote.discountAmount` and `Order.discountAmount` have existed since the
-- money path was built. They flow through pricing, through the double-entry
-- ledger and into the financial reports, and they have been permanently zero
-- because nothing ever wrote them. This fills the intake.
--
-- The design decision that matters for growing past one city is `cityId`: a
-- campaign opened to launch one market cannot be spent by customers in another,
-- so a provincial rollout budget cannot be drained by the city it was not meant
-- for. Null means the campaign runs nationally.
--
-- The decision that matters for money is the redemption ledger. A redemption is
-- RESERVED when a quote is cut and only CONSUMED when an order is accepted, so
-- an abandoned checkout cannot burn a campaign's budget. A campaign capped at a
-- thousand would otherwise be exhausted by people who never bought anything.

CREATE TYPE "PromotionKind" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY');
CREATE TYPE "DiscountBasis" AS ENUM ('SUBTOTAL', 'DELIVERY_FEE');
CREATE TYPE "PromotionRedemptionState" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

CREATE TABLE "Promotion" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  -- Stored normalised: upper case, separators stripped. A customer typing
  -- "noon-10" and one typing "NOON 10" mean the same campaign.
  "code" VARCHAR(64) NOT NULL,
  "nameFa" TEXT NOT NULL,
  "kind" "PromotionKind" NOT NULL,
  -- Basis points, never a float. A percentage stored as 0.1 is a discount that
  -- is a fraction of a Rial out on every order, and nobody notices until a
  -- month is reconciled.
  "percentageBasisPoints" INTEGER,
  "fixedAmount" BIGINT,
  "maxDiscountAmount" BIGINT,
  "minSubtotalAmount" BIGINT,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3),
  "totalRedemptionLimit" INTEGER,
  "perCustomerLimit" INTEGER,
  "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
  "cityId" UUID,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  -- Counted rather than derived. The limit is enforced by a conditional update
  -- on this column, which is atomic; counting rows under concurrency is a race
  -- that hands out one more redemption than the campaign was budgeted for.
  "redeemedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id"),

  -- A percentage promotion has a percentage between nothing and everything; a
  -- fixed one has an amount above zero. Anything else is a campaign that either
  -- does nothing or pays customers to order, and both should be impossible to
  -- store rather than merely unlikely to be created.
  CONSTRAINT "promotion_shape_check" CHECK (
    (
      "kind" = 'PERCENTAGE'
      AND "percentageBasisPoints" IS NOT NULL
      AND "percentageBasisPoints" > 0
      AND "percentageBasisPoints" <= 10000
    ) OR (
      "kind" = 'FIXED_AMOUNT' AND "fixedAmount" IS NOT NULL AND "fixedAmount" > 0
    ) OR (
      "kind" = 'FREE_DELIVERY'
    )
  ),
  CONSTRAINT "promotion_amounts_check" CHECK (
    ("maxDiscountAmount" IS NULL OR "maxDiscountAmount" > 0)
    AND ("minSubtotalAmount" IS NULL OR "minSubtotalAmount" >= 0)
    AND "redeemedCount" >= 0
  ),
  CONSTRAINT "promotion_window_check" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
  CONSTRAINT "promotion_limits_check" CHECK (
    ("totalRedemptionLimit" IS NULL OR "totalRedemptionLimit" > 0)
    AND ("perCustomerLimit" IS NULL OR "perCustomerLimit" > 0)
  ),
  -- Never spend more than was budgeted. The service enforces this too; the
  -- database enforcing it means a bug in the service costs nothing.
  CONSTRAINT "promotion_budget_check" CHECK (
    "totalRedemptionLimit" IS NULL OR "redeemedCount" <= "totalRedemptionLimit"
  ),

  CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "Promotion_cityId_fkey" FOREIGN KEY ("cityId")
    REFERENCES "City"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "Promotion_tenant_code_key" ON "Promotion"("tenantId", "code");
CREATE INDEX "Promotion_tenantId_isActive_startsAt_idx"
  ON "Promotion"("tenantId", "isActive", "startsAt");
CREATE INDEX "Promotion_cityId_idx" ON "Promotion"("cityId");
ALTER TABLE "Promotion" ADD CONSTRAINT "g3b_Promotion_id_tenant_key" UNIQUE ("id", "tenantId");

CREATE TABLE "PromotionRedemption" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "promotionId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "quoteId" UUID,
  "orderId" UUID,
  -- Snapshotted. The campaign's terms may be edited tomorrow; what this
  -- customer was actually given must not change with them.
  "amount" BIGINT NOT NULL,
  "basis" "DiscountBasis" NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "state" "PromotionRedemptionState" NOT NULL DEFAULT 'RESERVED',
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_redemption_amount_check" CHECK ("amount" > 0),
  -- A consumed redemption belongs to an order. Without this a redemption could
  -- claim to be spent with nothing to show for it, and the campaign's spend
  -- would not reconcile against the orders it supposedly discounted.
  CONSTRAINT "promotion_redemption_consumed_check" CHECK (
    "state" <> 'CONSUMED' OR "orderId" IS NOT NULL
  ),
  CONSTRAINT "PromotionRedemption_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId")
    REFERENCES "Promotion"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PromotionRedemption_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "Customer"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PromotionRedemption_quoteId_fkey" FOREIGN KEY ("quoteId")
    REFERENCES "Quote"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "PromotionRedemption_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE UNIQUE INDEX "PromotionRedemption_quoteId_key" ON "PromotionRedemption"("quoteId");
CREATE UNIQUE INDEX "PromotionRedemption_orderId_key" ON "PromotionRedemption"("orderId");
CREATE INDEX "PromotionRedemption_scope_idx"
  ON "PromotionRedemption"("tenantId", "promotionId", "customerId", "state");
CREATE INDEX "PromotionRedemption_promotionId_state_idx"
  ON "PromotionRedemption"("promotionId", "state");
CREATE INDEX "PromotionRedemption_customerId_idx" ON "PromotionRedemption"("customerId");
ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "g3b_PromotionRedemption_id_tenant_key" UNIQUE ("id", "tenantId");

-- Which campaign priced a quote, and which one an order actually spent.
ALTER TABLE "Quote" ADD COLUMN "promotionId" UUID;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_promotionId_fkey" FOREIGN KEY ("promotionId")
  REFERENCES "Promotion"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "Quote_promotionId_idx" ON "Quote"("promotionId");

ALTER TABLE "Order" ADD COLUMN "promotionId" UUID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_promotionId_fkey" FOREIGN KEY ("promotionId")
  REFERENCES "Promotion"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "Order_promotionId_idx" ON "Order"("promotionId");

-- A discount that exceeds what is being bought would make a negative total, and
-- the first thing to notice would be the double-entry ledger refusing to
-- balance — a long way from the cause. These say so at the row.
ALTER TABLE "Quote" ADD CONSTRAINT "quote_discount_within_gross_check"
  CHECK ("discountAmount" >= 0 AND "discountAmount" <= "subtotalAmount" + "deliveryFeeAmount");
ALTER TABLE "Order" ADD CONSTRAINT "order_discount_within_gross_check"
  CHECK ("discountAmount" >= 0 AND "discountAmount" <= "subtotalAmount" + "deliveryFeeAmount");

-- A redemption may move RESERVED -> CONSUMED or RESERVED -> RELEASED, and
-- nowhere else. Re-consuming a released redemption, or releasing a consumed
-- one, would both let a campaign's spend drift away from the orders it paid
-- for.
CREATE OR REPLACE FUNCTION guard_promotion_redemption() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."promotionId" <> OLD."promotionId"
     OR NEW."customerId" <> OLD."customerId"
     OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."amount" <> OLD."amount" THEN
    RAISE EXCEPTION 'Promotion redemption identity and amount are immutable';
  END IF;
  IF OLD."state" <> 'RESERVED' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'A settled promotion redemption cannot change state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER promotion_redemption_guard
BEFORE UPDATE ON "PromotionRedemption"
FOR EACH ROW EXECUTE FUNCTION guard_promotion_redemption();

ALTER TABLE "Promotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Promotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Promotion"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "PromotionRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PromotionRedemption" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PromotionRedemption"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);


-- Composite tenant foreign keys.
--
-- Every one of these says the same thing: a child row and the parent it points
-- at belong to the same tenant. A plain foreign key cannot say that, and
-- without it a row could reference a parent in another tenant that row-level
-- security would then happily hide — leaving a dangling pointer nobody can see
-- to diagnose.
ALTER TABLE "Promotion"
  ADD CONSTRAINT "g3b_Promotion_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_Promotion_cityId_tenant_idx" ON "Promotion"("cityId", "tenantId");

ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "g3b_PromotionRedemption_promotionId_tenant_fk"
  FOREIGN KEY ("promotionId", "tenantId")
  REFERENCES "Promotion" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PromotionRedemption_promotionId_tenant_idx"
  ON "PromotionRedemption"("promotionId", "tenantId");

ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "g3b_PromotionRedemption_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PromotionRedemption_customerId_tenant_idx"
  ON "PromotionRedemption"("customerId", "tenantId");

ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "g3b_PromotionRedemption_quoteId_tenant_fk"
  FOREIGN KEY ("quoteId", "tenantId")
  REFERENCES "Quote" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PromotionRedemption_quoteId_tenant_idx"
  ON "PromotionRedemption"("quoteId", "tenantId");

ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "g3b_PromotionRedemption_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_PromotionRedemption_orderId_tenant_idx"
  ON "PromotionRedemption"("orderId", "tenantId");

ALTER TABLE "Quote"
  ADD CONSTRAINT "g3b_Quote_promotionId_tenant_fk"
  FOREIGN KEY ("promotionId", "tenantId")
  REFERENCES "Promotion" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_Quote_promotionId_tenant_idx" ON "Quote"("promotionId", "tenantId");

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_promotionId_tenant_fk"
  FOREIGN KEY ("promotionId", "tenantId")
  REFERENCES "Promotion" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_Order_promotionId_tenant_idx" ON "Order"("promotionId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('Promotion', 'cityId', 'City')
--    ('PromotionRedemption', 'promotionId', 'Promotion')
--    ('PromotionRedemption', 'customerId', 'Customer')
--    ('PromotionRedemption', 'quoteId', 'Quote')
--    ('PromotionRedemption', 'orderId', 'Order')
--    ('Quote', 'promotionId', 'Promotion')
--    ('Order', 'promotionId', 'Promotion')
