#!/usr/bin/env bash
#
# The live tier: the end-to-end suites under tests/live that call a real model
# on an in-process runtime. The eval suite (evals/, `bun run evals`) is a
# separate thing: it measures the deployed product, one task at a time.
#
# These do not belong at commit or push. They cost model calls, they take
# minutes, and a developer who cannot pay for them would learn to bypass the
# hook. So they live here, and this script is the whole tier.
#
# It does five things, in this order, and the order matters:
#
#   1. Names the target and the cost basis BEFORE spending anything, so a run
#      that goes somewhere unexpected is visible at the top of the log rather
#      than in a bill.
#   2. Runs `bun test ./tests/live/` once, capturing a JUnit report and a spend
#      file.
#   3. Enforces the skip ratchet over that report — the same run, not a second
#      one. A skipped test is a declared skip or a failure.
#   4. Reports what the run spent and how long it took.
#   5. HOLDS the run to that report. With a target resolved, a run that reports
#      no model call, or calls it cannot account for, exits non-zero, which is
#      how `TOTAL: 0 model call(s)` once passed a deploy gate.
#
# WHO IT RUNS AS, AND WHERE. The tier authenticates as the `eval-service`
# account and points at the deployment. Both are resolved once, by
# scripts/eval-credentials.ts over packages/test-utils/src/eval-identity.ts:
#
#   KINU_EVAL_TOKEN   the eval-service credential, or the session
#                        KINU_EVAL_WEB_IDENTITY=... bun scripts/eval-session-mint.ts
#                     persists under ~/.config/kinu/eval-session/
#   KINU_EVAL_ORIGIN  optional. Defaults to the deployment origin; a loopback
#                        dev server is the other accepted value.
#
# The resolved pair is exported as KINU_ORIGIN + KINU_TOKEN, which is what
# `resolveLiveModel` reads. An origin outside that allowlist is REFUSED and this
# script stops: the pair reaches the deployment's whole API, so every run acts as
# the eval service account and tears down its rows. An AI Gateway is accepted
# directly (AI_GATEWAY_BASE_URL + AI_GATEWAY_AUTH, or KINU_BASE_URL + KINU_AUTH);
# it fronts a model and no deployment, so it creates nothing.
#
# With no credential anywhere this script still runs and still passes: every
# live test skips, the ratchet proves the skips are the declared ones, and the
# spend report says zero.
#
# --backend local|cloud names where the agent under test lives. `local` (the
# default) is the in-process cli-backend runtime. `cloud` runs the one suite with
# a hosted arm, tests/live/live-smoke.test.ts, against the deployment, and needs
# the eval-service credential; the rest drive a CLIRuntime, which no deployed
# workspace hands out. --allow-stale lets a cloud run measure a deployment that is
# not this checkout's revision on purpose.
set -euo pipefail

cd "$(dirname "$0")/.."

BACKEND=local
ALLOW_STALE=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)
      BACKEND="${2:-}"
      shift 2
      ;;
    --backend=*)
      BACKEND="${1#*=}"
      shift
      ;;
    --allow-stale)
      ALLOW_STALE=(--allow-stale)
      shift
      ;;
    *)
      echo "live-tier: unknown argument '$1' — expected --backend local|cloud [--allow-stale]" >&2
      exit 2
      ;;
  esac
done

if [[ "$BACKEND" != local && "$BACKEND" != cloud ]]; then
  echo "live-tier: --backend must be 'local' or 'cloud', not '$BACKEND'" >&2
  exit 2
fi

export KINU_EVAL_BACKEND="$BACKEND"

# The first assignment is the default backend's argv, and the ladder reads it
# (`liveTierTargets` in scripts/ladder.ts) to credit this tier with its files.
TARGETS=(./tests/live/)

if [[ "$BACKEND" == cloud ]]; then
  TARGETS=(./tests/live/live-smoke.test.ts)
fi

REPORT_DIR="$(bun scripts/bench-retention.ts --family live --backend "$BACKEND")"
echo "retained reports: $REPORT_DIR"
JUNIT="$REPORT_DIR/junit-$BACKEND.xml"
SPEND="$REPORT_DIR/spend-$BACKEND.jsonl"
: > "$SPEND"

export KINU_EVAL_LIVE=1

