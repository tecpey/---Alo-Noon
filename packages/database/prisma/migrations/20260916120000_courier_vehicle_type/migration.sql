-- What each courier rides, so assignment can refuse a run they cannot do.
--
-- An order has been able to say it needs a car since the vehicle rule landed.
-- Nothing downstream honoured it: the assignment matcher optimised approach
-- distance and knew nothing about vehicles, so a bulk order for a factory would
-- go to whichever rider was nearest — a motorcycle parked outside the bakery
-- beating a car across town every time.
--
-- That failure is silent until the worst possible moment. The order is priced
-- correctly, the customer is charged for a car, the dispatch board looks
-- ordinary, and the mistake surfaces at the bakery door with the bread already
-- made and the delivery slot already spent.
--
-- The column lives on the courier rather than being derived from their
-- partner's fleet. A partner owning a car does not mean this rider drives one,
-- and assignment has to answer "can this person take this run", not "does their
-- employer own something that could".
--
-- Nullable, and nothing backfills it. Null means nobody has recorded what this
-- courier rides, and the matcher reads that as a motorcycle: they keep taking
-- every ordinary run they took before, and are never sent for a load that needs
-- a car. The conservative direction is deliberate — an unassigned run is a line
-- a dispatcher sees and acts on, and a motorcycle sent for four hundred loaves
-- is not.

ALTER TABLE "Courier"
  ADD COLUMN "vehicleType" "VehicleType";

-- Assignment scans available couriers and now reads this alongside status.
CREATE INDEX "Courier_tenant_status_vehicle_idx"
  ON "Courier" ("tenantId", "status", "vehicleType");
