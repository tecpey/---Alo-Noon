-- Payment execution orchestration persists only normalized, non-economic
-- initialization results. Existing attempts remain nullable and fail closed in
-- the orchestrator; no provider result or economic value is invented.
DO $$
BEGIN
  IF to_regclass('public."PaymentAttempt"') IS NULL
    OR to_regclass('public."PaymentAttemptStateTransition"') IS NULL
    OR to_regclass('public."PaymentProviderConfiguration"') IS NULL
  THEN
    RAISE EXCEPTION 'Payment provider foundation must exist before payment execution orchestration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'PaymentInitializationOutcome'
  ) THEN
    RAISE EXCEPTION 'Payment initialization outcome type already exists';
  END IF;
END $$;

CREATE TYPE "PaymentInitializationOutcome" AS ENUM (
  'ACCEPTED',
  'CUSTOMER_ACTION_REQUIRED',
  'REJECTED',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'UNKNOWN'
);

ALTER TABLE "PaymentAttempt"
  ADD COLUMN "initializationOutcome" "PaymentInitializationOutcome",
  ADD COLUMN "customerActionUrl" VARCHAR(2048),
  ADD COLUMN "actionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" VARCHAR(64),
  ADD COLUMN "customerMessageKey" VARCHAR(100),
  ADD COLUMN "initializationCompletedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PaymentAttempt_initialization_result_check" CHECK (
    (
      "initializationOutcome" IS NULL
      AND "customerActionUrl" IS NULL
      AND "actionExpiresAt" IS NULL
      AND "failureCode" IS NULL
      AND "customerMessageKey" IS NULL
      AND "initializationCompletedAt" IS NULL
    ) OR (
      "initializationOutcome" = 'ACCEPTED'
      AND "state" IN ('INITIALIZED', 'CALLBACK_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED')
      AND "providerReference" IS NOT NULL
      AND "customerActionUrl" IS NULL
      AND "actionExpiresAt" IS NULL
      AND "failureCode" IS NULL
      AND "initializationCompletedAt" IS NOT NULL
      AND "initializationCompletedAt" >= "createdAt"
    ) OR (
      "initializationOutcome" = 'CUSTOMER_ACTION_REQUIRED'
      AND "state" IN ('CUSTOMER_ACTION_REQUIRED', 'CALLBACK_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED')
      AND "providerReference" IS NOT NULL
      AND "customerActionUrl" ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^#[:space:]]*)?$'
      AND char_length("customerActionUrl") <= 2048
      AND "failureCode" IS NULL
      AND "initializationCompletedAt" IS NOT NULL
      AND "initializationCompletedAt" >= "createdAt"
      AND ("actionExpiresAt" IS NULL OR "actionExpiresAt" > "initializationCompletedAt")
    ) OR (
      "initializationOutcome" IN ('REJECTED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'UNKNOWN')
      AND "state" = 'FAILED'
      AND "providerReference" IS NULL
      AND "customerActionUrl" IS NULL
      AND "actionExpiresAt" IS NULL
      AND "failureCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND "initializationCompletedAt" IS NOT NULL
      AND "initializationCompletedAt" >= "createdAt"
    )
  ),
  ADD CONSTRAINT "PaymentAttempt_customer_message_key_check" CHECK (
    "customerMessageKey" IS NULL OR "customerMessageKey" ~ '^[a-z][a-z0-9_.-]{1,99}$'
  );

CREATE OR REPLACE FUNCTION protect_payment_attempt_identity()
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
    OR (OLD."initializationOutcome" IS NOT NULL AND (
      NEW."initializationOutcome" IS DISTINCT FROM OLD."initializationOutcome"
      OR NEW."customerActionUrl" IS DISTINCT FROM OLD."customerActionUrl"
      OR NEW."actionExpiresAt" IS DISTINCT FROM OLD."actionExpiresAt"
      OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
      OR NEW."customerMessageKey" IS DISTINCT FROM OLD."customerMessageKey"
      OR NEW."initializationCompletedAt" IS DISTINCT FROM OLD."initializationCompletedAt"
    ))
  THEN RAISE EXCEPTION 'Payment attempt identity or initialization result is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_payment_attempt_history()
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
        AND audit."action" IN (
          'payment.attempt_created',
          'payment.attempt_state_changed',
          'payment.execution_requested',
          'payment.attempt_initialization_started',
          'payment.attempt_initialized',
          'payment.customer_action_required',
          'payment.attempt_initialization_failed'
        ))
      OR NOT EXISTS (SELECT 1 FROM "DomainEventOutbox" outbox WHERE outbox."tenantId" = transition."tenantId"
        AND outbox."eventId" = transition."id")
    )
  ) THEN RAISE EXCEPTION 'Payment attempt transitions require committed audit and outbox records'; END IF;
  RETURN NULL;
END $$;
