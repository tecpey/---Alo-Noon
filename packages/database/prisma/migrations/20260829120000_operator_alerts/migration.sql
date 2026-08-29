-- Telling the operator, and not telling them the same thing forty times.
--
-- Every condition these tables serve already exists and is already detected.
-- All of them are written to the server log, where nobody is looking: a gateway
-- that went unhealthy overnight is found by a customer failing to pay, and
-- events that exhausted their retries are found never.
--
-- Two tables, because there are two separate facts. Who should be told, which
-- an operator manages. And when each kind was last said, which the system keeps
-- so that a condition true for six hours does not become twenty-four messages.

CREATE TYPE "OperatorAlertKind" AS ENUM (
  'PAYMENT_GATEWAY_UNHEALTHY',
  'OUTBOX_EVENTS_PARKED',
  'PAYMENTS_AWAITING_SETTLEMENT',
  'COURIER_CASH_OUTSTANDING',
  'SMS_PROVIDER_UNAVAILABLE'
);

-- Who hears about it.
--
-- Separate from staff accounts on purpose. The person who should be woken at
-- 4am is not necessarily a system user — it is often the owner, or a shared
-- inbox the shift reads — and requiring an account to receive an alert would
-- mean creating accounts for people who must never be able to sign in.
CREATE TABLE "OperatorAlertRecipient" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "address" VARCHAR(254) NOT NULL,
  "displayName" VARCHAR(128) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  -- Which severities this address wants. An owner may want only the critical
  -- ones; the person who reconciles cash wants the daily warning too.
  "criticalOnly" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperatorAlertRecipient_pkey" PRIMARY KEY ("id"),
  -- Deliberately loose, as with the sender address: the authority on whether an
  -- address works is the receiving mail server, not a pattern here.
  CONSTRAINT "operator_alert_recipient_address_check" CHECK (
    "address" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    AND length(btrim("displayName")) > 0
  ),
  CONSTRAINT "OperatorAlertRecipient_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Case-insensitive, because Operator@example.com and operator@example.com are
-- the same inbox and adding both would send it everything twice.
CREATE UNIQUE INDEX "OperatorAlertRecipient_tenant_address_key"
  ON "OperatorAlertRecipient"("tenantId", lower("address"));

CREATE INDEX "OperatorAlertRecipient_tenant_enabled_idx"
  ON "OperatorAlertRecipient"("tenantId", "enabled");

ALTER TABLE "OperatorAlertRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperatorAlertRecipient" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OperatorAlertRecipient"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- When each kind was last said, and how often it was held back.
--
-- One row per tenant per kind, created on first use. The suppressed count is
-- kept rather than discarded because "we knew for six hours and said nothing"
-- is a different fact from "we did not know", and only one of them means the
-- quiet period is set wrong.
CREATE TABLE "OperatorAlertDispatch" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "kind" "OperatorAlertKind" NOT NULL,
  "lastSentAt" TIMESTAMP(3),
  "lastObservedCount" INTEGER NOT NULL DEFAULT 0,
  "suppressedSinceLastSend" INTEGER NOT NULL DEFAULT 0,
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  "lastOutcome" VARCHAR(32),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperatorAlertDispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operator_alert_dispatch_counts_check" CHECK (
    "lastObservedCount" >= 0 AND "suppressedSinceLastSend" >= 0 AND "sendCount" >= 0
  ),
  CONSTRAINT "OperatorAlertDispatch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- One row per kind per tenant. This uniqueness is what makes the quiet period
-- work at all: without it two rows would each hold their own idea of when the
-- last message went, and both would send.
CREATE UNIQUE INDEX "OperatorAlertDispatch_tenant_kind_key"
  ON "OperatorAlertDispatch"("tenantId", "kind");

ALTER TABLE "OperatorAlertDispatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperatorAlertDispatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OperatorAlertDispatch"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
