#!/usr/bin/env bash
#
# The eval tier: the suites that call a real model.
#
# These do not belong at commit or push. They cost model calls, they take
# minutes, and a developer who cannot pay for them would learn to bypass the
# hook — which is the one thing the gate ladder's monotonicity guarantees nobody
# ever needs to do. So they live here, at `ci`, and this script is the whole
# tier.
#
# It does four things, in this order, and the order matters:
#
#   1. Names the target and the cost basis BEFORE spending anything, so a run
#      that goes somewhere unexpected is visible at the top of the log rather
#      than in a bill.
#   2. Runs the suites once, capturing a JUnit report.
#   3. Enforces the skip ratchet over that report — the same run, not a second
#      one. A skipped test is a declared skip or a failure.
#   4. Reports what the run actually spent, summed from every suite process.
#
# Credentials, either pair (see packages/test-utils/src/live-model.ts):
#   PROTEUS_ORIGIN + PROTEUS_TOKEN        deployed/preview worker proxy. The
#                                         cheap path: the worker fronts the
#                                         owner's own Cloudflare credential, so
#                                         the model is native Workers AI and no
#                                         Cloudflare token touches this machine.
#                                         Mint one with:
#                                           proteus tokens create --scope ai.proxy
#   AI_GATEWAY_BASE_URL + AI_GATEWAY_AUTH an AI Gateway, for models the account
#                                         proxy does not front.
#
# With NEITHER, this script still runs and still passes: every live test skips,
# the ratchet proves the skips are the declared ones, and the tier reports zero
# spend. That is deliberate — a tier that cannot run without a secret is a tier
# nobody can reproduce, and the ratchet is the part that must never be optional.
set -euo pipefail

cd "$(dirname "$0")/.."

# Root-relative on purpose. `bun test --cwd <dir>` does NOT read the root
# bunfig.toml, so it loses both scripts/test-preload.ts (the throwaway
# PROTEUS_HOME that keeps a suite out of the developer's real ~/.proteus) and
# pathIgnorePatterns (which is what stops bun walking the gitignored external/
# `./tests/` recurses, so it already selects tests/evals/** — naming both would
# run every eval twice and double the bill for nothing.
TARGETS=(./tests/)

REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/proteus-eval-tier-XXXXXX")"
JUNIT="$REPORT_DIR/junit.xml"
SPEND="$REPORT_DIR/spend.jsonl"
: > "$SPEND"
trap 'rm -rf "$REPORT_DIR"' EXIT

export PROTEUS_EVAL_SPEND_FILE="$SPEND"

echo "── eval tier ─────────────────────────────────────────────"
if [[ -n "${PROTEUS_TOKEN:-}" && -n "${PROTEUS_ORIGIN:-}" ]]; then
  echo "target:  worker proxy ${PROTEUS_ORIGIN}/api/user/ai/v1"
  echo "cost:    native Workers AI, billed to the token owner's account"
elif [[ -n "${AI_GATEWAY_AUTH:-}${PROTEUS_AUTH:-}" ]]; then
  echo "target:  AI Gateway ${AI_GATEWAY_BASE_URL:-${PROTEUS_BASE_URL:-<unset>}}"
  echo "cost:    per the gateway's upstream provider"
else
  echo "target:  none — every live test will skip, and the ratchet will say so"
  echo "cost:    zero"
fi
echo "──────────────────────────────────────────────────────────"

# `|| true`: a live failure must still reach the ratchet and the spend report,
# because "what did it cost before it failed" is exactly what a reader needs.
# The recorded status is re-raised at the end.
set +e
bun test "${TARGETS[@]}" --reporter=junit --reporter-outfile="$JUNIT"
TEST_STATUS=$?

# The behavioural tier, on vitest. Disjoint from the bun suites above by FILE
# EXTENSION — bun matches only *.test.ts/_test/*.spec, never *.eval.ts — so the
# two runners cannot reach each other and no bunfig ignore pattern has to be kept
# in step with this. `bun --bun` is REQUIRED, not stylistic: the spine under test
# opens the agent store through `bun:sqlite`, and node-hosted vitest fails at
# import and collects ZERO tests, which would read as a clean tier.
#
# Its status is captured, never allowed to abort, for the same reason the bun
# suites are: a live failure must still reach the ratchet and the spend report,
# because "what did it cost before it failed" is what a reader needs.
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts
EVAL_STATUS=$?
if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$EVAL_STATUS; fi

if [[ ! -f "$JUNIT" ]]; then
  echo "eval-tier: bun test produced no JUnit report (exit $TEST_STATUS) — nothing to measure" >&2
  exit 1
fi

echo
bun scripts/skip-ratchet.ts --junit "$JUNIT"
RATCHET_STATUS=$?

echo
bun scripts/eval-spend.ts "$SPEND"

if [[ $TEST_STATUS -ne 0 ]]; then
  echo "eval-tier: suites failed (exit $TEST_STATUS)" >&2
  exit "$TEST_STATUS"
fi
exit "$RATCHET_STATUS"
