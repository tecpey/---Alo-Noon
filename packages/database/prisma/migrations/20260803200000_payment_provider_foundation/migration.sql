-- Additive provider-facing foundation only. This migration does not execute
-- payments, store credential material, or rewrite payment and ledger history.

DO $$
BEGIN
  IF to_regclass('public."PaymentProviderConfiguration"') IS NOT NULL
     OR to_regclass('public."ProviderCredentialReference"') IS NOT NULL
     OR to_regclass('public."PaymentProviderGovernanceEvent"') IS NOT NULL
     OR to_regclass('public."PaymentAttempt"') IS NOT NULL
     OR to_regclass('public."PaymentAttemptStateTransition"') IS NOT NULL
     OR to_regclass('public."PaymentCallbackReceipt"') IS NOT NULL
  THEN RAISE EXCEPTION 'Payment provider foundation preflight failed: reserved relations already exist';
  END IF;
END $$;

CREATE TYPE "PaymentProviderEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "PaymentProviderCapability" AS ENUM (
  'PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION', 'PAYMENT_INQUIRY', 'CANCELLATION', 'REFUND'
);
CREATE TYPE "PaymentContext" AS ENUM ('CHECKOUT');
CREATE TYPE "ProviderHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "PaymentProviderGovernanceAction" AS ENUM ('CREATED', 'ACTIVATED', 'DEACTIVATED');
CREATE TYPE "PaymentAttemptState" AS ENUM (
  'CREATED', 'INITIALIZATION_PENDING', 'INITIALIZED', 'CUSTOMER_ACTION_REQUIRED',
  'CALLBACK_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED'
);
CREATE TYPE "PaymentCallbackVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');
CREATE TYPE "PaymentCallbackProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED');

CREATE TABLE "ProviderCredentialReference" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerCode" VARCHAR(32) NOT NULL,
  "reference" VARCHAR(500) NOT NULL,
  "keyVersion" VARCHAR(64) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "actorType" "ActorType" NOT NULL,
  "actorId" UUID,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCredentialReference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCredential_code_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "ProviderCredential_reference_check" CHECK (
    "reference" ~ '^(vault|aws-sm|gcp-sm|local-encrypted)://[A-Za-z0-9/_:.-]+$'
  ),
  CONSTRAINT "ProviderCredential_key_version_check" CHECK (char_length(trim("keyVersion")) BETWEEN 1 AND 64),
  CONSTRAINT "ProviderCredential_idempotency_check" CHECK (char_length("idempotencyKey") BETWEEN 16 AND 128),
  CONSTRAINT "ProviderCredential_authority_check" CHECK (
    ("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR ("actorType" = 'STAFF' AND "actorId" IS NOT NULL)
  ),
  CONSTRAINT "ProviderCredential_metadata_size_check" CHECK (octet_length("metadata"::text) <= 4096)
);

CREATE TABLE "PaymentProviderConfiguration" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerCode" VARCHAR(32) NOT NULL,
  "adapterVersion" VARCHAR(64) NOT NULL,
  "adapterSpiVersion" INTEGER NOT NULL,
  "merchantReference" VARCHAR(128) NOT NULL,
  "environment" "PaymentProviderEnvironment" NOT NULL,
  "paymentContext" "PaymentContext" NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'IRR',
  "callbackPolicy" VARCHAR(32) NOT NULL DEFAULT 'SIGNED_ONLY',
  "capabilities" "PaymentProviderCapability"[] NOT NULL,
  "credentialReferenceId" UUID NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "healthStatus" "ProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "governanceVersion" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentProviderConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentProvider_code_check" CHECK ("providerCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT "PaymentProvider_adapter_version_check" CHECK (
    "adapterVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT "PaymentProvider_adapter_spi_check" CHECK ("adapterSpiVersion" = 1),
  CONSTRAINT "PaymentProvider_merchant_check" CHECK (char_length(trim("merchantReference")) BETWEEN 1 AND 128),
  CONSTRAINT "PaymentProvider_callback_policy_check" CHECK ("callbackPolicy" = 'SIGNED_ONLY'),
  CONSTRAINT "PaymentProvider_currency_check" CHECK ("currency" = 'IRR'),
  CONSTRAINT "PaymentProvider_capabilities_check" CHECK (
    cardinality("capabilities") BETWEEN 1 AND 5
  ),
  CONSTRAINT "PaymentProvider_default_check" CHECK (NOT "isDefault" OR "isActive"),
  CONSTRAINT "PaymentProvider_governance_version_check" CHECK ("governanceVersion" > 0),
  CONSTRAINT "PaymentProvider_idempotency_check" CHECK (char_length("idempotencyKey") BETWEEN 16 AND 128)
);

