#!/usr/bin/env bash
#
# Smoke test for the lidarr-on-steroids container.
#
# Purpose: this branch (lidarr-version-update) only bumps the Lidarr base image and the
# Deemix commit. The image still *builds* fine on a bad bump — what breaks is the custom
# integration glued on top (Caddy reverse proxy, track-picker sidecar, UI injection,
# Lidarr autoconfig). This script asserts all of that actually works against a running
# container, so a version bump that breaks the wiring fails CI instead of shipping.
#
# Credentials: most checks need NONE. A *dummy* 192-char ARL unblocks the autoconfig
# (setup/run blocks until /config_deemix/login.json holds a 192-char arl), which is enough to
# verify services, UI injection, plugin install, root folder, delay profile and notifications.
# BUT the Deemix indexer + download client saves are validated against Deezer even with
# forceSave=true, so a dummy ARL can NOT create them — checks 8 & 9 need a REAL ARL. They run
# only when REAL_ARL=1 (the workflow sets that when the DEEZER_ARL secret is present);
# otherwise they're SKIPPED, not failed. The workflow injects the ARL before this script runs;
# for local runs do it yourself first, e.g.:
#
#   ARL=$(printf 'a%.0s' $(seq 1 192))   # or paste your real 192-char ARL and use REAL_ARL=1
#   docker exec los sh -c "printf '{\"arl\":\"$ARL\"}' > /config_deemix/login.json"
#   REAL_ARL=0 bash .github/scripts/smoke-test.sh
#
# Overridable via env: CONTAINER (default los), LIDARR_URL (http://localhost:8686),
# DEEMIX_URL (http://localhost:6595), TIMEOUT (seconds to wait for autoconfig, default 480),
# REAL_ARL (0/1 — whether a real ARL was injected, gates checks 8 & 9).
# Requires: docker, curl, jq (all present on ubuntu-latest runners).

set -u

CONTAINER="${CONTAINER:-los}"
LIDARR_URL="${LIDARR_URL:-http://localhost:8686}"
DEEMIX_URL="${DEEMIX_URL:-http://localhost:6595}"
TIMEOUT="${TIMEOUT:-480}"
REAL_ARL="${REAL_ARL:-0}"
MARKER="AUTOCONFIG COMPLETED"

PASS=0
FAIL=0
SKIP=0
FAILED_LIST=""

