-- Three codes that were unique across every tenant on the platform.
--
-- `City.code`, `ProductCategory.code` and `CourierPartner.code` each carried a
-- plain `@unique`, which in a system where every other table is fenced by RLS on
-- `app.tenant_id` means one shop could take a word away from all the others. The
-- first tenant to create a category called `SANGAK` owned `SANGAK`; the second
-- bakery in the second town got a constraint violation for naming their sangak
-- after sangak.
--
-- This was not theoretical and it was not unnoticed. `admin-catalog.ts` carries
-- a comment saying "the code is globally unique in the schema, not per tenant",
-- and turns the collision into a 409 `CATEGORY_CODE_TAKEN` — a clean error for
-- something that should never have been an error. Every fixture in the
-- repository works around it too, with codes like `TRAD-145D7F` and
-- `DLV-61CCB2C8`: a random suffix bolted on to keep out of other tenants' way.
--
-- The cost of leaving it grows in exactly the wrong direction. With one tenant
-- it is invisible. With two it is a support ticket. Once both have real rows,
-- renaming a code means rewriting every foreign key that points at it, so this
-- is the last cheap moment to fix it.
--
-- The new constraint is strictly weaker than the old one — every row that
-- satisfied a global unique satisfies a tenant-scoped one — so there is no data
-- to clean up first and nothing here can fail on existing rows.
--
-- `OperationalZone`, `ServiceArea` and `BakeryBranch` carry codes with no
-- uniqueness at all. That is a different defect and is deliberately not fixed
-- here: adding a constraint to them *can* fail on existing data, so it wants its
-- own migration with a look at what is actually in those columns first.

ALTER TABLE "City" DROP CONSTRAINT IF EXISTS "City_code_key";
DROP INDEX IF EXISTS "City_code_key";
CREATE UNIQUE INDEX "City_tenant_code_key" ON "City" ("tenantId", "code");

ALTER TABLE "ProductCategory" DROP CONSTRAINT IF EXISTS "ProductCategory_code_key";
DROP INDEX IF EXISTS "ProductCategory_code_key";
CREATE UNIQUE INDEX "ProductCategory_tenant_code_key" ON "ProductCategory" ("tenantId", "code");

ALTER TABLE "CourierPartner" DROP CONSTRAINT IF EXISTS "CourierPartner_code_key";
DROP INDEX IF EXISTS "CourierPartner_code_key";
CREATE UNIQUE INDEX "CourierPartner_tenant_code_key" ON "CourierPartner" ("tenantId", "code");
