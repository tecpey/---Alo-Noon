-- A car is a separate tariff, not a surcharge, and each city sets its own limits.
--
-- The previous change made an order say which vehicle it needs. This one makes
-- that mean something in money, and stops the thresholds being one number in
-- the source that is right for Babol and wrong everywhere else.
--
-- ## Why a separate tariff rather than a multiplier
--
-- A car differs from a motorcycle in two ways that do not move together. Its
-- call-out is higher because the driver and the vehicle cost more to have
-- standing by, and its rate per kilometre is higher because it burns more fuel
-- and sits in traffic a motorcycle rides past. A single multiplier over the
-- motorcycle tariff would force one ratio onto both, so a city that got the
-- call-out right would have the distance wrong — and it would be wrong in the
-- direction of the long journeys, which is precisely where car orders live.
--
-- Two tariffs also inherit everything the existing one already has: its own
-- versioning, effective dating, free-delivery threshold and minimum order. A
-- bakery can decide that car deliveries have no free-delivery threshold at all
-- without that decision leaking onto the motorcycle rate.
--
-- ## The backfill is not a guess
--
-- Every existing row becomes MOTORCYCLE because that is what every one of them
-- already was: until an order could say it needed a car, every delivery this
-- platform priced was assumed to be on a motorcycle. The default is recorded
-- rather than inferred later.
--
-- The uniqueness key gains the vehicle for the same reason the tariffs are
-- separate: a car tariff and a motorcycle tariff for one zone are two lineages,
-- each versioned from 1. Sharing a version sequence would make publishing a new
-- car rate silently bump the motorcycle's number.
--
-- ## What happens when a city has no car tariff
--
-- The quote fails, loudly, and that is deliberate. The alternative is charging
-- the motorcycle rate for a car journey, which loses the bakery money on
-- exactly the largest and longest orders it takes — the ones it can least
-- afford to subsidise, and the ones where the loss is largest per order. A
-- refusal is visible on the first such order and fixed by configuring a tariff.
-- Silent underpricing is visible at the end of the month, in aggregate, when
-- the orders are already delivered.

ALTER TABLE "DeliveryPricingRule"
  ADD COLUMN "vehicleProfile" "RoutingProfile" NOT NULL DEFAULT 'MOTORCYCLE';

DROP INDEX IF EXISTS "DeliveryPricingRule_scope_version_key";
DROP INDEX IF EXISTS "DeliveryPricingRule_active_scope_idx";

CREATE UNIQUE INDEX "DeliveryPricingRule_scope_version_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "operationalZoneId", "vehicleProfile", "version");
CREATE INDEX "DeliveryPricingRule_active_scope_idx"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "operationalZoneId", "vehicleProfile", "isActive", "effectiveFrom");

-- Per city, because the geography is. Babol is a few kilometres across with its
-- industrial estates on the ring road; a city the size of Tehran has neither
-- property, and the same two numbers cannot be right for both.
--
-- Null means "nobody has measured this city yet, use the documented default" —
-- which is deliberately not the same as a tenant having chosen a number that
-- happens to equal the default. When the defaults are eventually replaced by
-- real measurements, the unmeasured cities should move and the measured ones
-- should not.
ALTER TABLE "City"
  ADD COLUMN "motorcycleItemLimit" INTEGER,
  ADD COLUMN "motorcycleRangeMetres" INTEGER;

-- A zero or negative limit is not a stricter policy, it is a city where nothing
-- can ever go by motorcycle — which is never what somebody means and is
-- indistinguishable, once stored, from a typo.
ALTER TABLE "City"
  ADD CONSTRAINT "City_motorcycleItemLimit_positive"
  CHECK ("motorcycleItemLimit" IS NULL OR "motorcycleItemLimit" > 0);
ALTER TABLE "City"
  ADD CONSTRAINT "City_motorcycleRangeMetres_positive"
  CHECK ("motorcycleRangeMetres" IS NULL OR "motorcycleRangeMetres" > 0);

-- The three partial indexes that would otherwise have made a car tariff
-- impossible to configure.
--
-- They are not in the Prisma schema — they are raw SQL from earlier migrations,
-- and they exist because Postgres treats NULLs as distinct in a unique index, so
-- the model-level uniqueness on (tenant, city, zone, version) constrains nothing
-- at all for the city-wide rules whose zone is NULL. These fill that hole, and
-- two of them go further: only one rule per scope may be active at a time.
--
-- That was exactly right while every delivery was a motorcycle. With two
-- vehicles it says a city may have an active motorcycle tariff or an active car
-- tariff and never both — which is the whole feature. Adding the column and
-- stopping here would have typechecked, passed the suite, and failed the first
-- time an operator tried to publish a car rate, with a duplicate-key error
-- naming an index they have never heard of.
--
-- Verified by attempting it against the real table before this was written: the
-- second insert was refused by "scope_version_null_zone_key".
--
-- The vehicle joins each key rather than relaxing any of them. One active
-- motorcycle tariff and one active car tariff per scope; still never two of
-- either, which is the ambiguity the originals were protecting against.

DROP INDEX IF EXISTS "DeliveryPricingRule_scope_version_null_zone_key";
CREATE UNIQUE INDEX "DeliveryPricingRule_scope_version_null_zone_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "vehicleProfile", "version")
  WHERE "operationalZoneId" IS NULL;

DROP INDEX IF EXISTS "DeliveryPricingRule_one_active_zone_scope_key";
CREATE UNIQUE INDEX "DeliveryPricingRule_one_active_zone_scope_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "operationalZoneId", "vehicleProfile")
  WHERE "isActive" AND "operationalZoneId" IS NOT NULL;

DROP INDEX IF EXISTS "DeliveryPricingRule_one_active_city_scope_key";
CREATE UNIQUE INDEX "DeliveryPricingRule_one_active_city_scope_key"
  ON "DeliveryPricingRule" ("tenantId", "cityId", "vehicleProfile")
  WHERE "isActive" AND "operationalZoneId" IS NULL;
