# Sourced by scripts/deploy.sh: the upload, and the one retry wrangler itself asks for. deploy.test.ts drives it with
# wrangler's recorded output.
#
# On 2026-10-09 staging's reset deploy uploaded version 174af18c; wrangler 4.145 then read the version back to find the
# KinuDevbox namespace (`fetchUploadedVersion`: five reads 500 ms apart), each answered 404, and it failed with the
# sentence below, asking for the same command to be run again (~/.config/.wrangler/logs/
# wrangler-2026-10-09_16-29-14_753.log, lines 4622-4822). Wrangler 4.149, the newest that day, reads the version back
# with the same retry loop, and its changelog since 4.145 names no fix. So the deploy does what wrangler says, once,
# with no wait of its own; any other failure is the upload's verdict as it stands.
WRANGLER_RUN_AGAIN='The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.'

# `upload <log> <command…>`: runs the command, its output on the terminal and in <log>. When it fails asking to be run
# again, it runs once more, writing <log> afresh. Its status is the last run's.
upload() {
  local log="$1"
  shift
  "$@" 2>&1 | tee "$log"
  local status="${PIPESTATUS[0]}"
  [ "$status" -eq 0 ] && return 0
  grep -qF "$WRANGLER_RUN_AGAIN" "$log" || return "$status"
  echo ""
  echo "The upload landed and wrangler asked for the same command again to finish its container application: running it once more."
  echo ""
  "$@" 2>&1 | tee "$log"
  return "${PIPESTATUS[0]}"
}
