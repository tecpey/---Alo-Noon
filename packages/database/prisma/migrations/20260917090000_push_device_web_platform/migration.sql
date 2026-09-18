-- A third kind of device: the shop itself, added to a home screen.
--
-- Alone in its own migration, and that is not tidiness. PostgreSQL will not let
-- a new enum value be *used* in the same transaction that adds it, and Prisma
-- runs each migration file as one transaction. The constraint in the next
-- migration compares `platform` against 'WEB'; written here it would fail with
-- "unsafe use of new value of enum type", and it would fail on the deployment
-- rather than in review.
--
-- Why there is a third value at all rather than reusing IOS and ANDROID: a web
-- subscription is not a property of the operating system underneath it. The
-- same iPhone can hold both an Expo build and the installed site, reached by
-- two different services with two different addresses, and an operator looking
-- at why a customer was not told their bread arrived needs to see which of them
-- was tried.

ALTER TYPE "PushDevicePlatform" ADD VALUE 'WEB';
