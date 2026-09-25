#!/bin/bash
#
# Finishes a web build so the standalone server can run it.
#
# Run from the release directory, after `pnpm build`, on first install and on
# every update. It is a script rather than lines in the runbook because the
# runbook had them twice and the copies drifted: the update procedure lost the
# two `cp` lines, so the first update after launch would have come up with
# every stylesheet and image answering 404 — a page with no styling, which does
# not look like a server fault and so is the slowest kind to diagnose.
#
# Three things Next.js standalone output does not do for itself:
#
# 1. `.next/static` — the CSS and JavaScript every page loads.
# 2. `public` — the font, the logo, the product photographs, the service worker.
# 3. `.next/cache` — where the image optimiser keeps what it has already
#    resized. The service runs under ProtectSystem=strict, so the release
#    directory is read-only to it; without a writable cache every product
#    photograph is re-encoded on every request (measured: ~4ms from cache,
#    ~120ms without, plus an EACCES line in the journal each time). The unit's
#    CacheDirectory= gives it /var/cache/alo-noon-web, and this links to it.
#    The cache is emptied here because its keys are the image's path, not its
#    contents: a photograph replaced under the same name would otherwise keep
#    serving the old one until the entry expired.

set -euo pipefail

release="${1:-$PWD}"
standalone="$release/apps/web/.next/standalone/apps/web"
cache=/var/cache/alo-noon-web

if [[ ! -f "$standalone/server.js" ]]; then
  echo "no standalone build under $release — run pnpm build first" >&2
  exit 1
fi

rm -rf "$standalone/.next/static" "$standalone/public"
cp -r "$release/apps/web/.next/static" "$standalone/.next/static"
cp -r "$release/apps/web/public" "$standalone/public"

install -d -m 0750 -o alo-noon -g alo-noon "$cache"
find "$cache" -mindepth 1 -delete
rm -rf "$standalone/.next/cache"
ln -sfn "$cache" "$standalone/.next/cache"

# The check the runbook's verification step makes, made here as well: a copy
# that silently produced nothing is the failure this script exists to prevent.
test -n "$(ls -A "$standalone/.next/static")"
test -f "$standalone/public/fonts/vazirmatn-variable.woff2"

echo "web staged: static, public and image cache in place under $standalone"
