-- Editable message text, per tenant and per purpose.
--
-- The provider configuration next door is frozen at creation on purpose: its
-- fields decide which gateway live traffic reaches and with whose credential.
-- Message wording is the opposite kind of thing — it is meant to be changed by
-- the operator, and freezing it would mean a new provider configuration every
-- time someone fixes a typo. So this table is writable, and what the guards
-- below protect is narrower: that a row cannot change which tenant or which
-- purpose it speaks for, and that the one message a customer cannot do without
-- stays switched on.

CREATE TYPE "MessageChannel" AS ENUM ('SMS');

CREATE TYPE "MessageTemplatePurpose" AS ENUM (
  'AUTH_OTP',
  'ORDER_ACCEPTED',
  'ORDER_REJECTED',
  'ORDER_READY',
  'ORDER_OUT_FOR_DELIVERY',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED'
);

CREATE TABLE "MessageTemplate" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "channel" "MessageChannel" NOT NULL,
  "purpose" "MessageTemplatePurpose" NOT NULL,
  "body" VARCHAR(480) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_template_body_check" CHECK (length(trim("body")) BETWEEN 1 AND 480),
  CONSTRAINT "message_template_version_check" CHECK ("version" > 0)
);

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "message_template_identity_key"
  ON "MessageTemplate"("tenantId", "channel", "purpose");
CREATE UNIQUE INDEX "message_template_id_tenant_key" ON "MessageTemplate"("id", "tenantId");
CREATE INDEX "message_template_tenant_channel_idx" ON "MessageTemplate"("tenantId", "channel");

-- Which tenant and which purpose a row speaks for is its identity. Repointing
-- an existing row at another purpose would silently swap the message customers
-- receive at one step of the order for the message meant for another, and the
-- audit trail would still read as an ordinary wording edit.
--
-- Disabling AUTH_OTP is refused for a blunter reason: nobody could sign in
-- afterwards, including the operator who would have to switch it back on.
CREATE OR REPLACE FUNCTION guard_message_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenantId" <> OLD."tenantId"
      OR NEW."channel" <> OLD."channel"
      OR NEW."purpose" <> OLD."purpose"
    THEN
      RAISE EXCEPTION 'Message template identity is immutable';
    END IF;
    -- Every edit is a new version, so an audit entry can name the version it
    -- replaced and a message already sent stays explicable.
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'Message template version must increase on every change';
    END IF;
  END IF;
  IF NEW."purpose" = 'AUTH_OTP' AND NOT NEW."enabled" THEN
    RAISE EXCEPTION 'The one-time code template cannot be disabled';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER message_template_guard
BEFORE INSERT OR UPDATE ON "MessageTemplate"
FOR EACH ROW EXECUTE FUNCTION guard_message_template();

ALTER TABLE "MessageTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MessageTemplate"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
