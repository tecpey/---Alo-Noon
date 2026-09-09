-- Email: who carries this tenant's messages.
--
-- Until now the platform had exactly one way to reach a person — SMS — and one
-- reason to use it: the one-time code. That is right for a customer in Babol,
-- whose phone is the account. It is wrong for the operator, who needs to know
-- that a payment gateway went unhealthy at 4am, and today learns it only by
-- reading a server log nobody reads.
--
-- Shaped like the SMS and routing configurations on purpose. An operator
-- already knows this form from the admin panel, and the difference between an
-- email service and an SMS gateway is not one they should have to relearn.
--
-- `env://` is permitted here, as it is for SMS and routing and unlike payment.
-- An email credential sends messages; it does not move money. The `EMAIL_`
-- prefix is required for the same reason the others require theirs: so a
-- configuration cannot name an unrelated environment variable and hand its
-- value to an adapter.

CREATE TYPE "EmailEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "EmailProviderHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');

CREATE TABLE "EmailProviderConfiguration" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerCode" VARCHAR(32) NOT NULL,
  "adapterVersion" VARCHAR(64) NOT NULL,
  "adapterSpiVersion" INTEGER NOT NULL DEFAULT 1,
  "environment" "EmailEnvironment" NOT NULL,
  "credentialReference" VARCHAR(255) NOT NULL,
  -- Stored, not referenced. The sender address is not a secret — it is printed
  -- on every message the tenant sends — and an operator asking why mail lands
  -- in spam needs to read it without a database session.
  "senderAddress" VARCHAR(254) NOT NULL,
  "senderName" VARCHAR(128) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "healthStatus" "EmailProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "governanceVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailProviderConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_provider_code_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "email_provider_adapter_version_check" CHECK (
    "adapterVersion" ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT "email_provider_spi_check" CHECK ("adapterSpiVersion" = 1),
  CONSTRAINT "email_provider_reference_check" CHECK (
    "credentialReference" ~ '^(env|vault|aws-sm|gcp-sm|azure-kv)://[A-Za-z0-9_./:-]{1,240}$'
  ),
  -- Deliberately loose: one @, something either side, no spaces. A stricter
  -- pattern here would reject addresses that are perfectly deliverable, and the
  -- authority on whether an address works is the mail server, not this CHECK.
  CONSTRAINT "email_provider_sender_check" CHECK (
    "senderAddress" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    AND length(btrim("senderName")) > 0
  ),
  CONSTRAINT "email_provider_bounds_check" CHECK (
    "priority" BETWEEN 1 AND 1000
    AND "governanceVersion" > 0
    -- A disabled default would be selected and then refuse to send.
    AND (NOT "isDefault" OR "enabled")
  ),
  CONSTRAINT "EmailProviderConfiguration_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "EmailProvider_tenant_code_environment_version_key"
  ON "EmailProviderConfiguration"(
    "tenantId", "providerCode", "environment", "adapterVersion", "adapterSpiVersion"
  );

-- One default per tenant per environment, enforced by the database rather than
-- by whoever writes the selection query next.
CREATE UNIQUE INDEX "EmailProvider_tenant_environment_default_key"
  ON "EmailProviderConfiguration"("tenantId", "environment")
  WHERE "isDefault";

CREATE INDEX "EmailProvider_tenant_selection_idx"
  ON "EmailProviderConfiguration"("tenantId", "environment", "enabled", "isDefault", "priority");

ALTER TABLE "EmailProviderConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailProviderConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmailProviderConfiguration"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The identity of a configuration is what an adapter was resolved against; a
-- configuration that changed its provider or environment under a running system
-- would be a different service wearing the same id.
--
-- The governanceVersion rule is what stops two operators from silently
-- overwriting each other's decision about whether a service is trustworthy, and
-- it means every change is a governed act with a number on it.
CREATE OR REPLACE FUNCTION guard_email_provider_configuration()
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
    RAISE EXCEPTION 'Email provider configuration identity is immutable';
  END IF;
  IF NEW."governanceVersion" <= OLD."governanceVersion" THEN
    RAISE EXCEPTION 'Email provider governance version must increase';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER email_provider_configuration_guard
BEFORE UPDATE ON "EmailProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION guard_email_provider_configuration();
