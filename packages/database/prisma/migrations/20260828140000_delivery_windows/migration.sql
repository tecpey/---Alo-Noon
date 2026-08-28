-- Scheduled delivery windows.
--
-- Bread is the one product where *when* matters more than *how fast*. Nobody
-- wants barbari at eleven at night; they want it on the table at seven in the
-- morning. A platform that can only say "as soon as possible" is competing on
-- speed against every courier in the city; one that can promise a window is
-- selling the thing the customer actually wants — and it is the only way a
-- bakery can plan an oven.

-- How this branch cuts its opening hours into windows.
--
-- Defaults are chosen so that every branch that exists today keeps behaving as
-- it did: a two-hour window, an hour and a half of lead time, and one day of
-- horizon is the shape of an ordinary bakery, and nothing reads these columns
-- unless a customer asks for a window.
ALTER TABLE "BakeryBranch"
  ADD COLUMN "deliveryWindowMinutes" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN "deliveryLeadTimeMinutes" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "deliveryWindowHorizonDays" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deliveryWindowMaxOrders" INTEGER NOT NULL DEFAULT 20;

-- A policy that cannot produce a bookable window is a branch that silently
-- stops taking orders. Refused here, where an operator editing the branch can
-- be told why, rather than at the moment a stranger's basket is priced.
ALTER TABLE "BakeryBranch"
  ADD CONSTRAINT "branch_delivery_window_policy_check" CHECK (
    "deliveryWindowMinutes" > 0
    AND "deliveryWindowMinutes" <= 1440
    AND "deliveryLeadTimeMinutes" >= 0
    AND "deliveryWindowHorizonDays" >= 0
    AND "deliveryWindowHorizonDays" <= 14
    AND "deliveryWindowMaxOrders" > 0
  );

CREATE TABLE "BakeryDeliveryWindow" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "bakeryBranchId" UUID NOT NULL,
  "serviceDate" DATE NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "maxOrders" INTEGER NOT NULL,
  "reservedOrders" INTEGER NOT NULL DEFAULT 0,
  "suspended" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BakeryDeliveryWindow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_window_span_check" CHECK ("endsAt" > "startsAt"),
  -- A window that has taken more orders than it can hold is a promise the
  -- bakery cannot keep. The claim is a conditional UPDATE, but the constraint
  -- is what makes that claim's correctness something the database enforces
  -- rather than something the application remembers to.
  CONSTRAINT "delivery_window_capacity_check" CHECK (
    "maxOrders" > 0 AND "reservedOrders" >= 0 AND "reservedOrders" <= "maxOrders"
  ),
  CONSTRAINT "BakeryDeliveryWindow_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "BakeryDeliveryWindow_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId")
    REFERENCES "BakeryBranch"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- One row per window per branch. This is what makes materialising a window on
-- demand safe: two customers asking for seven o'clock at the same moment race
-- to insert, and exactly one of them creates it.
CREATE UNIQUE INDEX "BakeryDeliveryWindow_bakeryBranchId_startsAt_key"
  ON "BakeryDeliveryWindow"("bakeryBranchId", "startsAt");
CREATE INDEX "BakeryDeliveryWindow_tenantId_idx" ON "BakeryDeliveryWindow"("tenantId");
CREATE INDEX "BakeryDeliveryWindow_bakeryBranchId_serviceDate_idx"
  ON "BakeryDeliveryWindow"("bakeryBranchId", "serviceDate");
ALTER TABLE "BakeryDeliveryWindow"
  ADD CONSTRAINT "g3b_BakeryDeliveryWindow_id_tenant_key" UNIQUE ("id", "tenantId");

-- Which window a basket was priced for, and which one an order claimed.
ALTER TABLE "Quote" ADD COLUMN "deliveryWindowId" UUID;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_deliveryWindowId_fkey"
  FOREIGN KEY ("deliveryWindowId")
  REFERENCES "BakeryDeliveryWindow"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "Quote_deliveryWindowId_idx" ON "Quote"("deliveryWindowId");

ALTER TABLE "Order" ADD COLUMN "deliveryWindowId" UUID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryWindowId_fkey"
  FOREIGN KEY ("deliveryWindowId")
  REFERENCES "BakeryDeliveryWindow"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "Order_deliveryWindowId_idx" ON "Order"("deliveryWindowId");

-- An order that names a window must also name the moment it was promised for,
-- because everything downstream — the courier's deadline, the customer's
-- notification, the late-delivery report — reads the deadline and not the
-- window. Letting the two disagree would make an order that is late by one
-- measure and on time by the other.
ALTER TABLE "Order"
  ADD CONSTRAINT "order_delivery_window_deadline_check" CHECK (
    "deliveryWindowId" IS NULL OR "requestedDeliveryAt" IS NOT NULL
  );

-- Row-level security, forced, on the same terms as every other tenant-owned
-- table: the tenant is read from the session variable, and a connection that
-- has not set one sees nothing at all.
ALTER TABLE "BakeryDeliveryWindow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BakeryDeliveryWindow" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BakeryDeliveryWindow"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Composite tenant foreign keys.
--
-- Every one of these says the same thing: a child row and the parent it points
-- at belong to the same tenant. A plain foreign key cannot say that, and
-- without it a row could reference a parent in another tenant that row-level
-- security would then happily hide — leaving a dangling pointer nobody can see
-- to diagnose.
ALTER TABLE "BakeryDeliveryWindow"
  ADD CONSTRAINT "g3b_BakeryDeliveryWindow_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_BakeryDeliveryWindow_bakeryBranchId_tenant_idx"
  ON "BakeryDeliveryWindow"("bakeryBranchId", "tenantId");

ALTER TABLE "Quote"
  ADD CONSTRAINT "g3b_Quote_deliveryWindowId_tenant_fk"
  FOREIGN KEY ("deliveryWindowId", "tenantId")
  REFERENCES "BakeryDeliveryWindow" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_Quote_deliveryWindowId_tenant_idx" ON "Quote"("deliveryWindowId", "tenantId");

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_deliveryWindowId_tenant_fk"
  FOREIGN KEY ("deliveryWindowId", "tenantId")
  REFERENCES "BakeryDeliveryWindow" ("id", "tenantId")
  ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "g3b_Order_deliveryWindowId_tenant_idx" ON "Order"("deliveryWindowId", "tenantId");

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('BakeryDeliveryWindow', 'bakeryBranchId', 'BakeryBranch')
--    ('Quote', 'deliveryWindowId', 'BakeryDeliveryWindow')
--    ('Order', 'deliveryWindowId', 'BakeryDeliveryWindow')
