-- Routing: who measures the road, and what we keep from them.
--
-- Delivery has been priced on the straight line since the beginning, which is
-- wrong in a specific direction: a river or a one-way system puts two points
-- 800 metres apart and twenty minutes of riding, and the bakery absorbs the
-- difference on every order. These two tables are what it takes to price the
-- road instead — a per-tenant routing engine, and a cache of what it said.

CREATE TYPE "RoutingEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "RoutingProviderHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "RoutingProfile" AS ENUM ('MOTORCYCLE', 'CAR');

-- Shaped like the SMS gateway configuration on purpose: an operator already
-- knows this form from the admin panel, and the difference between a routing
-- engine and an SMS gateway is not one they should have to relearn.
--
-- `env://` is permitted here, unlike payment credentials. A routing key buys
-- distances, not money: the worst a leaked one does is spend the tenant's
-- routing quota, which is recoverable in a way a drained merchant account is not.
CREATE TABLE "RoutingProviderConfiguration" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerCode" VARCHAR(32) NOT NULL,
  "adapterVersion" VARCHAR(64) NOT NULL,
  "adapterSpiVersion" INTEGER NOT NULL DEFAULT 1,
  "environment" "RoutingEnvironment" NOT NULL,
  "credentialReference" VARCHAR(255) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "healthStatus" "RoutingProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "governanceVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoutingProviderConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "routing_provider_code_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "routing_provider_adapter_version_check" CHECK (
    "adapterVersion" ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT "routing_provider_spi_check" CHECK ("adapterSpiVersion" = 1),
  CONSTRAINT "routing_provider_reference_check" CHECK (
    "credentialReference" ~ '^(env|vault|aws-sm|gcp-sm|azure-kv)://[A-Za-z0-9_./:-]{1,240}$'
  ),
  CONSTRAINT "routing_provider_bounds_check" CHECK (
    "priority" BETWEEN 1 AND 1000
    AND "governanceVersion" > 0
    -- A disabled default would be selected and then refuse to run.
    AND (NOT "isDefault" OR "enabled")
  )
);

CREATE UNIQUE INDEX "RoutingProvider_tenant_code_environment_version_key"
  ON "RoutingProviderConfiguration"(
    "tenantId", "providerCode", "environment", "adapterVersion", "adapterSpiVersion"
  );

-- One default per tenant per environment, enforced by the database rather than
-- by whoever writes the selection query next.
CREATE UNIQUE INDEX "RoutingProvider_tenant_environment_default_key"
  ON "RoutingProviderConfiguration"("tenantId", "environment")
  WHERE "isDefault";

CREATE INDEX "RoutingProvider_tenant_environment_enabled_idx"
  ON "RoutingProviderConfiguration"("tenantId", "environment", "enabled", "isDefault");

-- What the engine said, kept so it is not asked twice.
--
-- Every routing call is money, and a bakery delivers from the same branch to the
-- same streets all week, so this is not an optimisation to add later — it is the
-- difference between a routing bill that tracks orders and one that tracks
-- checkouts.
--
-- Only routed distances live here. There is deliberately no row for a
-- straight-line estimate: caching a fallback would freeze it in place long after
-- routing recovered, turning a ten-minute outage into a fortnight of guessed
-- fares that nothing would ever correct.
CREATE TABLE "RouteEstimate" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "bakeryBranchId" UUID NOT NULL,
  -- Rounded to four places (about eleven metres) before storage, so a saved
  -- address ordered from twice produces the same key instead of missing on
  -- floating-point noise.
  "destinationLatitude" DECIMAL(9, 4) NOT NULL,
  "destinationLongitude" DECIMAL(9, 4) NOT NULL,
  "profile" "RoutingProfile" NOT NULL,
  "avoidTrafficZone" BOOLEAN NOT NULL,
  "avoidOddEvenZone" BOOLEAN NOT NULL,
  -- Two engines disagree about the same road, so a cached distance belongs to
  -- the engine that produced it and switching providers misses rather than
  -- serving someone else's numbers.
  "providerCode" VARCHAR(32) NOT NULL,
  "distanceMetres" INTEGER NOT NULL,
  "durationSeconds" INTEGER,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RouteEstimate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "route_estimate_provider_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "route_estimate_coordinates_check" CHECK (
    "destinationLatitude" BETWEEN -90 AND 90
    AND "destinationLongitude" BETWEEN -180 AND 180
  ),
  -- A negative distance is impossible and a distance longer than Iran is a
  -- misread response, not a delivery. Both would reach a customer as a fare.
  CONSTRAINT "route_estimate_measurement_check" CHECK (
    "distanceMetres" >= 0
    AND "distanceMetres" <= 2000000
    AND ("durationSeconds" IS NULL OR "durationSeconds" >= 0)
  )
);

