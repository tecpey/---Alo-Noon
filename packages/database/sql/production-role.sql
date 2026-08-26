-- The role the API connects as in production.
--
-- Every tenant-scoped table in this schema has row-level security FORCED, and
-- the API relies on it: a request sets `app.tenant_id` and the policies do the
-- rest. But PostgreSQL exempts superusers and roles with BYPASSRLS from
-- policies entirely, and a table's owner is exempt unless FORCE is set. Connect
-- as the role that ran the migrations and every policy in the database silently
-- stops applying — no error, no warning, just one tenant reading another's
-- orders. Measured on a working database, the owner saw all 72 cities with no
-- tenant scope set; this role sees none.
--
-- That is why `/ready` refuses to come up in production when the connection is
-- elevated (see authenticationDatabaseRoleIsSafe). The check is not advice.
--
-- Run this once per database, as an administrator, after `prisma migrate
-- deploy`. Then point the API's DATABASE_URL at this role — and keep the
-- migration role for migrations only.

\set app_role alo_noon_app

-- No superuser, no BYPASSRLS, no ownership: three separate ways to be exempt
-- from the policies, and all three have to be closed.
CREATE ROLE :app_role LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- Set the password out of band rather than here, so it never enters a file:
--   ALTER ROLE alo_noon_app PASSWORD '...';

GRANT USAGE ON SCHEMA public TO :app_role;

-- Data only. No CREATE on the schema, no ownership of anything: the API never
-- migrates, and a role that cannot alter a table cannot drop a policy either.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :app_role;

-- The next migration creates tables this role has never heard of. Without this,
-- the API keeps running and starts failing on whatever the migration added.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :app_role;

-- Proof, not assumption. Run as the application role after connecting:
--
--   SELECT NOT EXISTS (
--     SELECT 1 FROM pg_roles elevated
--     WHERE (elevated.rolsuper OR elevated.rolbypassrls)
--       AND pg_has_role(current_user, elevated.oid, 'MEMBER')
--   );                                    -- must be true
--   SELECT count(*) FROM "City";          -- must be 0 with no app.tenant_id set
