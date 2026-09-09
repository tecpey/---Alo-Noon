-- One person, one courier record per tenant.
--
-- A courier signs in with the same one-time code as everyone else, and the only
-- thing that says which courier the signed-in account *is* is the mobile number
-- on the record. Two records sharing a number would make that lookup ambiguous,
-- and an ambiguous answer here means either a courier who cannot see their work
-- or one who can see someone else's.
--
-- Written as a partial index over the statuses that can still hold work: a
-- courier who left and later comes back is a new record, and refusing to create
-- it because the old offboarded one has the same number would be the constraint
-- getting in the way of the thing it is for.
CREATE UNIQUE INDEX "courier_active_mobile_key"
  ON "Courier"("tenantId", "mobileE164")
  WHERE "status" <> 'OFFBOARDED';