CREATE UNIQUE INDEX "RouteEstimate_lookup_key"
  ON "RouteEstimate"(
    "tenantId", "bakeryBranchId", "destinationLatitude", "destinationLongitude",
    "profile", "avoidTrafficZone", "avoidOddEvenZone", "providerCode"
  );

-- Sweeping expired rows walks this rather than the whole table.
CREATE INDEX "RouteEstimate_tenant_computed_idx" ON "RouteEstimate"("tenantId", "computedAt");

CREATE INDEX "g3b_RouteEstimate_bakeryBranchId_tenant_idx"
  ON "RouteEstimate"("bakeryBranchId", "tenantId");

ALTER TABLE "RoutingProviderConfiguration"
  ADD CONSTRAINT "RoutingProviderConfiguration_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RouteEstimate"
  ADD CONSTRAINT "RouteEstimate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite, so an estimate can never point at another tenant's branch.
ALTER TABLE "RouteEstimate"
  ADD CONSTRAINT "g3b_RouteEstimate_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The identity of a configuration is what an adapter was resolved against; a
-- configuration that changed its provider or environment under a running system
-- would be a different gateway wearing the same id.
CREATE OR REPLACE FUNCTION guard_routing_provider_configuration()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId"
    OR NEW."providerCode" <> OLD."providerCode"
    OR NEW."environment" <> OLD."environment"
    OR NEW."adapterVersion" <> OLD."adapterVersion"
    OR NEW."adapterSpiVersion" <> OLD."adapterSpiVersion"
  THEN
    RAISE EXCEPTION 'Routing provider configuration identity is immutable';
  END IF;
  IF NEW."governanceVersion" <= OLD."governanceVersion" THEN
    RAISE EXCEPTION 'Routing provider governance version must increase';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER routing_provider_configuration_guard
BEFORE UPDATE ON "RoutingProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION guard_routing_provider_configuration();

-- A cached measurement is a fact about a road at a moment. Rewriting one in
-- place would silently restate history for every fare already explained by it,
-- so a refresh replaces the row's measurement and its timestamp together, and
-- nothing else about it may move.
CREATE OR REPLACE FUNCTION guard_route_estimate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId"
    OR NEW."bakeryBranchId" <> OLD."bakeryBranchId"
    OR NEW."destinationLatitude" <> OLD."destinationLatitude"
    OR NEW."destinationLongitude" <> OLD."destinationLongitude"
    OR NEW."profile" <> OLD."profile"
    OR NEW."avoidTrafficZone" <> OLD."avoidTrafficZone"
    OR NEW."avoidOddEvenZone" <> OLD."avoidOddEvenZone"
    OR NEW."providerCode" <> OLD."providerCode"
  THEN
    RAISE EXCEPTION 'Route estimate identity is immutable';
  END IF;
  IF NEW."distanceMetres" <> OLD."distanceMetres" AND NEW."computedAt" <= OLD."computedAt" THEN
    RAISE EXCEPTION 'A re-measured route estimate must carry a newer computedAt';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER route_estimate_guard
BEFORE UPDATE ON "RouteEstimate"
FOR EACH ROW EXECUTE FUNCTION guard_route_estimate();

ALTER TABLE "RoutingProviderConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoutingProviderConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RoutingProviderConfiguration"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "RouteEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteEstimate" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RouteEstimate"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('RouteEstimate', 'bakeryBranchId', 'BakeryBranch')

-- A fare a customer disputes has to be explainable, and "the routing service was
-- unreachable, so we scaled the straight line" is an answer. A number nobody can
-- account for is not — so every quote now records which of the two it was, and
-- why, alongside the distance it already stored.
--
-- Nullable because every quote written before this migration was priced on the
-- straight line with no scaling at all, and backfilling them with a source they
-- did not have would be inventing provenance rather than recording it.
CREATE TYPE "RouteDistanceSource" AS ENUM ('ROUTED', 'ESTIMATED');

ALTER TABLE "Quote"
  ADD COLUMN "deliveryDistanceSource" "RouteDistanceSource",
  ADD COLUMN "deliveryDistanceReasonCode" VARCHAR(64);

-- A routed distance has nothing to explain; an estimated one always does.
ALTER TABLE "Quote"
  ADD CONSTRAINT "quote_distance_provenance_check" CHECK (
    "deliveryDistanceSource" IS NULL
    OR ("deliveryDistanceSource" = 'ROUTED' AND "deliveryDistanceReasonCode" IS NULL)
    OR ("deliveryDistanceSource" = 'ESTIMATED' AND "deliveryDistanceReasonCode" IS NOT NULL)
  );
