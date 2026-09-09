-- What the customer was actually told, and when.
--
-- The outbox publisher is at-least-once by construction: it sends, then marks
-- the event published, and a crash between those two leaves the event pending.
-- Without a record keyed on the order and the step, the next sweep would text
-- the customer a second time. Claiming a row here is what turns at-least-once
-- delivery of an event into exactly-once delivery of a message.

CREATE TYPE "CustomerNotificationState" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

CREATE TABLE "CustomerNotification" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "channel" "MessageChannel" NOT NULL,
  "purpose" "MessageTemplatePurpose" NOT NULL,
  "state" "CustomerNotificationState" NOT NULL DEFAULT 'PENDING',
  "body" VARCHAR(480) NOT NULL,
  "mobileE164" VARCHAR(16) NOT NULL,
  "templateVersion" INTEGER NOT NULL DEFAULT 0,
  "providerReference" VARCHAR(200),
  "failureCode" VARCHAR(64),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "correlationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_notification_body_check" CHECK (length(trim("body")) BETWEEN 1 AND 480),
  CONSTRAINT "customer_notification_mobile_check" CHECK ("mobileE164" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT "customer_notification_attempts_check" CHECK ("attempts" >= 0),
  -- A delivered message has a provider reference to point at when a customer
  -- says it never arrived; a failed one has a reason. Neither is optional in
  -- the state that requires it.
  CONSTRAINT "customer_notification_outcome_check" CHECK (
    ("state" <> 'SENT' OR "providerReference" IS NOT NULL)
    AND ("state" <> 'FAILED' OR "failureCode" IS NOT NULL)
  )
);

ALTER TABLE "CustomerNotification"
  ADD CONSTRAINT "CustomerNotification_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- Both the plain foreign key and the composite tenant one. Without the second,
-- a notification row could name an order belonging to another tenant, and the
-- message would go to that tenant's customer.
ALTER TABLE "CustomerNotification"
  ADD CONSTRAINT "CustomerNotification_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "g3b_CustomerNotification_orderId_tenant_fk" FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX "customer_notification_identity_key"
  ON "CustomerNotification"("tenantId", "orderId", "purpose");
CREATE INDEX "customer_notification_state_idx"
  ON "CustomerNotification"("tenantId", "state", "createdAt");
CREATE INDEX "g3b_CustomerNotification_orderId_tenant_idx"
  ON "CustomerNotification"("orderId", "tenantId");

-- What a customer was told is a record of a thing that happened. Editing the
-- body afterwards would make it a record of what we wish we had said, which is
-- exactly the value it loses when a customer disputes a message.
CREATE OR REPLACE FUNCTION guard_customer_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer notifications cannot be deleted';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId"
    OR NEW."orderId" <> OLD."orderId"
    OR NEW."channel" <> OLD."channel"
    OR NEW."purpose" <> OLD."purpose"
    OR NEW."body" <> OLD."body"
    OR NEW."mobileE164" <> OLD."mobileE164"
  THEN
    RAISE EXCEPTION 'Customer notification content is immutable';
  END IF;
  -- PENDING is the only state a send can still be decided from. Moving out of
  -- a settled state would let a retry overwrite the outcome it already had.
  IF OLD."state" <> 'PENDING' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'Customer notification outcome is final';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER customer_notification_guard
BEFORE UPDATE OR DELETE ON "CustomerNotification"
FOR EACH ROW EXECUTE FUNCTION guard_customer_notification();

ALTER TABLE "CustomerNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CustomerNotification"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('CustomerNotification', 'orderId', 'Order')
