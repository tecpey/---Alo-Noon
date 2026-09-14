-- What an order has to go out in, recorded where its fare already is.
--
-- Every delivery this platform has ever priced assumed a motorcycle. That is
-- right for the order it was written for — a household buying breakfast from
-- the bakery on the corner — and wrong for two customers the product is meant
-- to serve, both of whom it has been quietly mispricing and would have
-- mis-dispatched:
--
-- The bulk buyer. A school, an office, a factory canteen ordering bread by the
-- hundred. Distance is irrelevant; it does not fit on a motorcycle, and the
-- courier who accepts it either crushes it or makes trips nobody priced.
--
-- The distant buyer. Industrial estates on the ring road, units outside the
-- city, customers in the surrounding towns. A motorcycle can get there and
-- should not.
--
-- The vehicle is derived from the item count and the road distance, not chosen
-- by the customer: asking invites the cheaper answer, and the person who finds
-- out it was wrong is a courier at a factory gate holding a fifth of the order.
--
-- Snapshotted on the quote rather than computed at dispatch, for the same
-- reason the price and the distance beside it are. A tenant that later widens
-- its thresholds must not retroactively put a promised car back on a
-- motorcycle, and an order already accepted has to keep meaning what it meant
-- when the customer paid for it.
--
-- Both columns are nullable and nothing backfills them. A null profile means a
-- quote written before this existed, which is honestly "we did not decide" —
-- filling it in with MOTORCYCLE now would be inventing a decision for orders
-- nobody applied this rule to. The reason is null whenever a motorcycle was
-- fine, so its presence alone answers "why is this a car?".

ALTER TABLE "Quote"
  ADD COLUMN "deliveryVehicleProfile" "RoutingProfile",
  ADD COLUMN "deliveryVehicleReason" VARCHAR(32);

-- The reason is only ever one of three things, and it is written as a bare
-- string rather than an enum because it is a domain vocabulary that will grow
-- (a cold-chain tier, a stairs-only address) faster than a migration should
-- have to. The check is what stops it growing by accident instead.
ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_deliveryVehicleReason_known"
  CHECK ("deliveryVehicleReason" IS NULL
      OR "deliveryVehicleReason" IN ('LOAD', 'DISTANCE', 'LOAD_AND_DISTANCE'));

-- A reason without a vehicle is a row that says why it is a car without saying
-- it is one, and a CAR without a reason cannot be explained to the customer who
-- is paying for it. Neither is reachable through the code that writes these;
-- the constraint is here so it stays that way when a second writer appears.
--
-- Written as a CASE rather than as a chain of ORed equalities, and that is not
-- a style choice. A CHECK constraint rejects a row only when its expression is
-- FALSE, and passes it when the expression is NULL. With a null profile,
-- `"deliveryVehicleProfile" = 'CAR'` is NULL rather than false, so the whole
-- disjunction came out NULL and the constraint admitted exactly the row it was
-- written to refuse: a reason with no vehicle attached. The first draft here
-- did that, and it looked correct. CASE returns a real boolean on every branch,
-- so there is no third value for the constraint to wave through.
ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_deliveryVehicle_consistent"
  CHECK (
    CASE
      WHEN "deliveryVehicleProfile" IS NULL THEN "deliveryVehicleReason" IS NULL
      WHEN "deliveryVehicleProfile" = 'MOTORCYCLE' THEN "deliveryVehicleReason" IS NULL
      ELSE "deliveryVehicleReason" IS NOT NULL
    END
  );
