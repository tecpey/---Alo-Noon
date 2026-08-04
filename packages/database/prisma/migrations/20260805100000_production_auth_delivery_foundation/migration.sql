-- Production authentication delivery foundation.
-- Provider credentials and raw OTP values are never persisted.

-- Retire legacy challenges without deleting history or inventing tenant ownership.
UPDATE "OtpChallenge"
SET "status" = 'INVALIDATED', "invalidatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'PENDING';

CREATE TYPE "AuthDeliveryEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "AuthProviderHealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "AuthOtpChallengeStatus" AS ENUM (
  'PREPARED', 'DELIVERED', 'DELIVERY_UNKNOWN', 'FAILED',
  'CONSUMED', 'INVALIDATED', 'EXPIRED'
);
CREATE TYPE "AuthDeliveryAttemptStatus" AS ENUM (
  'INITIALIZED', 'DELIVERED', 'REJECTED', 'TRANSIENT_FAILURE',
  'PERMANENT_FAILURE', 'UNKNOWN'
);
CREATE TYPE "AuthAbuseAction" AS ENUM ('OTP_REQUEST', 'OTP_VERIFY_FAILURE');

ALTER TABLE "TenantMembership" ADD COLUMN "customerId" UUID;

UPDATE "TenantMembership" membership
SET "customerId" = customer."id"
FROM "IdentityAccount" account
JOIN "Customer" customer ON customer."id" = account."customerId"
WHERE membership."accountId" = account."id"
  AND customer."tenantId" = membership."tenantId";

DROP INDEX "Customer_mobileE164_key";
CREATE UNIQUE INDEX "auth_Customer_tenant_mobile_key"
  ON "Customer"("tenantId", "mobileE164");
CREATE UNIQUE INDEX "TenantMembership_tenantId_customerId_key"
  ON "TenantMembership"("tenantId", "customerId");
CREATE INDEX "TenantMembership_customerId_tenantId_idx"
  ON "TenantMembership"("customerId", "tenantId");
ALTER TABLE "TenantMembership"
  ADD CONSTRAINT "TenantMembership_customer_tenant_fkey"
  FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AuthDeliveryProviderConfiguration" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerCode" VARCHAR(32) NOT NULL,
  "adapterVersion" VARCHAR(64) NOT NULL,
  "adapterSpiVersion" INTEGER NOT NULL DEFAULT 1,
  "environment" "AuthDeliveryEnvironment" NOT NULL,
  "credentialReference" VARCHAR(255) NOT NULL,
  "senderReference" VARCHAR(128) NOT NULL,
  "templateReference" VARCHAR(128) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "healthStatus" "AuthProviderHealthStatus" NOT NULL DEFAULT 'HEALTHY',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "circuitOpenedUntil" TIMESTAMP(3),
  "governanceVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthDeliveryProviderConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_provider_code_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "auth_provider_adapter_version_check" CHECK ("adapterVersion" ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  CONSTRAINT "auth_provider_spi_check" CHECK ("adapterSpiVersion" = 1),
  CONSTRAINT "auth_provider_secret_reference_check" CHECK (
    "credentialReference" ~ '^(env|vault|aws-sm|gcp-sm|azure-kv)://[A-Za-z0-9_./:-]{1,240}$'
  ),
  CONSTRAINT "auth_provider_metadata_check" CHECK (
    length(trim("senderReference")) BETWEEN 1 AND 128
    AND length(trim("templateReference")) BETWEEN 1 AND 128
  ),
  CONSTRAINT "auth_provider_operational_bounds_check" CHECK (
    "priority" BETWEEN 1 AND 1000
    AND "consecutiveFailures" >= 0
    AND "governanceVersion" > 0
    AND (NOT "isDefault" OR "enabled")
  )
);

