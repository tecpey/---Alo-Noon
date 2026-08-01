-- Phase G6B.1: harden the already-deployed AI audit ledger without rewriting history.
-- Enforces payload sanitation and a contiguous per-tenant/per-proposal predecessor chain.

CREATE FUNCTION ai_audit_payload_is_safe(payload_value jsonb) RETURNS boolean AS $audit_payload$
DECLARE
  member record;
BEGIN
  CASE jsonb_typeof(payload_value)
    WHEN 'object' THEN
      FOR member IN SELECT key, value AS nested FROM jsonb_each(payload_value)
      LOOP
        IF member.key ~* '(raw.?prompt|raw.?conversation|raw.?tool.?output|password|passwd|secret|token|credential|api.?key|private.?key|authorization|cookie|session)'
           OR (member.key ~* '(email|phone|mobile|address|postal|latitude|longitude|first.?name|last.?name|full.?name)'
               AND member.nested IS DISTINCT FROM '"[REDACTED]"'::jsonb)
           OR NOT ai_audit_payload_is_safe(member.nested) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      FOR member IN SELECT element AS nested FROM jsonb_array_elements(payload_value) AS element
      LOOP
        IF NOT ai_audit_payload_is_safe(member.nested) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      IF trim(both '"' from payload_value::text) ~* '(bearer[[:space:]]+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)' THEN
        RETURN false;
      END IF;
  END CASE;

  RETURN true;
END;
$audit_payload$ LANGUAGE plpgsql IMMUTABLE STRICT;

DO $audit_preflight$
DECLARE
  invalid_count bigint;
BEGIN
  WITH ordered_history AS (
    SELECT
      event.*,
      row_number() OVER (
        PARTITION BY "tenantId", "proposalId"
        ORDER BY "sequence"
      ) AS expected_sequence,
      lag("eventDigest") OVER (
        PARTITION BY "tenantId", "proposalId"
        ORDER BY "sequence"
      ) AS expected_previous_digest
    FROM "AiControlPlaneAuditEvent" AS event
  )
  SELECT count(*)
    INTO invalid_count
    FROM ordered_history
   WHERE NOT ai_audit_payload_is_safe("payload")
      OR ("classification" = 'PII' AND "redactionStatus" <> 'REDACTED')
      OR "sequence" <> expected_sequence
      OR (expected_sequence = 1 AND "previousEventDigest" IS NOT NULL)
      OR (
        expected_sequence > 1
        AND "previousEventDigest" IS DISTINCT FROM expected_previous_digest
      );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'AiControlPlaneAuditEvent preflight rejected % unsafe or non-contiguous historical rows',
      invalid_count;
  END IF;
END;
$audit_preflight$;

CREATE FUNCTION enforce_ai_audit_insert_integrity() RETURNS trigger AS $audit_integrity$
DECLARE
  predecessor record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW."tenantId"::text || ':' || NEW."proposalId"::text, 0)
  );

  IF NOT ai_audit_payload_is_safe(NEW."payload")
     OR (NEW."classification" = 'PII' AND NEW."redactionStatus" <> 'REDACTED') THEN
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
$audit_integrity$ LANGUAGE plpgsql;

CREATE TRIGGER "AiControlPlaneAuditEvent_insert_integrity"
BEFORE INSERT ON "AiControlPlaneAuditEvent"
FOR EACH ROW EXECUTE FUNCTION enforce_ai_audit_insert_integrity();
