-- The order code, made the only thing an order can be called.
--
-- `Order.publicId` is the code a customer reads off their screen, a baker sees
-- on the queue, a dispatcher says to a courier and an operator types into the
-- search box. The domain generates it deliberately: eight symbols from an
-- alphabet with no I, L, O or U in it, so nothing in a code can be misheard as
-- a one or a zero over a phone.
--
-- The column defaulted to `cuid()`. Every order the platform actually creates
-- goes through the one path that sets a real code, so in practice the default
-- never fired — but it sat there as a silent fallback, and the first thing that
-- ever wrote an order row without asking for a code got a twenty-five character
-- machine string instead. It would not have failed. It would have appeared as
-- an unreadable line on the dispatch board, on the screen where somebody is on
-- the phone trying to read it out.
--
-- Two changes, because either alone leaves half the hole. Dropping the default
-- makes a missing code an error rather than a surprise; the check makes a
-- wrong-shaped code an error too, which the default never could. The check is
-- what says out loud what this column is: not "some unique string", an order
-- code.
--
-- Deliberately not applied to Quote, Payment or SupportCase, which carry the
-- same default. For those a cuid *is* the intended identifier — nothing
-- generates a human code for them and nothing shows them to anybody — so their
-- default is a decision rather than a trap. What made this one a trap is that a
-- generator already existed and the default quietly disagreed with it.

-- Any row that is not a code gets one.
--
-- In a deployment that only ever created orders the ordinary way there are none
-- of these. The backfill exists so the constraint below can be added without a
-- migration that fails on somebody's development database and blocks a release.
--
-- A loop rather than one UPDATE, because a scalar subquery over
-- `generate_series` is evaluated once for the whole statement: every row gets
-- the *same* code and the unique index rejects the second one. In PL/pgSQL the
-- SELECT runs per iteration, which is the behaviour this needs. The inner loop
-- retries on the collision the birthday paradox eventually produces.
--
-- `random()` is not a cryptographic source, and does not need to be: this only
-- ever touches rows that were already unreadable, and a real code is generated
-- in the domain from `randomBytes`.
DO $$
DECLARE
  target_id UUID;
  candidate TEXT;
BEGIN
  FOR target_id IN
    SELECT id FROM "Order" WHERE "publicId" !~ '^[0-9A-HJKMNP-TV-Z]{8}$'
  LOOP
    LOOP
      SELECT string_agg(
               substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1),
               ''
             )
        INTO candidate
        FROM generate_series(1, 8);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Order" WHERE "publicId" = candidate);
    END LOOP;

    UPDATE "Order" SET "publicId" = candidate WHERE id = target_id;
  END LOOP;
END $$;

ALTER TABLE "Order" ALTER COLUMN "publicId" DROP DEFAULT;

-- The alphabet, spelled as a range: 0-9 and A-Z without I, L, O or U.
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_publicId_is_order_code"
  CHECK ("publicId" ~ '^[0-9A-HJKMNP-TV-Z]{8}$');
