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
# It does five things, in this order, and the order matters:
#
#   1. Names the target and the cost basis BEFORE spending anything, so a run
#      that goes somewhere unexpected is visible at the top of the log rather
#      than in a bill.
#   2. Runs the suites once, capturing a JUnit report.
#   3. Enforces the skip ratchet over that report — the same run, not a second
#      one. A skipped test is a declared skip or a failure.
#   4. Reports what the run actually spent, summed from every suite process.
#   5. HOLDS the run to that report. With a target resolved, a run that reports
#      no model call, or calls it cannot account for, exits non-zero. Step 4 has
#      always printed the defect; until step 5 existed it printed it and returned
#      success, which is how `TOTAL: 0 model call(s)` passed a deploy gate.
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
# Neither set? This script borrows the SIGNED-IN CLI session — the same
# `~/.proteus/config.json` credential `proteus chat` uses — via
# scripts/eval-credentials.ts. That is the fix for a measured defect, not a
# convenience: the tier asked for two env vars that nothing on the owner's own
# machine ever exported, so this deploy gate ran to completion reporting
# `TOTAL: 0 model call(s)` and every live suite skipped. An explicit
# PROTEUS_TOKEN or AI_GATEWAY_AUTH is never overridden.
#
# With no credential ANYWHERE, this script still runs and still passes: every
# live test skips, the ratchet proves the skips are the declared ones, the tier
# reports zero spend and step 5 asserts nothing because there is nothing to
# assert. That is deliberate — a tier that cannot run without a secret is a tier
# nobody can reproduce, and the ratchet is the part that must never be optional.
# The liveness assertion is conditional on a target for exactly that reason: it
# fires on "you had a model and did not call it", never on "you had no model".
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
# The ONE place this is set. `liveModelTarget` refuses to spend without it, so a
# credential exported in a developer's shell can no longer make the commit hook
# bill the owner's account — being driven by this script is the consent.
export PROTEUS_EVAL_LIVE=1

# Fill in the credential the tier asks for, from the signed-in CLI session, when
# the environment names no target. MUST be here rather than inside a suite:
# `scripts/test-scratch-home.ts` replaces PROTEUS_HOME with a throwaway directory
# at preload in every test process, so a resolver running under `bun test` reads
# an empty config and finds nothing. Two lines on stdout or none; the token never
# reaches argv or the log.
mapfile -t RESOLVED < <(bun scripts/eval-credentials.ts)
if [[ ${#RESOLVED[@]} -eq 2 ]]; then
  export PROTEUS_ORIGIN="${RESOLVED[0]}"
  export PROTEUS_TOKEN="${RESOLVED[1]}"
fi

# EXPECT_LIVE is this script's answer to the only question `scripts/eval-spend.ts`
# cannot answer for itself: was a target resolved. It is set beside the banner
# rather than recomputed later, so the line a reader sees and the assertion the
# run is held to can never disagree.
EXPECT_LIVE=0
echo "── eval tier ─────────────────────────────────────────────"
if [[ -n "${PROTEUS_TOKEN:-}" && -n "${PROTEUS_ORIGIN:-}" ]]; then
  echo "target:  worker proxy ${PROTEUS_ORIGIN}/api/user/ai/v1"
  echo "cost:    native Workers AI, billed to the token owner's account"
  echo "assert:  a model call and a token count, or this run FAILS"
  EXPECT_LIVE=1
elif [[ -n "${AI_GATEWAY_AUTH:-}${PROTEUS_AUTH:-}" ]]; then
  echo "target:  AI Gateway ${AI_GATEWAY_BASE_URL:-${PROTEUS_BASE_URL:-<unset>}}"
  echo "cost:    per the gateway's upstream provider"
  echo "assert:  a model call and a token count, or this run FAILS"
  EXPECT_LIVE=1
else
  echo "target:  none — every live test will skip, and the ratchet will say so"
  echo "cost:    zero"
  echo "assert:  nothing — with no target there is no liveness to prove"
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
# `--expect-live` turns a resolved target into an obligation: the tier must show
# a model call and a token count or exit non-zero. Without it, this reports and
# returns 0 — which is what let `TOTAL: 0 model call(s)` pass a deploy gate.
SPEND_ARGS=("$SPEND")
if [[ $EXPECT_LIVE -eq 1 ]]; then SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${SPEND_ARGS[@]}"
SPEND_STATUS=$?

# Precedence, most informative first. A suite failure names a behaviour or an
# outage and is what a reader should see; an undeclared skip is next; a tier that
# passed every assertion it made without reaching a model is last only because
# the two above already explain themselves.
if [[ $TEST_STATUS -ne 0 ]]; then
  echo "eval-tier: suites failed (exit $TEST_STATUS)" >&2
  exit "$TEST_STATUS"
fi
if [[ $RATCHET_STATUS -ne 0 ]]; then exit "$RATCHET_STATUS"; fi
if [[ $SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the run proved no liveness (exit $SPEND_STATUS)" >&2
  exit "$SPEND_STATUS"
fi
exit 0
