-- A delivery fare stops being a stored rate and becomes a price that is asked
-- for at the moment of the order.
--
-- The published tariff does not go away: it is what answers when no marketplace
-- is configured or the configured one cannot be reached, and a checkout must
-- never fail because somebody else's pricing API is having an afternoon. What
-- changes is that it is now the last answer rather than the only one, and every
-- quote records which answer it got.

CREATE TYPE "DeliveryFareSource" AS ENUM ('PROVIDER', 'DYNAMIC', 'TARIFF');
CREATE TYPE "DeliveryFareEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "DeliveryFareProviderHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');

CREATE TABLE "DeliveryFareProviderConfiguration" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"            UUID NOT NULL,
  "providerCode"        VARCHAR(32) NOT NULL,
  "adapterVersion"      VARCHAR(64) NOT NULL,
  "adapterSpiVersion"   INTEGER NOT NULL DEFAULT 1,
  "environment"         "DeliveryFareEnvironment" NOT NULL,
  "credentialReference" VARCHAR(255) NOT NULL,
  "enabled"             BOOLEAN NOT NULL DEFAULT false,
  "isDefault"           BOOLEAN NOT NULL DEFAULT false,
  "priority"            INTEGER NOT NULL DEFAULT 100,
  "healthStatus"        "DeliveryFareProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "governanceVersion"   INTEGER NOT NULL DEFAULT 1,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryFareProviderConfiguration_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DeliveryFareProviderConfiguration"
  ADD CONSTRAINT "DeliveryFareProviderConfiguration_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "DeliveryFareProvider_tenant_code_environment_version_key"
  ON "DeliveryFareProviderConfiguration" ("tenantId", "providerCode", "environment", "adapterVersion", "adapterSpiVersion");

CREATE INDEX "DeliveryFareProvider_tenant_environment_enabled_idx"
  ON "DeliveryFareProviderConfiguration" ("tenantId", "environment", "enabled", "isDefault");

ALTER TABLE "DeliveryFareProviderConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryFareProviderConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DeliveryFareProviderConfiguration"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A fare a customer disputes has to be explainable. "The marketplace quoted it
-- and here is their reference" is an answer; so is "it was the breakfast rush
-- and the rate rose by fifteen per cent". A number with neither is not, so the
-- quote carries whichever applied.
--
-- All nullable, and null is its own meaning: a quote written before this
-- migration predates the question entirely, which is different from one that
-- fell back to the published tariff.
ALTER TABLE "Quote"
  ADD COLUMN "deliveryFareSource"                "DeliveryFareSource",
  ADD COLUMN "deliveryFareProviderCode"          VARCHAR(32),
  ADD COLUMN "deliveryFareProviderReference"     VARCHAR(200),
  ADD COLUMN "deliveryFareExpiresAt"             TIMESTAMP(3),
  ADD COLUMN "deliveryFareMultiplierBasisPoints" INTEGER,
  ADD COLUMN "deliveryFareReasonCodes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A multiplier below ×1 would be a discount wearing the surge's clothes, and a
-- fare provider reference on a quote that was never provider-priced would make
-- dispatch book against a price nobody quoted. Both are cheap to forbid here
-- and expensive to find in a ledger.
ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_fare_multiplier_at_least_one"
  CHECK ("deliveryFareMultiplierBasisPoints" IS NULL OR "deliveryFareMultiplierBasisPoints" >= 10000);

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_fare_provider_fields_agree"
  CHECK (
    ("deliveryFareSource" IS DISTINCT FROM 'PROVIDER'
      AND "deliveryFareProviderCode" IS NULL
      AND "deliveryFareProviderReference" IS NULL)
    OR
    ("deliveryFareSource" = 'PROVIDER'
      AND "deliveryFareProviderCode" IS NOT NULL
      AND "deliveryFareProviderReference" IS NOT NULL
      AND "deliveryFareExpiresAt" IS NOT NULL)
  );
