#!/usr/bin/env bash
# Launch one Terminal-Bench arm only once the deployed transport IS the one the
# run is supposed to measure.
#
#   scripts/tbench-after-deploy.sh <expected-sha-file> <evolve> <seed> <size> <model> <concurrency>
#
# The arms reach the model through the DEPLOYED worker's /api/user/ai/v1, so a
# deploy mid-run is not CPU contention — it is the transport changing underneath
# the measurement. These trials die on AgentTimeoutError, so a latency shift
# moves the pass rate through the timeout channel rather than through the
# mechanism under test. Waiting means the whole contrast sits on one transport.
#
# The condition is an EQUALITY against the sha the operator declares deployed,
# read from a file so it can be written after this script starts and without the
# launching session being alive. It is deliberately NOT "the sha differs from
# what I remember": that form was already satisfied by a deploy that had landed
# before this script was written, so it would have fired mid-deploy and produced
# exactly the straddle it exists to prevent. A condition expressed against a
# remembered value drifts the moment reality moves; an equality against the thing
# actually cared about cannot.
#
# Bounded, not open: after WAIT_CAP the arm REFUSES rather than launching. A
# measurement whose transport was never confirmed is not a measurement, and a
# launcher that proceeds anyway would be a check that cannot fail.
set -euo pipefail

SHA_FILE="${1:?path to a file holding the sha /api/health must serve}"
shift
WAIT_CAP=${TBENCH_WAIT_CAP:-5400}
SETTLE=${TBENCH_SETTLE:-120}
HEALTH=https://kinu.run/api/health
WORKTREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

served() {
  curl -fsS --max-time 20 "$HEALTH" \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("build") or {}).get("sha",""))' \
    2>/dev/null || echo ""
}

started=$(date +%s)
echo "holding: will launch when $HEALTH serves the sha named in $SHA_FILE (cap ${WAIT_CAP}s)"
while :; do
  want=""
  [ -s "$SHA_FILE" ] && want="$(tr -d '[:space:]' < "$SHA_FILE")"
  now="$(served)"
  if [ -n "$want" ] && [ -n "$now" ] && [ "$now" = "$want" ]; then
    echo "TRANSPORT CONFIRMED: /api/health serves $now, which is the declared sha; settling ${SETTLE}s"
    sleep "$SETTLE"
    now2="$(served)"
    if [ "$now2" != "$want" ]; then
      echo "TRANSPORT MOVED AGAIN during settle ($now2 != $want) — restarting the hold"
      continue
    fi
    echo "TBENCH_TRANSPORT=$now"
    break
  fi
  if [ $(( $(date +%s) - started )) -ge "$WAIT_CAP" ]; then
    echo "REFUSING: after ${WAIT_CAP}s /api/health serves '${now:-unreachable}' and the declared sha is" >&2
    echo "'${want:-unwritten}'. This arm will not run against an unconfirmed transport: a contrast whose" >&2
    echo "model path nobody pinned cannot be reported, and launching anyway would be a check that" >&2
    echo "cannot fail. Write the deployed sha to $SHA_FILE and restart this arm." >&2
    exit 3
  fi
  sleep 15
done

exec "$WORKTREE/scripts/tbench-arm.sh" "$@"