CREATE TABLE "AuthOtpChallenge" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "mobileE164" VARCHAR(16) NOT NULL,
  "mobileDigest" VARCHAR(64) NOT NULL,
  "codeDigest" VARCHAR(64) NOT NULL,
  "requestIdempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "sourceIpDigest" VARCHAR(64) NOT NULL,
  "status" "AuthOtpChallengeStatus" NOT NULL DEFAULT 'PREPARED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resendAvailableAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "correlationId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthOtpChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_challenge_mobile_check" CHECK ("mobileE164" ~ '^\+989[0-9]{9}$'),
  CONSTRAINT "auth_challenge_digest_check" CHECK (
    "mobileDigest" ~ '^[a-f0-9]{64}$'
    AND "codeDigest" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "sourceIpDigest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "auth_challenge_attempt_bounds_check" CHECK (
    "attempts" >= 0 AND "maxAttempts" BETWEEN 3 AND 8 AND "attempts" <= "maxAttempts"
  ),
  CONSTRAINT "auth_challenge_time_check" CHECK (
    "createdAt" < "expiresAt"
    AND "resendAvailableAt" > "createdAt"
    AND "resendAvailableAt" <= "expiresAt"
  ),
  CONSTRAINT "auth_challenge_status_shape_check" CHECK (
    ("status" IN ('PREPARED', 'DELIVERED', 'DELIVERY_UNKNOWN')
      AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'CONSUMED' AND "consumedAt" IS NOT NULL
      AND "invalidatedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" IN ('FAILED', 'EXPIRED') AND "consumedAt" IS NULL
      AND "invalidatedAt" IS NOT NULL AND "supersededAt" IS NULL)
    OR ("status" = 'INVALIDATED' AND "consumedAt" IS NULL AND "invalidatedAt" IS NOT NULL)
  ),
  CONSTRAINT "auth_challenge_version_check" CHECK ("version" > 0)
);

CREATE TABLE "AuthOtpDeliveryAttempt" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "challengeId" UUID NOT NULL,
  "providerConfigurationId" UUID NOT NULL,
  "state" "AuthDeliveryAttemptStatus" NOT NULL DEFAULT 'INITIALIZED',
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "providerReference" VARCHAR(200),
  "safeFailureCode" VARCHAR(64),
  "correlationId" UUID NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finalizedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthOtpDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_attempt_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "auth_attempt_failure_code_check" CHECK (
    "safeFailureCode" IS NULL OR "safeFailureCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  CONSTRAINT "auth_attempt_result_shape_check" CHECK (
    ("state" = 'INITIALIZED' AND "finalizedAt" IS NULL AND "providerReference" IS NULL AND "safeFailureCode" IS NULL)
    OR ("state" = 'DELIVERED' AND "finalizedAt" IS NOT NULL AND "providerReference" IS NOT NULL AND "safeFailureCode" IS NULL)
    OR ("state" IN ('REJECTED', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE', 'UNKNOWN')
      AND "finalizedAt" IS NOT NULL AND "providerReference" IS NULL AND "safeFailureCode" IS NOT NULL)
  ),
  CONSTRAINT "auth_attempt_version_check" CHECK ("version" > 0)
);