CREATE TABLE "PaymentProviderGovernanceEvent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerConfigurationId" UUID NOT NULL,
  "action" "PaymentProviderGovernanceAction" NOT NULL,
  "fromActive" BOOLEAN,
  "toActive" BOOLEAN NOT NULL,
  "fromDefault" BOOLEAN,
  "toDefault" BOOLEAN NOT NULL,
  "actorType" "ActorType" NOT NULL,
  "actorId" UUID,
  "version" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentProviderGovernanceEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentProviderGovernance_authority_check" CHECK (
    ("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR ("actorType" = 'STAFF' AND "actorId" IS NOT NULL)
  ),
  CONSTRAINT "PaymentProviderGovernance_reason_check" CHECK (char_length(trim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "PaymentProviderGovernance_version_check" CHECK ("version" > 0),
  CONSTRAINT "PaymentProviderGovernance_state_check" CHECK (
    ("action" = 'CREATED' AND "version" = 1 AND "fromActive" IS NULL AND "fromDefault" IS NULL
      AND NOT "toActive" AND NOT "toDefault") OR
    ("action" = 'ACTIVATED' AND "fromActive" IS NOT NULL AND "toActive") OR
    ("action" = 'DEACTIVATED' AND "fromActive" AND NOT "toActive" AND NOT "toDefault")
  )
);

CREATE TABLE "PaymentAttempt" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "providerConfigurationId" UUID NOT NULL,
  "state" "PaymentAttemptState" NOT NULL DEFAULT 'CREATED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "providerReference" VARCHAR(200),
  "requestIdempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_version_check" CHECK ("version" > 0),
  CONSTRAINT "PaymentAttempt_idempotency_check" CHECK (char_length("requestIdempotencyKey") BETWEEN 16 AND 128),
  CONSTRAINT "PaymentAttempt_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PaymentAttempt_provider_reference_check" CHECK (
    "providerReference" IS NULL OR char_length(trim("providerReference")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "PaymentAttempt_initial_reference_check" CHECK ("version" > 1 OR "providerReference" IS NULL)
);

CREATE TABLE "PaymentAttemptStateTransition" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "paymentAttemptId" UUID NOT NULL,
  "fromState" "PaymentAttemptState",
  "toState" "PaymentAttemptState" NOT NULL,
  "version" INTEGER NOT NULL,
  "providerOutcome" VARCHAR(64),
  "providerReference" VARCHAR(200),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "correlationId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAttemptStateTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttemptTransition_version_check" CHECK ("version" > 0),
  CONSTRAINT "PaymentAttemptTransition_idempotency_check" CHECK (char_length("idempotencyKey") BETWEEN 16 AND 128),
  CONSTRAINT "PaymentAttemptTransition_outcome_check" CHECK (
    "providerOutcome" IS NULL OR "providerOutcome" IN ('PENDING', 'CUSTOMER_ACTION_REQUIRED', 'VERIFIED', 'REJECTED', 'FAILED')
  ),
  CONSTRAINT "PaymentAttemptTransition_provider_reference_check" CHECK (
    "providerReference" IS NULL OR ("fromState" = 'INITIALIZATION_PENDING' AND "toState" = 'INITIALIZED')
  ),
  CONSTRAINT "PaymentAttemptTransition_state_machine_check" CHECK (
    ("version" = 1 AND "fromState" IS NULL AND "toState" = 'CREATED') OR
    ("fromState" = 'CREATED' AND "toState" IN ('INITIALIZATION_PENDING', 'FAILED', 'EXPIRED')) OR
    ("fromState" = 'INITIALIZATION_PENDING' AND "toState" IN ('INITIALIZED', 'FAILED', 'EXPIRED')) OR
    ("fromState" = 'INITIALIZED' AND "toState" IN ('CUSTOMER_ACTION_REQUIRED', 'CALLBACK_RECEIVED', 'VERIFICATION_PENDING', 'FAILED', 'EXPIRED')) OR
    ("fromState" = 'CUSTOMER_ACTION_REQUIRED' AND "toState" IN ('CALLBACK_RECEIVED', 'FAILED', 'EXPIRED')) OR
    ("fromState" = 'CALLBACK_RECEIVED' AND "toState" IN ('VERIFICATION_PENDING', 'REJECTED')) OR
    ("fromState" = 'VERIFICATION_PENDING' AND "toState" IN ('VERIFIED', 'REJECTED', 'FAILED'))
  )
);

CREATE TABLE "PaymentCallbackReceipt" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "providerConfigurationId" UUID NOT NULL,
  "paymentAttemptId" UUID,
  "externalEventId" VARCHAR(200) NOT NULL,
  "headersFingerprint" CHAR(64) NOT NULL,
  "bodyDigest" CHAR(64) NOT NULL,
  "safePayload" JSONB NOT NULL,
  "verificationStatus" "PaymentCallbackVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "processingStatus" "PaymentCallbackProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "processingIdempotencyKey" VARCHAR(128),
  "processingFingerprint" CHAR(64),
  "correlationId" UUID NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentCallbackReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentCallback_event_check" CHECK (char_length(trim("externalEventId")) BETWEEN 1 AND 200),
  CONSTRAINT "PaymentCallback_digest_check" CHECK (
    "headersFingerprint" ~ '^[a-f0-9]{64}$' AND "bodyDigest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "PaymentCallback_payload_size_check" CHECK (octet_length("safePayload"::text) <= 16384),
  CONSTRAINT "PaymentCallback_idempotency_check" CHECK (char_length("idempotencyKey") BETWEEN 16 AND 128),
  CONSTRAINT "PaymentCallback_processing_check" CHECK (
    ("processingIdempotencyKey" IS NULL AND "processingFingerprint" IS NULL) OR
    (char_length("processingIdempotencyKey") BETWEEN 16 AND 128 AND "processingFingerprint" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "PaymentCallback_retention_check" CHECK ("retentionUntil" > "receivedAt")
);

CREATE UNIQUE INDEX "ProviderCredential_tenant_idempotency_key" ON "ProviderCredentialReference" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "ProviderCredential_tenant_provider_reference_key" ON "ProviderCredentialReference" ("tenantId", "providerCode", "reference");
CREATE UNIQUE INDEX "g3b_ProviderCredentialReference_id_tenant_key" ON "ProviderCredentialReference" ("id", "tenantId");
CREATE INDEX "ProviderCredentialReference_tenant_providerCode_idx" ON "ProviderCredentialReference" ("tenantId", "providerCode");

CREATE UNIQUE INDEX "PaymentProvider_tenant_code_environment_version_key" ON "PaymentProviderConfiguration" ("tenantId", "providerCode", "environment", "adapterVersion", "adapterSpiVersion");
CREATE UNIQUE INDEX "PaymentProvider_tenant_idempotency_key" ON "PaymentProviderConfiguration" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "g3b_PaymentProviderConfiguration_id_tenant_key" ON "PaymentProviderConfiguration" ("id", "tenantId");
CREATE INDEX "g3b_ProviderConfig_credentialRef_tenant_idx" ON "PaymentProviderConfiguration" ("credentialReferenceId", "tenantId");
CREATE INDEX "PaymentProviderConfiguration_selection_idx" ON "PaymentProviderConfiguration" ("tenantId", "environment", "paymentContext", "currency", "isActive", "isDefault");
CREATE UNIQUE INDEX "PaymentProvider_one_active_default_key"
  ON "PaymentProviderConfiguration" ("tenantId", "environment", "paymentContext", "currency")
  WHERE "isActive" AND "isDefault";

CREATE UNIQUE INDEX "PaymentProviderGovernance_tenant_idempotency_key" ON "PaymentProviderGovernanceEvent" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentProviderGovernance_configuration_version_key" ON "PaymentProviderGovernanceEvent" ("providerConfigurationId", "version");
CREATE UNIQUE INDEX "g3b_PaymentProviderGovernanceEvent_id_tenant_key" ON "PaymentProviderGovernanceEvent" ("id", "tenantId");
CREATE INDEX "g3b_ProviderGovernance_providerConfig_tenant_idx" ON "PaymentProviderGovernanceEvent" ("providerConfigurationId", "tenantId");

CREATE UNIQUE INDEX "PaymentAttempt_tenant_idempotency_key" ON "PaymentAttempt" ("tenantId", "requestIdempotencyKey");
CREATE UNIQUE INDEX "PaymentAttempt_provider_reference_key" ON "PaymentAttempt" ("tenantId", "providerConfigurationId", "providerReference");
CREATE UNIQUE INDEX "g3b_PaymentAttempt_id_tenant_key" ON "PaymentAttempt" ("id", "tenantId");
CREATE INDEX "g3b_PaymentAttempt_paymentId_tenant_idx" ON "PaymentAttempt" ("paymentId", "tenantId");
CREATE INDEX "g3b_PaymentAttempt_providerConfigurationId_tenant_idx" ON "PaymentAttempt" ("providerConfigurationId", "tenantId");
CREATE INDEX "PaymentAttempt_tenant_state_createdAt_idx" ON "PaymentAttempt" ("tenantId", "state", "createdAt");

CREATE UNIQUE INDEX "PaymentAttemptTransition_tenant_idempotency_key" ON "PaymentAttemptStateTransition" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentAttemptTransition_attempt_version_key" ON "PaymentAttemptStateTransition" ("paymentAttemptId", "version");
CREATE UNIQUE INDEX "g3b_PaymentAttemptStateTransition_id_tenant_key" ON "PaymentAttemptStateTransition" ("id", "tenantId");
CREATE INDEX "g3b_PaymentAttemptStateTransition_paymentAttemptId_tenant_idx" ON "PaymentAttemptStateTransition" ("paymentAttemptId", "tenantId");

CREATE UNIQUE INDEX "PaymentCallback_tenant_idempotency_key" ON "PaymentCallbackReceipt" ("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentCallback_processing_idempotency_key" ON "PaymentCallbackReceipt" ("tenantId", "processingIdempotencyKey");
CREATE UNIQUE INDEX "PaymentCallback_external_event_key" ON "PaymentCallbackReceipt" ("tenantId", "providerConfigurationId", "externalEventId");
CREATE UNIQUE INDEX "g3b_PaymentCallbackReceipt_id_tenant_key" ON "PaymentCallbackReceipt" ("id", "tenantId");
CREATE INDEX "g3b_CallbackReceipt_providerConfig_tenant_idx" ON "PaymentCallbackReceipt" ("providerConfigurationId", "tenantId");
CREATE INDEX "g3b_PaymentCallbackReceipt_paymentAttemptId_tenant_idx" ON "PaymentCallbackReceipt" ("paymentAttemptId", "tenantId");
CREATE INDEX "PaymentCallbackReceipt_tenant_processing_received_idx" ON "PaymentCallbackReceipt" ("tenantId", "processingStatus", "receivedAt");

ALTER TABLE "PaymentProviderConfiguration"
  ADD CONSTRAINT "PaymentProviderConfiguration_credentialReferenceId_fkey"
    FOREIGN KEY ("credentialReferenceId") REFERENCES "ProviderCredentialReference" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_ProviderConfig_credentialRef_tenant_fk"
    FOREIGN KEY ("credentialReferenceId", "tenantId")
  REFERENCES "ProviderCredentialReference" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "PaymentProviderGovernanceEvent"
  ADD CONSTRAINT "PaymentProviderGovernanceEvent_providerConfigurationId_fkey"
    FOREIGN KEY ("providerConfigurationId") REFERENCES "PaymentProviderConfiguration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_ProviderGovernance_providerConfig_tenant_fk"
    FOREIGN KEY ("providerConfigurationId", "tenantId")
  REFERENCES "PaymentProviderConfiguration" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_PaymentAttempt_paymentId_tenant_fk" FOREIGN KEY ("paymentId", "tenantId")
  REFERENCES "Payment" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "PaymentAttempt_providerConfigurationId_fkey" FOREIGN KEY ("providerConfigurationId") REFERENCES "PaymentProviderConfiguration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_PaymentAttempt_providerConfigurationId_tenant_fk" FOREIGN KEY ("providerConfigurationId", "tenantId")
  REFERENCES "PaymentProviderConfiguration" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "PaymentAttemptStateTransition"
  ADD CONSTRAINT "PaymentAttemptStateTransition_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_PaymentAttemptStateTransition_paymentAttemptId_tenant_fk" FOREIGN KEY ("paymentAttemptId", "tenantId")
  REFERENCES "PaymentAttempt" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "PaymentCallbackReceipt"
  ADD CONSTRAINT "PaymentCallbackReceipt_providerConfigurationId_fkey" FOREIGN KEY ("providerConfigurationId") REFERENCES "PaymentProviderConfiguration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_CallbackReceipt_providerConfig_tenant_fk" FOREIGN KEY ("providerConfigurationId", "tenantId")
  REFERENCES "PaymentProviderConfiguration" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT "PaymentCallbackReceipt_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_PaymentCallbackReceipt_paymentAttemptId_tenant_fk" FOREIGN KEY ("paymentAttemptId", "tenantId")
  REFERENCES "PaymentAttempt" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "ProviderCredentialReference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderCredentialReference" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProviderCredentialReference" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentProviderConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentProviderConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentProviderConfiguration" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentProviderGovernanceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentProviderGovernanceEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentProviderGovernanceEvent" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentAttempt" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentAttemptStateTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAttemptStateTransition" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentAttemptStateTransition" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "PaymentCallbackReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentCallbackReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentCallbackReceipt" USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION protect_provider_credential_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider credential references are immutable and cannot be deleted';
END $$;
CREATE TRIGGER "ProviderCredentialReference_immutable" BEFORE UPDATE OR DELETE ON "ProviderCredentialReference"
FOR EACH ROW EXECUTE FUNCTION protect_provider_credential_reference();

CREATE FUNCTION enforce_provider_credential_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AuditEvent" audit
    WHERE audit."tenantId" = NEW."tenantId"
      AND audit."entityId" = NEW."id"
      AND audit."correlationId" = NEW."correlationId"
      AND audit."action" = 'payment_provider.credential_reference_created'
  ) OR NOT EXISTS (
    SELECT 1 FROM "DomainEventOutbox" outbox
    WHERE outbox."tenantId" = NEW."tenantId"
      AND outbox."eventId" = NEW."id"
      AND outbox."name" = 'payment_provider.credential_reference_created'
  ) THEN
    RAISE EXCEPTION 'Provider credential references require committed audit and outbox records';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ProviderCredentialReference_audit_consistency"
AFTER INSERT ON "ProviderCredentialReference" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_provider_credential_audit();

CREATE FUNCTION protect_payment_provider_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment provider configurations cannot be deleted'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."providerCode" IS DISTINCT FROM OLD."providerCode"
    OR NEW."adapterVersion" IS DISTINCT FROM OLD."adapterVersion"
    OR NEW."adapterSpiVersion" IS DISTINCT FROM OLD."adapterSpiVersion"
    OR NEW."merchantReference" IS DISTINCT FROM OLD."merchantReference"
    OR NEW."environment" IS DISTINCT FROM OLD."environment"
    OR NEW."paymentContext" IS DISTINCT FROM OLD."paymentContext"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."callbackPolicy" IS DISTINCT FROM OLD."callbackPolicy"
    OR NEW."capabilities" IS DISTINCT FROM OLD."capabilities"
    OR NEW."credentialReferenceId" IS DISTINCT FROM OLD."credentialReferenceId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
  THEN RAISE EXCEPTION 'Payment provider configuration identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentProviderConfiguration_identity_guard" BEFORE UPDATE OR DELETE ON "PaymentProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION protect_payment_provider_identity();

CREATE FUNCTION enforce_unique_provider_capabilities()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE distinct_count INTEGER;
BEGIN
  SELECT COUNT(DISTINCT capability) INTO distinct_count FROM unnest(NEW."capabilities") capability;
  IF distinct_count <> cardinality(NEW."capabilities") THEN
    RAISE EXCEPTION 'Payment provider capabilities must be unique';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentProviderConfiguration_capabilities_guard"
BEFORE INSERT OR UPDATE OF "capabilities" ON "PaymentProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION enforce_unique_provider_capabilities();

CREATE FUNCTION protect_payment_attempt_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment attempts cannot be deleted'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."providerConfigurationId" IS DISTINCT FROM OLD."providerConfigurationId"
    OR NEW."requestIdempotencyKey" IS DISTINCT FROM OLD."requestIdempotencyKey"
    OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
    OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId"
    OR (OLD."providerReference" IS NOT NULL AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference")
  THEN RAISE EXCEPTION 'Payment attempt identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentAttempt_identity_guard" BEFORE UPDATE OR DELETE ON "PaymentAttempt"
FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt_identity();

CREATE FUNCTION protect_payment_callback_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment callback receipts cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."verificationStatus" <> 'UNVERIFIED' OR NEW."processingStatus" <> 'RECEIVED'
      OR NEW."processingIdempotencyKey" IS NOT NULL OR NEW."processingFingerprint" IS NOT NULL
    THEN RAISE EXCEPTION 'New payment callback receipts must begin unverified and unprocessed'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."providerConfigurationId" IS DISTINCT FROM OLD."providerConfigurationId"
    OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
    OR NEW."externalEventId" IS DISTINCT FROM OLD."externalEventId"
    OR NEW."headersFingerprint" IS DISTINCT FROM OLD."headersFingerprint"
    OR NEW."bodyDigest" IS DISTINCT FROM OLD."bodyDigest"
    OR NEW."safePayload" IS DISTINCT FROM OLD."safePayload"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR NEW."retentionUntil" IS DISTINCT FROM OLD."retentionUntil"
  THEN RAISE EXCEPTION 'Payment callback receipt identity is immutable'; END IF;
  IF OLD."processingIdempotencyKey" IS NOT NULL AND (
    NEW."processingIdempotencyKey" IS DISTINCT FROM OLD."processingIdempotencyKey"
    OR NEW."processingFingerprint" IS DISTINCT FROM OLD."processingFingerprint"
  ) THEN RAISE EXCEPTION 'Payment callback processing identity is immutable'; END IF;
  IF OLD."verificationStatus" <> 'UNVERIFIED' AND NEW."verificationStatus" IS DISTINCT FROM OLD."verificationStatus"
    THEN RAISE EXCEPTION 'Payment callback verification is terminal'; END IF;
  IF OLD."processingStatus" <> 'RECEIVED' AND NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus"
    THEN RAISE EXCEPTION 'Payment callback processing is terminal'; END IF;
  IF NOT (
    (NEW."verificationStatus" = 'UNVERIFIED' AND NEW."processingStatus" = 'RECEIVED') OR
    (NEW."verificationStatus" = 'VERIFIED' AND NEW."processingStatus" = 'PROCESSED') OR
    (NEW."verificationStatus" = 'REJECTED' AND NEW."processingStatus" = 'REJECTED')
  ) THEN RAISE EXCEPTION 'Payment callback verification and processing states must agree'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentCallbackReceipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentCallbackReceipt"
FOR EACH ROW EXECUTE FUNCTION protect_payment_callback_receipt();

CREATE TRIGGER "PaymentProviderGovernance_append_only" BEFORE UPDATE OR DELETE ON "PaymentProviderGovernanceEvent"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER "PaymentAttemptTransition_append_only" BEFORE UPDATE OR DELETE ON "PaymentAttemptStateTransition"
FOR EACH ROW EXECUTE FUNCTION protect_financial_history();

CREATE FUNCTION enforce_payment_callback_records()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_action TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AuditEvent" audit
    WHERE audit."tenantId" = NEW."tenantId" AND audit."entityId" = NEW."id"
      AND audit."action" = 'payment.callback_received'
  ) OR NOT EXISTS (
    SELECT 1 FROM "DomainEventOutbox" outbox
    WHERE outbox."tenantId" = NEW."tenantId" AND outbox."aggregateId" = NEW."id"
      AND outbox."name" = 'payment.callback_received'
  ) THEN RAISE EXCEPTION 'Payment callback receipts require committed intake audit and outbox records'; END IF;
  IF NEW."verificationStatus" <> 'UNVERIFIED' THEN
    final_action := CASE NEW."verificationStatus"
      WHEN 'VERIFIED' THEN 'payment.callback_verified'
      ELSE 'payment.callback_rejected'
    END;
    IF NOT EXISTS (
      SELECT 1 FROM "AuditEvent" audit
      WHERE audit."tenantId" = NEW."tenantId" AND audit."entityId" = NEW."id"
        AND audit."action" = final_action
    ) OR NOT EXISTS (
      SELECT 1 FROM "DomainEventOutbox" outbox
      WHERE outbox."tenantId" = NEW."tenantId" AND outbox."aggregateId" = NEW."id"
        AND outbox."name" = final_action
    ) THEN RAISE EXCEPTION 'Payment callback processing requires committed audit and outbox records'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PaymentCallbackReceipt_record_consistency"
AFTER INSERT OR UPDATE ON "PaymentCallbackReceipt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_callback_records();

CREATE FUNCTION enforce_payment_provider_governance_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; current_active BOOLEAN; current_default BOOLEAN; current_version INTEGER;
  event_count INTEGER; first_version INTEGER; latest_active BOOLEAN; latest_default BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'PaymentProviderConfiguration' THEN target_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_id := OLD."providerConfigurationId";
  ELSE target_id := NEW."providerConfigurationId"; END IF;
  SELECT "isActive", "isDefault", "governanceVersion" INTO current_active, current_default, current_version
  FROM "PaymentProviderConfiguration" WHERE "id" = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COUNT(*), MIN("version"),
    (ARRAY_AGG("toActive" ORDER BY "version" DESC))[1],
    (ARRAY_AGG("toDefault" ORDER BY "version" DESC))[1]
  INTO event_count, first_version, latest_active, latest_default
  FROM "PaymentProviderGovernanceEvent" WHERE "providerConfigurationId" = target_id;
  IF event_count <> current_version OR first_version <> 1
    OR latest_active IS DISTINCT FROM current_active OR latest_default IS DISTINCT FROM current_default
  THEN RAISE EXCEPTION 'Payment provider state must match contiguous governance history'; END IF;
  IF EXISTS (
    SELECT 1 FROM "PaymentProviderGovernanceEvent" event
    WHERE event."providerConfigurationId" = target_id AND (
      NOT EXISTS (SELECT 1 FROM "AuditEvent" audit WHERE audit."tenantId" = event."tenantId"
        AND audit."entityId" = target_id AND audit."correlationId" = event."correlationId"
        AND audit."action" = CASE event."action"
          WHEN 'CREATED' THEN 'payment_provider.configuration_created'
          WHEN 'ACTIVATED' THEN 'payment_provider.configuration_activated'
          ELSE 'payment_provider.configuration_deactivated' END)
      OR NOT EXISTS (SELECT 1 FROM "DomainEventOutbox" outbox WHERE outbox."tenantId" = event."tenantId"
        AND outbox."eventId" = event."id")
    )
  ) THEN RAISE EXCEPTION 'Payment provider governance requires committed audit and outbox records'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PaymentProvider_governance_consistency"
AFTER INSERT OR UPDATE ON "PaymentProviderConfiguration" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_provider_governance_history();
CREATE CONSTRAINT TRIGGER "PaymentProviderGovernance_history_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "PaymentProviderGovernanceEvent" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_provider_governance_history();

CREATE FUNCTION enforce_payment_attempt_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; current_state "PaymentAttemptState"; current_version INTEGER;
  current_reference VARCHAR(200); event_count INTEGER; first_version INTEGER;
  latest_state "PaymentAttemptState"; latest_reference VARCHAR(200);
BEGIN
  IF TG_TABLE_NAME = 'PaymentAttempt' THEN target_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN target_id := OLD."paymentAttemptId";
  ELSE target_id := NEW."paymentAttemptId"; END IF;
  SELECT "state", "version", "providerReference" INTO current_state, current_version, current_reference
  FROM "PaymentAttempt" WHERE "id" = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COUNT(*), MIN("version"), (ARRAY_AGG("toState" ORDER BY "version" DESC))[1],
    (ARRAY_AGG("providerReference" ORDER BY "version" DESC)
      FILTER (WHERE "providerReference" IS NOT NULL))[1]
  INTO event_count, first_version, latest_state, latest_reference
  FROM "PaymentAttemptStateTransition" WHERE "paymentAttemptId" = target_id;
  IF event_count <> current_version OR first_version <> 1 OR latest_state IS DISTINCT FROM current_state
    OR latest_reference IS DISTINCT FROM current_reference
  THEN RAISE EXCEPTION 'Payment attempt state must match contiguous transition history'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT "version", "fromState", LAG("toState") OVER (ORDER BY "version") previous_state
      FROM "PaymentAttemptStateTransition" WHERE "paymentAttemptId" = target_id
    ) history WHERE "version" > 1 AND "fromState" IS DISTINCT FROM previous_state
  ) THEN RAISE EXCEPTION 'Payment attempt transition history is not contiguous'; END IF;
  IF EXISTS (
    SELECT 1 FROM "PaymentAttemptStateTransition" transition
    WHERE transition."paymentAttemptId" = target_id AND (
      NOT EXISTS (SELECT 1 FROM "AuditEvent" audit WHERE audit."tenantId" = transition."tenantId"
        AND audit."entityId" = target_id AND audit."correlationId" = transition."correlationId"
        AND audit."action" IN ('payment.attempt_created', 'payment.attempt_state_changed'))
      OR NOT EXISTS (SELECT 1 FROM "DomainEventOutbox" outbox WHERE outbox."tenantId" = transition."tenantId"
        AND outbox."eventId" = transition."id")
    )
  ) THEN RAISE EXCEPTION 'Payment attempt transitions require committed audit and outbox records'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PaymentAttempt_history_consistency"
AFTER INSERT OR UPDATE ON "PaymentAttempt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_attempt_history();
CREATE CONSTRAINT TRIGGER "PaymentAttemptTransition_history_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "PaymentAttemptStateTransition" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_attempt_history();

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('PaymentProviderConfiguration', 'credentialReferenceId', 'ProviderCredentialReference')
--    ('PaymentProviderGovernanceEvent', 'providerConfigurationId', 'PaymentProviderConfiguration')
--    ('PaymentAttempt', 'paymentId', 'Payment')
--    ('PaymentAttempt', 'providerConfigurationId', 'PaymentProviderConfiguration')
--    ('PaymentAttemptStateTransition', 'paymentAttemptId', 'PaymentAttempt')
--    ('PaymentCallbackReceipt', 'providerConfigurationId', 'PaymentProviderConfiguration')
--    ('PaymentCallbackReceipt', 'paymentAttemptId', 'PaymentAttempt')
