-- Several orders, one courier, one ride.
--
-- Until now a courier carried one order per run, which means the ride out to a
-- neighbourhood was paid once per loaf rather than once per trip. This is the
-- largest cost lever left in delivery, and the batch density in the logistics
-- report has been reading 1.00 precisely because nothing here existed.
--
-- The risk it introduces is specific and is what most of these constraints
-- defend against: on a shared run, the last customer waits for everyone ahead of
-- them. Nobody who ordered bread agreed to wait so the bakery could save a trip.

CREATE TYPE "DeliveryTripState" AS ENUM ('PLANNED', 'DISPATCHED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "DeliveryTrip" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  -- One pickup per run. A rider collecting from two bakeries is two rides with
  -- the loaves going cold in between, which is the opposite of the saving.
  "bakeryBranchId" UUID NOT NULL,
  "state" "DeliveryTripState" NOT NULL DEFAULT 'PLANNED',
  "plannedDepartureAt" TIMESTAMP(3) NOT NULL,
  "plannedMetres" INTEGER NOT NULL,
  -- What this run saves against delivering each drop separately. Kept because
  -- it is the number that justifies batching existing, and recomputing it later
  -- from a plan that has since changed would answer a different question.
  "savedMetres" INTEGER NOT NULL DEFAULT 0,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "correlationId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryTrip_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_trip_distance_check" CHECK (
    "plannedMetres" >= 0 AND "savedMetres" >= 0 AND "plannedMetres" <= 2000000
  ),
  CONSTRAINT "delivery_trip_version_check" CHECK ("version" > 0),
  -- A dispatched run has a time it was dispatched; a completed one has both.
  -- Without this a trip could claim to be running with no record of when it
  -- started, and the batch-density report would count a run that never left.
  CONSTRAINT "delivery_trip_timeline_check" CHECK (
    ("state" = 'PLANNED'   AND "dispatchedAt" IS NULL AND "completedAt" IS NULL)
    OR ("state" = 'DISPATCHED' AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NULL)
    OR ("state" = 'COMPLETED'  AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
    OR "state" = 'CANCELLED'
  )
);

-- A delivery belongs to at most one run, and its place in that run is fixed.
-- Both halves matter: the same loaf cannot ride on two motorcycles, and two
-- drops cannot both be third.
CREATE TABLE "DeliveryTripStop" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "deliveryTripId" UUID NOT NULL,
  "deliveryTaskId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  -- Riding distance from the previous stop, or from the branch for the first.
  "legMetres" INTEGER NOT NULL,
  -- When the plan says the courier reaches this door. Shown to nobody as a
  -- promise: it is what the deadline check was made against, kept so a run that
  -- went wrong can be read back against what it intended.
  "plannedArrivalAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryTripStop_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_trip_stop_sequence_check" CHECK ("sequence" >= 1 AND "sequence" <= 20),
  CONSTRAINT "delivery_trip_stop_leg_check" CHECK ("legMetres" >= 0)
);

-- One task rides once, anywhere in the tenant. This is the constraint that
-- makes double-dispatch impossible rather than merely unlikely.
CREATE UNIQUE INDEX "DeliveryTripStop_task_key" ON "DeliveryTripStop"("tenantId", "deliveryTaskId");
CREATE UNIQUE INDEX "DeliveryTripStop_sequence_key"
  ON "DeliveryTripStop"("deliveryTripId", "sequence");
CREATE INDEX "DeliveryTrip_tenant_state_idx" ON "DeliveryTrip"("tenantId", "state", "createdAt");
CREATE INDEX "g3b_DeliveryTrip_bakeryBranchId_tenant_idx"
  ON "DeliveryTrip"("bakeryBranchId", "tenantId");
CREATE INDEX "g3b_DeliveryTripStop_deliveryTripId_tenant_idx"
  ON "DeliveryTripStop"("deliveryTripId", "tenantId");
CREATE INDEX "g3b_DeliveryTripStop_deliveryTaskId_tenant_idx"
  ON "DeliveryTripStop"("deliveryTaskId", "tenantId");

ALTER TABLE "DeliveryTrip"
  ADD CONSTRAINT "DeliveryTrip_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryTripStop"
  ADD CONSTRAINT "DeliveryTripStop_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "g3b_DeliveryTrip_id_tenant_key" ON "DeliveryTrip"("id", "tenantId");

ALTER TABLE "DeliveryTrip"
  ADD CONSTRAINT "g3b_DeliveryTrip_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeliveryTripStop"
  ADD CONSTRAINT "g3b_DeliveryTripStop_deliveryTripId_tenant_fk"
  FOREIGN KEY ("deliveryTripId", "tenantId")
  REFERENCES "DeliveryTrip" ("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeliveryTripStop"
  ADD CONSTRAINT "g3b_DeliveryTripStop_deliveryTaskId_tenant_fk"
  FOREIGN KEY ("deliveryTaskId", "tenantId")
  REFERENCES "DeliveryTask" ("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Once a courier has been offered the run, the sequence is what they are riding
-- and what every customer on it was promised. Adding a fourth drop to a rider
-- already at the second door does not shorten anything — it makes the last
-- customer late for a saving that has already been spent.
CREATE OR REPLACE FUNCTION guard_delivery_trip_stop()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  trip_state "DeliveryTripState";
  target_trip UUID;
BEGIN
  target_trip := COALESCE(NEW."deliveryTripId", OLD."deliveryTripId");
  SELECT "state" INTO trip_state FROM "DeliveryTrip" WHERE "id" = target_trip;

  IF trip_state IS DISTINCT FROM 'PLANNED' THEN
    RAISE EXCEPTION 'A trip that has left the bakery cannot change its stops';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."tenantId" <> OLD."tenantId"
    OR NEW."deliveryTripId" <> OLD."deliveryTripId"
    OR NEW."deliveryTaskId" <> OLD."deliveryTaskId"
  ) THEN
    RAISE EXCEPTION 'A trip stop cannot be moved to another trip or delivery';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER delivery_trip_stop_guard
BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryTripStop"
FOR EACH ROW EXECUTE FUNCTION guard_delivery_trip_stop();

-- The branch a run collects from is what every stop's plan was built against,
-- and the version must move so two dispatchers cannot silently overwrite each
-- other's decision about a run in progress.
CREATE OR REPLACE FUNCTION guard_delivery_trip()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."bakeryBranchId" <> OLD."bakeryBranchId" THEN
    RAISE EXCEPTION 'Delivery trip identity is immutable';
  END IF;
  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'Delivery trip version must increase';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_trip_guard
BEFORE UPDATE ON "DeliveryTrip"
FOR EACH ROW EXECUTE FUNCTION guard_delivery_trip();

ALTER TABLE "DeliveryTrip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryTrip" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DeliveryTrip"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "DeliveryTripStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryTripStop" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DeliveryTripStop"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registered tenant-owned relations added by this migration are protected by
-- composite tenant foreign keys and forced RLS; no economic values are backfilled.
--    ('DeliveryTrip', 'bakeryBranchId', 'BakeryBranch')
--    ('DeliveryTripStop', 'deliveryTaskId', 'DeliveryTask')
--    ('DeliveryTripStop', 'deliveryTripId', 'DeliveryTrip')