CREATE TABLE "AuthAbuseEvent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "action" "AuthAbuseAction" NOT NULL,
  "mobileDigest" VARCHAR(64),
  "sourceIpDigest" VARCHAR(64),
  "providerConfigurationId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthAbuseEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_abuse_digest_check" CHECK (
    ("mobileDigest" IS NULL OR "mobileDigest" ~ '^[a-f0-9]{64}$')
    AND ("sourceIpDigest" IS NULL OR "sourceIpDigest" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "auth_abuse_dimension_check" CHECK (
    "mobileDigest" IS NOT NULL OR "sourceIpDigest" IS NOT NULL OR "providerConfigurationId" IS NOT NULL
  ),
  CONSTRAINT "auth_abuse_expiry_check" CHECK ("expiresAt" > "occurredAt")
);

CREATE UNIQUE INDEX "auth_provider_identity_key"
  ON "AuthDeliveryProviderConfiguration"("tenantId", "providerCode", "environment", "adapterVersion");
CREATE UNIQUE INDEX "AuthDeliveryProviderConfiguration_credentialReference_key"
  ON "AuthDeliveryProviderConfiguration"("credentialReference");
CREATE UNIQUE INDEX "auth_provider_id_tenant_key"
  ON "AuthDeliveryProviderConfiguration"("id", "tenantId");
CREATE INDEX "auth_provider_selection_idx"
  ON "AuthDeliveryProviderConfiguration"("tenantId", "environment", "enabled", "isDefault", "priority");
CREATE INDEX "auth_provider_circuit_idx"
  ON "AuthDeliveryProviderConfiguration"("tenantId", "circuitOpenedUntil");
CREATE UNIQUE INDEX "auth_provider_one_default_key"
  ON "AuthDeliveryProviderConfiguration"("tenantId", "environment")
  WHERE "enabled" AND "isDefault";

CREATE UNIQUE INDEX "auth_challenge_idempotency_key"
  ON "AuthOtpChallenge"("tenantId", "requestIdempotencyKey");
CREATE UNIQUE INDEX "auth_challenge_id_tenant_key"
  ON "AuthOtpChallenge"("id", "tenantId");
CREATE UNIQUE INDEX "auth_challenge_one_active_mobile_key"
  ON "AuthOtpChallenge"("tenantId", "mobileDigest")
  WHERE "status" IN ('PREPARED', 'DELIVERED', 'DELIVERY_UNKNOWN');
CREATE INDEX "auth_challenge_mobile_idx"
  ON "AuthOtpChallenge"("tenantId", "mobileDigest", "createdAt");
CREATE INDEX "auth_challenge_cleanup_idx"
  ON "AuthOtpChallenge"("tenantId", "status", "expiresAt");

CREATE UNIQUE INDEX "AuthOtpDeliveryAttempt_challengeId_key"
  ON "AuthOtpDeliveryAttempt"("challengeId");
CREATE UNIQUE INDEX "auth_attempt_id_tenant_key"
  ON "AuthOtpDeliveryAttempt"("id", "tenantId");
CREATE UNIQUE INDEX "auth_attempt_challenge_tenant_key"
  ON "AuthOtpDeliveryAttempt"("challengeId", "tenantId");
CREATE UNIQUE INDEX "auth_attempt_provider_reference_key"
  ON "AuthOtpDeliveryAttempt"("tenantId", "providerConfigurationId", "providerReference");
CREATE INDEX "auth_attempt_recovery_idx"
  ON "AuthOtpDeliveryAttempt"("tenantId", "state", "startedAt");
CREATE INDEX "auth_attempt_provider_tenant_idx"
  ON "AuthOtpDeliveryAttempt"("providerConfigurationId", "tenantId");

CREATE INDEX "auth_abuse_tenant_window_idx"
  ON "AuthAbuseEvent"("tenantId", "action", "occurredAt");
CREATE INDEX "auth_abuse_mobile_window_idx"
  ON "AuthAbuseEvent"("tenantId", "mobileDigest", "action", "occurredAt");
CREATE INDEX "auth_abuse_ip_window_idx"
  ON "AuthAbuseEvent"("tenantId", "sourceIpDigest", "action", "occurredAt");
CREATE INDEX "auth_abuse_provider_window_idx"
  ON "AuthAbuseEvent"("providerConfigurationId", "tenantId", "action", "occurredAt");
CREATE INDEX "auth_abuse_cleanup_idx" ON "AuthAbuseEvent"("expiresAt");

ALTER TABLE "AuthDeliveryProviderConfiguration"
  ADD CONSTRAINT "AuthDeliveryProviderConfiguration_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthOtpChallenge"
  ADD CONSTRAINT "AuthOtpChallenge_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthOtpDeliveryAttempt"
  ADD CONSTRAINT "AuthOtpDeliveryAttempt_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthOtpDeliveryAttempt"
  ADD CONSTRAINT "AuthOtpDeliveryAttempt_challenge_tenant_fkey"
  FOREIGN KEY ("challengeId", "tenantId") REFERENCES "AuthOtpChallenge"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthOtpDeliveryAttempt"
  ADD CONSTRAINT "AuthOtpDeliveryAttempt_provider_tenant_fkey"
  FOREIGN KEY ("providerConfigurationId", "tenantId")
  REFERENCES "AuthDeliveryProviderConfiguration"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthAbuseEvent"
  ADD CONSTRAINT "AuthAbuseEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthAbuseEvent"
  ADD CONSTRAINT "AuthAbuseEvent_provider_tenant_fkey"
  FOREIGN KEY ("providerConfigurationId", "tenantId")
  REFERENCES "AuthDeliveryProviderConfiguration"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION auth_guard_provider_configuration()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authentication provider configurations cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."tenantId" <> OLD."tenantId"
    OR NEW."providerCode" <> OLD."providerCode"
    OR NEW."adapterVersion" <> OLD."adapterVersion"
    OR NEW."adapterSpiVersion" <> OLD."adapterSpiVersion"
    OR NEW."environment" <> OLD."environment"
    OR NEW."credentialReference" <> OLD."credentialReference"
    OR NEW."senderReference" <> OLD."senderReference"
    OR NEW."templateReference" <> OLD."templateReference"
    OR NEW."enabled" <> OLD."enabled"
    OR NEW."isDefault" <> OLD."isDefault"
    OR NEW."priority" <> OLD."priority"
    OR NEW."governanceVersion" <> OLD."governanceVersion"
  ) THEN
    RAISE EXCEPTION 'Authentication provider governance fields are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_provider_configuration_guard
