-- Reaching a browser, which on an iPhone is the only thing this platform can
-- ever reach.
--
-- Apple does not accept Iranian developer enrolments — `IOS_DISTRIBUTION.md`
-- quotes the refusal — so the App Store build in the plan does not exist and is
-- not going to. What does exist is the shop added to a home screen, and the one
-- thing it could not do until now is speak first: no "your bread is at the
-- door" unless the customer happened to be looking at the page. Every one of
-- those messages has therefore been a paid text message, on every order, for
-- every customer, forever.
--
-- ## One table, two addresses
--
-- An Expo token is an opaque string Expo can deliver to. A web subscription is
-- a URL held by the browser vendor's push service plus two keys, because the
-- payload is encrypted end to end and the push service forwards ciphertext it
-- cannot read. They are different enough that a single "token" column would be
-- a lie about what is in it.
--
-- They share a table anyway, because they are the same fact: a place this
-- customer can be reached. The dispatch path takes the devices in last-seen
-- order and stops at the first that accepts the message, and a customer with
-- the app on their phone and the site on their tablet should be reached on
-- whichever they last opened. Two tables would need a priority between them,
-- and any fixed priority is wrong for somebody.
--
-- ## The constraint is a CASE on purpose
--
-- A disjunction of IS NULL tests reads more naturally and would not work. A
-- CHECK passes when its expression is NULL, and comparisons against NULL are
-- NULL rather than false, so an ORed condition over nullable columns comes out
-- NULL for exactly the malformed rows it was written to refuse. CASE returns a
-- real boolean on every branch, including ELSE — which is false, so a fourth
-- transport added later is rejected until somebody teaches this constraint what
-- it means, rather than being admitted by silence.

CREATE TYPE "PushDeviceTransport" AS ENUM ('EXPO', 'WEB_PUSH');

ALTER TABLE "CustomerPushDevice"
  ADD COLUMN "transport" "PushDeviceTransport" NOT NULL DEFAULT 'EXPO',
  -- 500 rather than the 200 an Expo token needs: Google's endpoints run past
  -- 180 characters today and nothing promises they will not grow.
  ADD COLUMN "webPushEndpoint" VARCHAR(500),
  -- base64url of a 65-octet uncompressed P-256 point, and of a 16-octet secret.
  ADD COLUMN "webPushP256dh" VARCHAR(88),
  ADD COLUMN "webPushAuth" VARCHAR(24);

-- Every row that exists is an Expo registration, which is what the default
-- above says; the column only becomes optional for the rows added from here.
ALTER TABLE "CustomerPushDevice"
  ALTER COLUMN "expoPushToken" DROP NOT NULL;

ALTER TABLE "CustomerPushDevice"
  ADD CONSTRAINT "CustomerPushDevice_transport_address_check" CHECK (
    CASE "transport"
      WHEN 'EXPO' THEN
        "expoPushToken" IS NOT NULL
        AND "webPushEndpoint" IS NULL
        AND "webPushP256dh" IS NULL
        AND "webPushAuth" IS NULL
        AND "platform" <> 'WEB'
      WHEN 'WEB_PUSH' THEN
        "expoPushToken" IS NULL
        AND "webPushEndpoint" IS NOT NULL
        AND "webPushP256dh" IS NOT NULL
        AND "webPushAuth" IS NOT NULL
        AND "platform" = 'WEB'
      ELSE false
    END
  );

-- The endpoint is the address, so it is the identity, exactly as the Expo token
-- is for a handset. Registering one that belongs to another customer takes it
-- over: two people signing in on the same browser must not both be reachable on
-- it, or the second receives the first's order notifications.
--
-- Partial because the column is NULL for every Expo row, and a plain unique
-- index over a nullable column is not wrong so much as pointless — NULLs are
-- distinct, so it would permit everything it was added to prevent while
-- appearing to prevent it.
CREATE UNIQUE INDEX "CustomerPushDevice_tenant_endpoint_key"
  ON "CustomerPushDevice" ("tenantId", "webPushEndpoint")
  WHERE "webPushEndpoint" IS NOT NULL;
