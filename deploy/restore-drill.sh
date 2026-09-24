#!/bin/bash
#
# Restores last night's backup into a throwaway database and checks what came
# back.
#
# `backup.sh` already verifies that the archive is readable. That is not the
# same question. An archive whose table of contents parses can still restore
# into a database that is missing a constraint, has lost row-level security, or
# arrives with an empty ledger — and every one of those is discovered at the
# worst possible moment, which is the moment you needed the backup.
#
# So this does the whole thing: creates a scratch database, restores into it,
# and then asks it the questions that decide whether the business could be run
# from it. It touches nothing live — it refuses to run against the production
# database name, and it drops the scratch database at the end whether it passed
# or failed.
#
# Run it after the first backup and then monthly:
#   deploy/restore-drill.sh /var/backups/alo-noon/alo-noon-20260924T031500Z.dump
#
# With no argument it takes the newest dump in ALO_NOON_BACKUP_DIR.

set -euo pipefail

LIVE="${ALO_NOON_DATABASE:-alo_noon}"
BACKUP_DIR="${ALO_NOON_BACKUP_DIR:-/var/backups/alo-noon}"
SCRATCH="${ALO_NOON_DRILL_DATABASE:-alo_noon_restore_drill}"

if [ "$SCRATCH" = "$LIVE" ]; then
  echo "refusing to drill into the live database ($LIVE)" >&2
  exit 2
fi

archive="${1:-}"
if [ -z "$archive" ]; then
  archive="$(find "$BACKUP_DIR" -name 'alo-noon-*.dump' -type f | sort | tail -1)"
fi
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "no backup found (looked in $BACKUP_DIR)" >&2
  exit 2
fi

echo "drilling: $archive"
echo "  into:   $SCRATCH (dropped again at the end)"

cleanup() {
  dropdb --if-exists "$SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dropdb --if-exists "$SCRATCH"
createdb "$SCRATCH"

# `--no-owner` because the scratch database is restored by whoever is running
# the drill, not by the production role. `--exit-on-error` so a failure is a
# failure rather than a database that is silently half there.
pg_restore --dbname="$SCRATCH" --no-owner --exit-on-error "$archive"

failures=0
check() {
  local label="$1" sql="$2" expectation="$3"
  local got
  got="$(psql --dbname="$SCRATCH" --tuples-only --no-align --command="$sql" | tr -d '[:space:]')"
  if [ "$got" = "$expectation" ]; then
    printf '  [ok]   %-58s %s\n' "$label" "$got"
  else
    printf '  [FAIL] %-58s got %s, wanted %s\n' "$label" "$got" "$expectation"
    failures=$((failures + 1))
  fi
}
report() {
  local label="$1" sql="$2"
  printf '  [--]   %-58s %s\n' "$label" \
    "$(psql --dbname="$SCRATCH" --tuples-only --no-align --command="$sql" | tr -d '[:space:]')"
}

echo
echo "what came back:"

# The shape. A restore that loses these has restored data into a database that
# cannot enforce anything about it.
check 'row-level security is still forced on the order table' \
  "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'Order'" 't'
check 'the tenant isolation policy exists' \
  "SELECT count(*) FROM pg_policies WHERE tablename = 'Order' AND policyname = 'tenant_isolation'" '1'
check 'a credential reference still cannot hold a raw secret' \
  "SELECT count(*) FROM pg_constraint WHERE conname = 'ProviderCredential_reference_check'" '1'
check 'provider credentials are still immutable' \
  "SELECT count(*) FROM pg_trigger WHERE tgname = 'ProviderCredentialReference_immutable'" '1'

# The money. A ledger that does not balance after a restore is not a ledger, and
# this is the one number that says the restore is trustworthy rather than merely
# complete.
check 'the double-entry ledger balances' \
  "SELECT COALESCE(SUM(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END), 0)::text
   FROM \"LedgerEntry\"" '0'

# The volume. Not asserted — a drill cannot know last night's numbers — but
# printed, because a restore that yields zero orders is one somebody must look
# at before trusting it.
report 'tenants'        "SELECT count(*) FROM \"Tenant\""
report 'orders'         "SELECT count(*) FROM \"Order\""
report 'ledger entries' "SELECT count(*) FROM \"LedgerEntry\""
report 'customers'      "SELECT count(*) FROM \"Customer\""
report 'newest order'   "SELECT COALESCE(MAX(\"createdAt\")::text, 'none') FROM \"Order\""

# Every migration the code expects. A restore one migration behind starts and
# then fails on the first write to whatever the migration added.
check 'no migration is recorded as failed' \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL" '0'
report 'migrations applied' "SELECT count(*) FROM _prisma_migrations"

echo
if [ "$failures" -eq 0 ]; then
  echo "RESTORE DRILL PASSED — this backup could be run from."
else
  echo "RESTORE DRILL FAILED: $failures check(s)." >&2
  exit 1
fi