BEFORE UPDATE OR DELETE ON "AuthDeliveryProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION auth_guard_provider_configuration();

CREATE OR REPLACE FUNCTION auth_guard_otp_challenge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authentication OTP challenges cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PREPARED' OR NEW."attempts" <> 0 OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'Authentication OTP challenge must start prepared at version one';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" <> OLD."tenantId"
    OR NEW."mobileE164" <> OLD."mobileE164"
    OR NEW."mobileDigest" <> OLD."mobileDigest"
    OR NEW."codeDigest" <> OLD."codeDigest"
    OR NEW."requestIdempotencyKey" <> OLD."requestIdempotencyKey"
    OR NEW."requestFingerprint" <> OLD."requestFingerprint"
    OR NEW."sourceIpDigest" <> OLD."sourceIpDigest"
    OR NEW."correlationId" <> OLD."correlationId"
    OR NEW."maxAttempts" <> OLD."maxAttempts"
    OR NEW."expiresAt" <> OLD."expiresAt"
    OR NEW."resendAvailableAt" <> OLD."resendAvailableAt"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Authentication OTP challenge immutable fields or version are invalid';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF OLD."status" NOT IN ('DELIVERED', 'DELIVERY_UNKNOWN')
      OR NEW."attempts" <> OLD."attempts" + 1
      OR NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
      OR NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt"
      OR NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" THEN
      RAISE EXCEPTION 'Only one failed verification attempt may retain challenge state';
    END IF;
  ELSIF NOT (
    (OLD."status" = 'PREPARED' AND NEW."status" IN ('DELIVERED', 'DELIVERY_UNKNOWN', 'FAILED', 'INVALIDATED', 'EXPIRED'))
    OR (OLD."status" IN ('DELIVERED', 'DELIVERY_UNKNOWN') AND NEW."status" IN ('CONSUMED', 'INVALIDATED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid authentication OTP challenge transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_otp_challenge_guard
BEFORE INSERT OR UPDATE OR DELETE ON "AuthOtpChallenge"
FOR EACH ROW EXECUTE FUNCTION auth_guard_otp_challenge();

CREATE OR REPLACE FUNCTION auth_guard_delivery_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authentication delivery attempts cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'INITIALIZED' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'Authentication delivery attempt must start initialized at version one';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'INITIALIZED' OR NEW."state" = 'INITIALIZED'
    OR NEW."tenantId" <> OLD."tenantId"
    OR NEW."challengeId" <> OLD."challengeId"
    OR NEW."providerConfigurationId" <> OLD."providerConfigurationId"
    OR NEW."requestFingerprint" <> OLD."requestFingerprint"
    OR NEW."correlationId" <> OLD."correlationId"
    OR NEW."startedAt" <> OLD."startedAt"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Authentication delivery attempt is append-only after finalization';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_delivery_attempt_guard
BEFORE INSERT OR UPDATE OR DELETE ON "AuthOtpDeliveryAttempt"
FOR EACH ROW EXECUTE FUNCTION auth_guard_delivery_attempt();

CREATE OR REPLACE FUNCTION auth_prevent_abuse_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Authentication abuse history cannot be updated';
  END IF;
  IF TG_OP = 'DELETE' AND OLD."expiresAt" > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Unexpired authentication abuse history cannot be deleted';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER auth_abuse_event_append_only
BEFORE UPDATE OR DELETE ON "AuthAbuseEvent"
FOR EACH ROW EXECUTE FUNCTION auth_prevent_abuse_event_mutation();

ALTER TABLE "AuthDeliveryProviderConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthDeliveryProviderConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuthDeliveryProviderConfiguration"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "AuthOtpChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthOtpChallenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuthOtpChallenge"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "AuthOtpDeliveryAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthOtpDeliveryAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuthOtpDeliveryAttempt"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "AuthAbuseEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthAbuseEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuthAbuseEvent"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "TenantMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMembership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenantMembership"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "AuthSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuthSession"
  USING ("activeTenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("activeTenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
