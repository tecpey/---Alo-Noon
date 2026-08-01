-- Phase G6B.1: harden the already-deployed AI audit ledger without rewriting history.
-- Enforces payload sanitation and a contiguous per-tenant/per-proposal predecessor chain.

CREATE FUNCTION ai_audit_payload_is_safe(value jsonb) RETURNS boolean AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_path_query(value, '$.**.keyvalue()') AS pair
    WHERE pair->>'key' ~* '^(raw.?prompt|raw.?conversation|raw.?tool.?output|password|passwd|secret|token|api.?key|private.?key|authorization|cookie|session)$'
       OR (
         jsonb_typeof(pair->'value') = 'string'
         AND trim(both '"' from (pair->'value')::text) ~* '(bearer[[:space:]]+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
       )
  );
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION enforce_ai_audit_insert_integrity() RETURNS trigger AS $$
DECLARE
  predecessor record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW."tenantId"::text || ':' || NEW."proposalId"::text, 0)
  );

  IF NOT ai_audit_payload_is_safe(NEW."payload") THEN
    RAISE EXCEPTION 'AiControlPlaneAuditEvent payload is not sanitized';
  END IF;

  SELECT "sequence", "eventDigest"
    INTO predecessor
    FROM "AiControlPlaneAuditEvent"
   WHERE "tenantId" = NEW."tenantId"
     AND "proposalId" = NEW."proposalId"
   ORDER BY "sequence" DESC
   LIMIT 1;

  IF predecessor IS NULL THEN
    IF NEW."sequence" <> 1 OR NEW."previousEventDigest" IS NOT NULL THEN
      RAISE EXCEPTION 'AiControlPlaneAuditEvent chain must start at sequence 1';
    END IF;
  ELSIF NEW."sequence" <> predecessor."sequence" + 1
     OR NEW."previousEventDigest" IS DISTINCT FROM predecessor."eventDigest" THEN
    RAISE EXCEPTION 'AiControlPlaneAuditEvent predecessor mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AiControlPlaneAuditEvent_insert_integrity"
BEFORE INSERT ON "AiControlPlaneAuditEvent"
FOR EACH ROW EXECUTE FUNCTION enforce_ai_audit_insert_integrity();