green()  { printf '\033[32m%s\033[0m' "$1"; }
red()    { printf '\033[31m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }

# run <description> <function-name> — runs the check function, records pass/fail.
run() {
    local desc="$1" fn="$2"
    if "$fn" >/dev/null 2>&1; then
        printf '  %s %s\n' "$(green '✓ PASS')" "$desc"
        PASS=$((PASS + 1))
    else
        printf '  %s %s\n' "$(red '✗ FAIL')" "$desc"
        FAIL=$((FAIL + 1))
        FAILED_LIST="${FAILED_LIST}
    - ${desc}"
    fi
}

# skip <description> <reason> — records a check that was deliberately not run.
skip() {
    local desc="$1" reason="$2"
    printf '  %s %s (%s)\n' "$(yellow '○ SKIP')" "$desc" "$reason"
    SKIP=$((SKIP + 1))
}

container_running() {
    [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# ---------------------------------------------------------------------------
# Step 1: wait for the container to finish autoconfiguring.
# The setup service prints "AUTOCONFIG COMPLETED" only after Lidarr is up, the Deemix
# plugin is installed (+ Lidarr restarted), the dummy ARL has been consumed, and the
# indexer/download-client/notifications have been written — i.e. the whole chain we
# want to test. Plugin download + Lidarr restart is the slow part, hence the long wait.
# ---------------------------------------------------------------------------
echo "Waiting up to ${TIMEOUT}s for '${MARKER}' from container '${CONTAINER}'..."
deadline=$(( $(date +%s) + TIMEOUT ))
while true; do
    if docker logs "$CONTAINER" 2>&1 | grep -q "$MARKER"; then
        echo "Autoconfig completed."
        break
    fi
    if ! container_running; then
        echo "ERROR: container '${CONTAINER}' is not running (exited before autoconfig completed)."
        docker logs "$CONTAINER" 2>&1 | tail -n 80
        exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "ERROR: timed out after ${TIMEOUT}s waiting for '${MARKER}'."
        docker logs "$CONTAINER" 2>&1 | tail -n 80
        exit 1
    fi
    sleep 5
done

# ---------------------------------------------------------------------------
# Step 2: pull the Lidarr API key from inside the container (same extraction setup/run
# uses), for the authenticated assertions below.
# ---------------------------------------------------------------------------
API_KEY="$(docker exec "$CONTAINER" sh -c "grep -oP '(?<=<ApiKey>)[^<]+' /config/config.xml" 2>/dev/null | tr -d '\r\n')"
if [ -z "$API_KEY" ]; then
    echo "ERROR: could not read Lidarr API key from /config/config.xml in container."
    exit 1
fi

# Authenticated Lidarr API GET: api <route>
api() { curl -fsS -H "X-Api-Key: $API_KEY" "$LIDARR_URL/api/v1/$1"; }

# ---------------------------------------------------------------------------
# Step 3: assertions. Each proves one wire of the integration still works.
# ---------------------------------------------------------------------------

# 1. Lidarr reachable through Caddy's catch-all proxy (:8686 -> :8685).
c01() { curl -fsS "$LIDARR_URL/ping" | grep -qi 'OK'; }

# 2. Deemix built and serving its API.
c02() { curl -fsS "$DEEMIX_URL/api/getSettings"; }

# 3. track-picker sidecar up AND Caddy's /picker-api rewrite works (-> sidecar :7171 /api/health).
c03() { curl -fsS "$LIDARR_URL/picker-api/health" | grep -q '"ok":true'; }

# 4. UI injection: picker assets were copied into Lidarr's UI dir and are served. Grep for a
#    token unique to our inject.js (the /picker-api base path) so a login/HTML page won't pass.
c04a() { curl -fsS "$LIDARR_URL/picker/inject.js" | grep -q 'picker-api'; }
c04b() { [ -n "$(curl -fsS "$LIDARR_URL/picker/picker.css")" ]; }

# 5. Deemix plugin installed into Lidarr (install + restart survived the version bump).
c05() { api "system/plugins" | grep -q 'Deemix'; }

# 6. /music root folder configured by autoconfig.
c06() { api "rootfolder" | grep -q '/music'; }

# 7. Deemix protocol allowed in the default delay profile (setup/run checks items[2].allowed).
c07() { [ "$(api 'delayprofile' | jq -r '.[0].items[2].allowed')" = "true" ]; }

# 8. Deemix indexer created — exercises the update_arl POST schema against the new plugin.
c08() { api "indexer" | grep -q 'Deemix'; }

# 9. Deemix download client created — same, download-client schema.
c09() { api "downloadclient" | grep -q 'Deemix'; }

# 10. Notifications: clean-downloads always; flac2 because FLAC2CUSTOM_ARGS is set.
c10a() { api "notification" | grep -q 'Clean Downloads'; }
c10b() { api "notification" | grep -qi 'flac2'; }

# 11. ffmpeg layer + flac2mp3 submodule scripts present in the image.
c11a() { docker exec "$CONTAINER" ffmpeg -version; }
c11b() { docker exec "$CONTAINER" test -x /usr/local/bin/flac2custom.sh; }
c11c() { docker exec "$CONTAINER" test -e /usr/local/bin/clean-downloads.sh; }

# 12. No crash loop — container still up after everything.
c12() { container_running; }

echo
echo "Running smoke assertions against ${LIDARR_URL} / ${DEEMIX_URL} (container '${CONTAINER}'):"
run "1.  Lidarr up via Caddy catch-all (:8686/ping)"          c01
run "2.  Deemix up (:6595/api/getSettings)"                   c02
run "3.  track-picker sidecar + Caddy /picker-api rewrite"    c03
run "4a. UI injection: /picker/inject.js served (our JS)"     c04a
run "4b. UI injection: /picker/picker.css served"             c04b
run "5.  Deemix plugin installed in Lidarr"                   c05
run "6.  Root folder /music configured"                       c06
run "7.  Deemix allowed in default delay profile"             c07
if [ "$REAL_ARL" = "1" ]; then
    run "8.  Deemix indexer present (update_arl POST schema)"  c08
    run "9.  Deemix download client present"                   c09
else
    skip "8.  Deemix indexer present"          "needs real DEEZER_ARL secret"
    skip "9.  Deemix download client present"  "needs real DEEZER_ARL secret"
fi
run "10a. 'Clean Downloads' notification configured"          c10a
run "10b. flac2 notification configured (FLAC2CUSTOM_ARGS)"   c10b
run "11a. ffmpeg present in image"                            c11a
run "11b. flac2custom.sh present & executable"                c11b
run "11c. clean-downloads.sh present"                         c11c
run "12. Container still running (no crash loop)"             c12

echo
echo "----------------------------------------------------------------------"
printf 'Smoke test: %s passed, %s failed, %s skipped (of %s)\n' \
    "$PASS" "$FAIL" "$SKIP" "$((PASS + FAIL + SKIP))"
if [ "$REAL_ARL" != "1" ]; then
    echo "Indexer/download-client (8, 9) were SKIPPED — they need a real ARL (set the"
    echo "DEEZER_ARL repo secret). For reference, here is what the dummy-ARL autoconfig"
    echo "logged for those saves (a 4xx here is the expected Deezer-auth rejection):"
    docker logs "$CONTAINER" 2>&1 | grep -iE '\[autoconfig\].*(indexer|download.?client)' | sed 's/^/    /' || true
fi
if [ "$FAIL" -ne 0 ]; then
    printf 'Failures:%b\n' "$FAILED_LIST"
    echo "----------------------------------------------------------------------"
    exit 1
fi
echo "All smoke checks passed."
echo "----------------------------------------------------------------------"
