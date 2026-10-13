# Sourced by scripts/deploy.sh: the upload, the one retry wrangler itself asks for, and the retries a randomly refused
# startup takes (L26). deploy.test.ts drives it with wrangler's recorded output.
#
# On 2026-10-09 staging's reset deploy uploaded version 174af18c; wrangler 4.145 then read the version back to find the
# KinuDevbox namespace (`fetchUploadedVersion`: five reads 500 ms apart), each answered 404, and it failed with the
# sentence below, asking for the same command to be run again (~/.config/.wrangler/logs/
# wrangler-2026-10-09_16-29-14_753.log, lines 4622-4822). Wrangler 4.149, the newest that day, reads the version back
# with the same retry loop, and its changelog since 4.145 names no fix. So the deploy does what wrangler says, once,
# with no wait of its own; any other failure but a refused startup is the upload's verdict as it stands.
WRANGLER_RUN_AGAIN='The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.'

# Cloudflare's refusal of a version's startup (code 10021). It refuses the same bytes at random: deployed 15 times to a
# scratch Worker on 2026-10-13, 3b9c58d4c's startup read 427-861 ms and was never refused, 1e588c64d's was refused twice
# in 36, and 89759ebcc's five times in 21. After a reset the target serves its placeholder until an upload lands, and
# only `wrangler deploy` can land it (L26). So a refused startup is uploaded again, up to STARTUP_ATTEMPTS in all.
WRANGLER_STARTUP_REFUSED='Script startup exceeded CPU time limit'
STARTUP_ATTEMPTS=3

# `upload <log> <command…>`: runs the command, its output on the terminal and in <log>. When it fails asking to be run
# again, it runs once more, writing <log> afresh; when its startup was refused, it runs again up to STARTUP_ATTEMPTS in
# all. Its status is the last run's.
upload() {
  local log="$1"
  shift
  local attempt=1
  local status
  while :; do
    "$@" 2>&1 | tee "$log"
    status="${PIPESTATUS[0]}"
    [ "$status" -eq 0 ] && return 0
    grep -qF "$WRANGLER_STARTUP_REFUSED" "$log" || break
    [ "$attempt" -ge "$STARTUP_ATTEMPTS" ] && return "$status"
    attempt=$((attempt + 1))
    echo ""
    echo "Cloudflare refused this version's startup, which it does to the same bytes at random: uploading it again (attempt $attempt of $STARTUP_ATTEMPTS)."
    echo ""
  done
  grep -qF "$WRANGLER_RUN_AGAIN" "$log" || return "$status"
  echo ""
  echo "The upload landed and wrangler asked for the same command again to finish its container application: running it once more."
  echo ""
  "$@" 2>&1 | tee "$log"
  return "${PIPESTATUS[0]}"
}
