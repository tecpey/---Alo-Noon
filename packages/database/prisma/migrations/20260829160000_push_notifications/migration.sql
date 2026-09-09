-- Telling a customer about their order without paying for a text message.
--
-- Every order notification this platform sends goes by SMS, which costs money
-- per message. For a bakery selling one basket a morning to the same people
-- that is the largest recurring cost attached to an order after the flour, and
-- it grows exactly in step with the thing the business wants to grow. A push
-- notification to an installed app costs nothing.
--
-- Push does not replace SMS, because push is not reliable enough to be the only
-- channel: a token expires, an app is deleted, notifications are switched off,
-- and none of that is visible until a message is thrown away. So the rule is
-- push when there is a live device and SMS otherwise, decided per message, with
-- SMS still carrying it when a push is refused. Exactly one message per order
-- step, either way.

ALTER TYPE "MessageChannel" ADD VALUE 'PUSH';

CREATE TYPE "PushDevicePlatform" AS ENUM ('IOS', 'ANDROID');

-- Where a customer can be reached without a text message.
--
-- One row per installed app, not per customer: somebody with a phone and a
-- tablet expects both to buzz, and somebody who reinstalled has a new token
-- while the old one is still on file and already dead.
CREATE TABLE "CustomerPushDevice" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  -- Expo's own token, of the form ExponentPushToken[...]. Stored whole because
  -- it is the address the message is sent to; there is nothing to hash it
  -- against and a digest could not be delivered to.
  "expoPushToken" VARCHAR(200) NOT NULL,
  "platform" "PushDevicePlatform" NOT NULL,
  -- False once the push service has told us this token is dead. Kept rather
  -- than deleted so a device that comes back registers over its own row, and so
  -- an operator can see that a customer's silence has a reason.
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabledReason" VARCHAR(64),
  "disabledAt" TIMESTAMP(3),
  -- When the app last said it was here. A token nobody has re-registered in
  -- months belongs to an app that was deleted without telling anyone.
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerPushDevice_pkey" PRIMARY KEY ("id"),
  -- The shape Expo issues. Checked here rather than trusted from a client,
  -- because everything else in this table is addressed by it.
  CONSTRAINT "customer_push_device_token_check" CHECK (
    "expoPushToken" ~ '^Expo(nent)?PushToken\[[A-Za-z0-9._-]+\]$'
  ),
  CONSTRAINT "customer_push_device_disabled_check" CHECK (
    ("enabled" = true AND "disabledReason" IS NULL AND "disabledAt" IS NULL)
    OR ("enabled" = false AND "disabledReason" IS NOT NULL AND "disabledAt" IS NOT NULL)
  ),
  CONSTRAINT "CustomerPushDevice_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "CustomerPushDevice_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- A token addresses one installation, so it belongs to one customer. Two
-- accounts signing in on the same handset must not both be reachable on it —
-- the second sign-in takes the token over, which is what re-registering does.
CREATE UNIQUE INDEX "CustomerPushDevice_tenant_token_key"
  ON "CustomerPushDevice"("tenantId", "expoPushToken");

CREATE INDEX "CustomerPushDevice_customer_enabled_idx"
  ON "CustomerPushDevice"("tenantId", "customerId", "enabled");

-- The composite the tenant-scoped joins elsewhere in this schema rely on.
CREATE UNIQUE INDEX "g3b_CustomerPushDevice_id_tenant_key"
  ON "CustomerPushDevice"("id", "tenantId");

ALTER TABLE "CustomerPushDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerPushDevice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CustomerPushDevice"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Which device carried a notification, when one did.
--
-- Null for every SMS, and null for a push that never found a device. Kept
-- because "it says it was sent and I never got it" is answerable only if the
-- record names the handset it went to.
ALTER TABLE "CustomerNotification"
  ADD COLUMN "pushDeviceId" UUID,
  ADD CONSTRAINT "CustomerNotification_pushDeviceId_fkey"
    FOREIGN KEY ("pushDeviceId") REFERENCES "CustomerPushDevice"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;

-- A device and the customer it belongs to are in the same tenant, and so are a
-- notification and the handset it went to.
--
-- A plain foreign key cannot say that. Without these a device row could point at
-- a customer in another tenant — which row-level security would then hide,
-- leaving a dangling pointer nobody can see to diagnose — and the app role
-- bypasses RLS, so nothing else in the system would catch it.
ALTER TABLE "CustomerPushDevice"
  ADD CONSTRAINT "g3b_CustomerPushDevice_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CustomerPushDevice_customerId_tenant_idx"
  ON "CustomerPushDevice"("customerId", "tenantId");

ALTER TABLE "CustomerNotification"
  ADD CONSTRAINT "g3b_CustomerNotification_pushDeviceId_tenant_fk"
  FOREIGN KEY ("pushDeviceId", "tenantId")
  REFERENCES "CustomerPushDevice" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_CustomerNotification_pushDeviceId_tenant_idx"
  ON "CustomerNotification"("pushDeviceId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('CustomerPushDevice', 'customerId', 'Customer')
--    ('CustomerNotification', 'pushDeviceId', 'CustomerPushDevice')

-- The channel is decided by the attempt that succeeded, not by the one that was
-- planned.
--
-- The guard froze it outright, which was correct when there was one channel: a
-- record whose channel could be edited afterwards is a record that cannot
-- answer what a customer was actually sent. With two channels the row is
-- claimed before either is tried — that claim is what stops a retried event
-- sending twice — so at claim time the channel is a plan, and pretending
-- otherwise would mean either a row that says SMS about a push or two rows for
-- one message.
--
-- So: freely settable while the send is still PENDING, frozen the moment it is
-- decided, exactly like the outcome below it. Everything the customer actually
-- received — the body, the number, the order, the purpose — stays immutable
-- from the moment the row exists.
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
    OR NEW."purpose" <> OLD."purpose"
    OR NEW."body" <> OLD."body"
    OR NEW."mobileE164" <> OLD."mobileE164"
  THEN
    RAISE EXCEPTION 'Customer notification content is immutable';
  END IF;
  IF OLD."state" <> 'PENDING'
    AND (NEW."channel" <> OLD."channel"
      OR NEW."pushDeviceId" IS DISTINCT FROM OLD."pushDeviceId")
  THEN
    RAISE EXCEPTION 'Customer notification channel is final';
  END IF;
  -- PENDING is the only state a send can still be decided from. Moving out of
  -- a settled state would let a retry overwrite the outcome it already had.
  IF OLD."state" <> 'PENDING' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'Customer notification outcome is final';
  END IF;
  RETURN NEW;
END
$$;
