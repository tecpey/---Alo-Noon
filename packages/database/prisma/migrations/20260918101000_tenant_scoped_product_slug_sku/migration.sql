-- A bread's slug and a variant's SKU, scoped to the shop that named them.
--
-- `Product.slug` carried a plain `@unique`, so one shop owned the word
-- `barbari` for the whole platform. This is not hypothetical: running
-- `bootstrap-launch.ts` against a database that already had a demo tenant
-- failed outright with a foreign-key violation, and the mechanism is worth
-- writing down because it is the shape this class of bug takes.
--
-- The script upserts on `where: { slug }`. With a global unique that matched
-- *another tenant's* row, took the `update` branch, and tried to point their
-- bread at this tenant's category — which the composite foreign key on
-- (categoryId, tenantId) then rejected. So the failure surfaced three steps
-- from its cause, as a P2003 on Product, and the only script whose job is
-- "bring up a tenant that can actually take an order" could not be run on a
-- database that had any other tenant in it.
--
-- `ProductVariant.sku` is the same thing one level down: a shop's own stock
-- code, which no shop should be able to take from another.
--
-- ## What is deliberately left global
--
-- `Order.publicId`, `Quote.publicId`, `Payment.publicId` and
-- `SupportCase.publicId` keep their platform-wide uniqueness, and that is not an
-- oversight. Those are generated here, from random bytes, and a customer reads
-- one down the phone to support. A code that identifies exactly one order on the
-- whole platform is worth more than one that needs a tenant beside it to mean
-- anything — the opposite trade to a slug, which a human chooses and which must
-- be allowed to repeat.
--
-- Weaker than what it replaces, so no existing row can violate it.

ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_slug_key";
DROP INDEX IF EXISTS "Product_slug_key";
CREATE UNIQUE INDEX "Product_tenant_slug_key" ON "Product" ("tenantId", "slug");

ALTER TABLE "ProductVariant" DROP CONSTRAINT IF EXISTS "ProductVariant_sku_key";
DROP INDEX IF EXISTS "ProductVariant_sku_key";
CREATE UNIQUE INDEX "ProductVariant_tenant_sku_key" ON "ProductVariant" ("tenantId", "sku");