RESOLVED_OUT="$(bun scripts/eval-credentials.ts)"
mapfile -t RESOLVED <<< "$RESOLVED_OUT"

if [[ ${#RESOLVED[@]} -eq 2 ]]; then
  export KINU_ORIGIN="${RESOLVED[0]}"
  export KINU_TOKEN="${RESOLVED[1]}"
fi

if [[ "$BACKEND" == cloud ]]; then
  if [[ -z "${KINU_TOKEN:-}" || -z "${KINU_ORIGIN:-}" ]]; then
    echo "live-tier: REFUSED — --backend cloud needs an eval-service credential for a Kinu" >&2
    echo "  deployment, and none resolved. Mint one; it is persisted where" >&2
    echo "  scripts/eval-credentials.ts reads it:" >&2
    echo "    KINU_EVAL_WEB_IDENTITY=... bun scripts/eval-session-mint.ts" >&2
    echo "  The local backend needs none:" >&2
    echo "    bun run test:live" >&2
    exit 1
  fi

  bun scripts/deploy-preflight.ts "${ALLOW_STALE[@]}" "$KINU_ORIGIN"
fi

EXPECT_LIVE=0
echo "── live tier ─────────────────────────────────────────────"

if [[ "$BACKEND" == cloud ]]; then
  echo "agent:   CLOUD — a real workspace on the deployment, driven through the"
  echo "         shipped CloudAgentClient; workspaces are eval-prefixed and deleted in teardown"
else
  echo "agent:   LOCAL — the in-process cli-backend runtime (the core runChat loop)"
fi

if [[ -n "${KINU_TOKEN:-}" && -n "${KINU_ORIGIN:-}" ]]; then
  echo "target:  worker proxy ${KINU_ORIGIN}/api/user/ai/v1"
  echo "identity: eval-service — no person's session is ever borrowed"
  echo "cost:    native Workers AI, billed to the account behind that deployment"
  echo "assert:  a model call and a token count, or this run FAILS"
  EXPECT_LIVE=1
elif [[ -n "${AI_GATEWAY_AUTH:-}${KINU_AUTH:-}" ]]; then
  echo "target:  AI Gateway ${AI_GATEWAY_BASE_URL:-${KINU_BASE_URL:-<unset>}}"
  echo "cost:    per the gateway's upstream provider"
  echo "assert:  a model call and a token count, or this run FAILS"
  EXPECT_LIVE=1
else
  echo "target:  none — every live test will skip, and the ratchet will say so"
  echo "cost:    zero"
  echo "assert:  nothing — with no target there is no liveness to prove"
fi

echo "──────────────────────────────────────────────────────────"

set +e
STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND"
bun test --timeout=0 "${TARGETS[@]}" --reporter=junit --reporter-outfile="$JUNIT"
TEST_STATUS=$?
SECONDS_SPENT=$((SECONDS - STARTED))

if [[ ! -f "$JUNIT" ]]; then
  echo "live-tier: the run produced no JUnit report (exit $TEST_STATUS) — nothing to measure" >&2
  exit 1
fi

echo
RATCHET_ARGS=(--junit "$JUNIT" --target "${TARGETS[0]}")
if [[ $EXPECT_LIVE -eq 1 ]]; then RATCHET_ARGS+=(--expect-live); fi
bun scripts/skip-ratchet.ts "${RATCHET_ARGS[@]}"
RATCHET_STATUS=$?

echo
echo "── live tier ($BACKEND): ${SECONDS_SPENT}s ─────────────────────────────"
SPEND_ARGS=("$SPEND")
if [[ $EXPECT_LIVE -eq 1 ]]; then SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${SPEND_ARGS[@]}"
SPEND_STATUS=$?

if [[ $TEST_STATUS -ne 0 ]]; then
  echo "live-tier: suites failed on the $BACKEND target (exit $TEST_STATUS)" >&2
  exit "$TEST_STATUS"
fi

if [[ $RATCHET_STATUS -ne 0 ]]; then exit "$RATCHET_STATUS"; fi

if [[ $SPEND_STATUS -ne 0 ]]; then
  echo "live-tier: the run proved no liveness on the $BACKEND target (exit $SPEND_STATUS)" >&2
  exit "$SPEND_STATUS"
fi

exit 0
