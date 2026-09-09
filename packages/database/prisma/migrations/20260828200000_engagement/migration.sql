-- Coming back: ratings and favourites.
--
-- Bread is bought again. Not occasionally — most mornings, and usually the same
-- two or three loaves. The second order matters more than the first, and these
-- two tables are what let the platform earn it: a favourite is how somebody
-- says "this is my bread" before they have a history to repeat, and a rating is
-- how the platform learns which bakery is worth sending them back to.
--
-- Reorder needs no table at all. It reads a past order and rebuilds a basket at
-- today's prices, which is the only honest way to repeat one.

CREATE TABLE "OrderRating" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  -- Two scores rather than one. Two different things can go wrong and they
  -- belong to different people: the bread is the bakery's and the delivery is
  -- the courier's, and a single star that blames both teaches nobody anything.
  "breadScore" INTEGER NOT NULL,
  "deliveryScore" INTEGER,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderRating_pkey" PRIMARY KEY ("id"),
  -- The range the whole feature is read against. A score outside it would make
  -- every average since meaningless, and averages are what a partner's standing
  -- on the platform is judged on.
  CONSTRAINT "order_rating_score_check" CHECK (
    "breadScore" BETWEEN 1 AND 5
    AND ("deliveryScore" IS NULL OR "deliveryScore" BETWEEN 1 AND 5)
  ),
  CONSTRAINT "order_rating_comment_check" CHECK (
    "comment" IS NULL OR char_length("comment") <= 500
  ),
  CONSTRAINT "OrderRating_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "OrderRating_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "OrderRating_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "Customer"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- One rating per order. Not a policy the application remembers to apply: an
-- order somebody could rate twice is a bakery somebody could bury.
CREATE UNIQUE INDEX "OrderRating_orderId_key" ON "OrderRating"("orderId");
CREATE INDEX "OrderRating_tenantId_idx" ON "OrderRating"("tenantId");
CREATE INDEX "OrderRating_tenantId_createdAt_idx" ON "OrderRating"("tenantId", "createdAt");
ALTER TABLE "OrderRating"
  ADD CONSTRAINT "g3b_OrderRating_id_tenant_key" UNIQUE ("id", "tenantId");

CREATE TABLE "CustomerFavourite" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "bakeryProductOfferingId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerFavourite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerFavourite_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CustomerFavourite_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "Customer"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "CustomerFavourite_bakeryProductOfferingId_fkey" FOREIGN KEY ("bakeryProductOfferingId")
    REFERENCES "BakeryProductOffering"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Favouriting the same loaf twice is the same favourite. The unique key turns a
-- double tap into a no-op rather than a duplicate row nobody can clear.
CREATE UNIQUE INDEX "CustomerFavourite_identity_key"
  ON "CustomerFavourite"("tenantId", "customerId", "bakeryProductOfferingId");
CREATE INDEX "CustomerFavourite_tenantId_idx" ON "CustomerFavourite"("tenantId");
ALTER TABLE "CustomerFavourite"
  ADD CONSTRAINT "g3b_CustomerFavourite_id_tenant_key" UNIQUE ("id", "tenantId");

-- Row-level security, forced, on the same terms as every other tenant-owned
-- table: the tenant is read from the session variable, and a connection that
-- has not set one sees nothing at all.
ALTER TABLE "OrderRating" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderRating" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrderRating"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "CustomerFavourite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerFavourite" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CustomerFavourite"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A rating belongs to the customer whose order it was.
--
-- Row-level security separates tenants, not customers, so without this a
-- rating could be written against somebody else's order inside the same tenant
-- and there would be nothing in the database to say it was wrong. The
-- application checks it too; this is the line that holds if the application is
-- ever mistaken.
CREATE FUNCTION enforce_order_rating_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE order_customer UUID; order_tenant UUID;
BEGIN
  SELECT o."customerId", o."tenantId" INTO order_customer, order_tenant
  FROM "Order" o WHERE o."id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A rating must belong to an order that exists';
  END IF;
  IF order_tenant <> NEW."tenantId" OR order_customer <> NEW."customerId" THEN
    RAISE EXCEPTION 'A rating must be written by the customer whose order it is';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER enforce_order_rating_ownership_trigger
  BEFORE INSERT OR UPDATE ON "OrderRating"
  FOR EACH ROW EXECUTE FUNCTION enforce_order_rating_ownership();

-- Composite tenant foreign keys.
--
-- Every one of these says the same thing: a child row and the parent it points
-- at belong to the same tenant. A plain foreign key cannot say that, and
-- without it a row could reference a parent in another tenant that row-level
-- security would then happily hide — leaving a dangling pointer nobody can see
-- to diagnose.
ALTER TABLE "OrderRating"
  ADD CONSTRAINT "g3b_OrderRating_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderRating_orderId_tenant_idx" ON "OrderRating"("orderId", "tenantId");

ALTER TABLE "OrderRating"
  ADD CONSTRAINT "g3b_OrderRating_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_OrderRating_customerId_tenant_idx" ON "OrderRating"("customerId", "tenantId");

ALTER TABLE "CustomerFavourite"
  ADD CONSTRAINT "g3b_CustomerFavourite_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CustomerFavourite_customerId_tenant_idx"
  ON "CustomerFavourite"("customerId", "tenantId");

ALTER TABLE "CustomerFavourite"
  ADD CONSTRAINT "g3b_CustomerFavourite_bakeryProductOfferingId_tenant_fk"
  FOREIGN KEY ("bakeryProductOfferingId", "tenantId")
  REFERENCES "BakeryProductOffering" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CustomerFavourite_bakeryProductOfferingId_tenant_idx"
  ON "CustomerFavourite"("bakeryProductOfferingId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('OrderRating', 'orderId', 'Order')
--    ('OrderRating', 'customerId', 'Customer')
--    ('CustomerFavourite', 'customerId', 'Customer')
--    ('CustomerFavourite', 'bakeryProductOfferingId', 'BakeryProductOffering')
