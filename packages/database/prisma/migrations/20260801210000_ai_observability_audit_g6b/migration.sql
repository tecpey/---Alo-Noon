-- Phase G6B: tenant-isolated, append-only audit ledger for governed AI activity.
-- Raw prompts, raw tool output, secrets and unredacted PII are forbidden by contract.

CREATE TABLE "AiControlPlaneAuditEvent" (
  "id" uuid NOT NULL,
  "tenantId" uuid NOT NULL,
  "eventId" uuid NOT NULL,
  "proposalId" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "eventType" varchar(64) NOT NULL,
  "agentRole" varchar(32) NOT NULL,
  "action" varchar(64) NOT NULL,
  "classification" varchar(32) NOT NULL,
  "redactionStatus" varchar(32) NOT NULL,
  "correlationId" uuid NOT NULL,
  "traceId" varchar(64) NOT NULL,
  "actorAccountId" uuid,
  "charterVersion" varchar(64) NOT NULL,
  "policyVersion" varchar(64) NOT NULL,
  "modelProvider" varchar(64) NOT NULL,
  "modelVersion" varchar(128) NOT NULL,
  "provenanceUri" varchar(500) NOT NULL,
  "payload" jsonb NOT NULL,
  "payloadDigest" varchar(71) NOT NULL,
  "previousEventDigest" varchar(71),
  "eventDigest" varchar(71) NOT NULL,
  "occurredAt" timestamptz NOT NULL,
  "retainedUntil" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiControlPlaneAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiControlPlaneAuditEvent_eventId_key" UNIQUE ("eventId"),
  CONSTRAINT "AiControlPlaneAuditEvent_eventDigest_key" UNIQUE ("eventDigest"),
  CONSTRAINT "AiControlPlaneAuditEvent_proposal_sequence_key" UNIQUE ("tenantId", "proposalId", "sequence"),
  CONSTRAINT "AiControlPlaneAuditEvent_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AiControlPlaneAuditEvent_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "AiControlPlaneAuditEvent_digest_check" CHECK (
    "payloadDigest" ~ '^sha256:[a-f0-9]{64}$'
    AND "eventDigest" ~ '^sha256:[a-f0-9]{64}$'
    AND ("previousEventDigest" IS NULL OR "previousEventDigest" ~ '^sha256:[a-f0-9]{64}$')
  ),
  CONSTRAINT "AiControlPlaneAuditEvent_classification_check"
    CHECK ("classification" IN ('PUBLIC', 'INTERNAL', 'TENANT_CONFIDENTIAL', 'PII')),
  CONSTRAINT "AiControlPlaneAuditEvent_redaction_check" CHECK (
    "redactionStatus" IN ('NOT_REQUIRED', 'REDACTED')
    AND ("classification" <> 'PII' OR "redactionStatus" = 'REDACTED')
  ),
  CONSTRAINT "AiControlPlaneAuditEvent_retention_check" CHECK ("retainedUntil" > "occurredAt"),
  CONSTRAINT "AiControlPlaneAuditEvent_chain_check" CHECK (
    ("sequence" = 1 AND "previousEventDigest" IS NULL)
    OR ("sequence" > 1 AND "previousEventDigest" IS NOT NULL)
  )
);

CREATE INDEX "AiControlPlaneAuditEvent_tenant_occurred_idx"
  ON "AiControlPlaneAuditEvent" ("tenantId", "occurredAt");
CREATE INDEX "AiControlPlaneAuditEvent_proposal_idx"
  ON "AiControlPlaneAuditEvent" ("tenantId", "proposalId", "sequence");
CREATE INDEX "AiControlPlaneAuditEvent_correlation_idx"
  ON "AiControlPlaneAuditEvent" ("tenantId", "correlationId");

ALTER TABLE "AiControlPlaneAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiControlPlaneAuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiControlPlaneAuditEvent"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION prevent_ai_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AiControlPlaneAuditEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AiControlPlaneAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "AiControlPlaneAuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_ai_audit_mutation();
