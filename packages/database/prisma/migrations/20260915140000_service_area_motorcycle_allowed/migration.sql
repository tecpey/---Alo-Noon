-- Reaching the surrounding towns and villages.
--
-- Two things stood between this platform and a customer in a village outside
-- the city. One is data: an address is only accepted if it falls inside exactly
-- one active service area, so a village with no polygon drawn over it cannot
-- save an address at all, let alone order. That is configuration — draw the
-- village as an area — and no code change makes it true.
--
-- The other is this column. The distance threshold already turns a far address
-- into a car journey, and it is a threshold in kilometres, which is not always
-- what "out of motorcycle range" means. A village eight kilometres out across a
-- river with one bridge is inside the threshold and still nowhere to send a
-- loaded motorcycle. An operator can now say so about the area itself, rather
-- than being forced to raise the whole city's threshold and lose the protection
-- everywhere else.
--
-- Default true, which is what every existing area already was: until now no
-- area could refuse a motorcycle, so every one of them permitted it.
--
-- This is the reason a motorcycle disappears from the customer's options while
-- the car stays. A car is never blocked — it carries anything a motorcycle
-- carries and goes anywhere a motorcycle goes — so an address that loses the
-- motorcycle is never left with nothing, which is the whole point for exactly
-- these addresses.

ALTER TABLE "ServiceArea"
  ADD COLUMN "motorcycleAllowed" BOOLEAN NOT NULL DEFAULT true;
