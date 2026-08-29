#!/bin/bash
#
# Nightly database backup.
#
# The orders, the ledger, and every customer's address book live in one
# PostgreSQL database. There is no second copy of any of it. A disk that fails
# at 4am without this in place ends the business, not the deployment.
#
# Writes a custom-format dump, which is what `pg_restore` wants: it can restore
# selectively, it compresses, and it does not depend on the plain-SQL dialect
# matching between versions.
#
# Install as a cron entry for the postgres user, or a systemd timer:
#   15 3 * * *  /srv/alo-noon/current/deploy/backup.sh
#
# Restoring is in the runbook, and the runbook says to practise it. A backup
# nobody has restored is a hypothesis.

set -euo pipefail

DATABASE="${ALO_NOON_DATABASE:-alo_noon}"
DESTINATION="${ALO_NOON_BACKUP_DIR:-/var/backups/alo-noon}"
# Two weeks. Long enough that a problem noticed on Monday can be answered with
# the state from before the weekend.
KEEP_DAYS="${ALO_NOON_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DESTINATION"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$DESTINATION/alo-noon-$stamp.dump"

# Written to a partial name and moved into place only on success, so a dump
# interrupted halfway can never be mistaken for a good one by the restore side.
pg_dump --format=custom --compress=9 --file="$target.partial" "$DATABASE"
mv "$target.partial" "$target"

# Verified, not assumed: pg_restore --list reads the archive's table of
# contents and fails on a truncated or corrupt file. It costs a second and it
# is the difference between having backups and believing you do.
pg_restore --list "$target" > /dev/null

find "$DESTINATION" -name 'alo-noon-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$DESTINATION" -name 'alo-noon-*.dump.partial' -mtime +1 -delete

printf 'backup ok: %s (%s)\n' "$target" "$(du -h "$target" | cut -f1)"
