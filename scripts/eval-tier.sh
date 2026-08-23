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
# It runs FIVE ARMS. Two of them exist because two runners are needed and neither
# can see the other's files: `bun test ./tests/` for `*.test.ts`, and vitest for
# `tests/evals/**/*.eval.ts`, which bun's matcher does not select. The other three
# are single FILES on the vitest side — the live swarm eval, the research eval and
# the optimization eval — split off for cost accounting rather than for runners: an
# arm is the unit a spend file is written per, so an arm is the unit liveness can be
# asserted per, and each of those files has ONE live subject — a real search, a real
# retrieval from a controlled source, a real measured episode — whose silent zero
# has to be its own failure. Everything below is done for all five, and per arm
# where a reader needs the split.
#
# It does seven things, in this order, and the order matters:
#
#   1. Names the target and the cost basis BEFORE spending anything, so a run
#      that goes somewhere unexpected is visible at the top of the log rather
#      than in a bill.
#   2. Runs every arm once, capturing a JUnit report and a spend file EACH.
#   3. Enforces the skip ratchet over those reports — the same run, not a second
#      one, and every arm rather than one. A skipped test is a declared skip or a
#      failure. Until the vitest arm produced a report this step governed the bun
#      suites alone, and the arm it could not see reported 36 tests of which 35
#      skipped, exiting 0 with nothing declaring any of them.
#   4. Reports what each ARM spent and how long it took. One combined figure hid
#      which half of the tier the time was in, which is how "add roughly an hour
#      for the vitest behaviour arm" came to stand in for a measurement.
#   5. HOLDS THE LIVE SWARM ARM to its own report, over its own spend file. A
#      tier-wide total cannot fail on one arm's behalf: it sums every suite, so a
#      swarm eval that stopped reaching a model would hide behind whatever the
#      behaviour arm spent.
#   6. Reports what the whole run spent, summed from every suite process.
#   7. HOLDS the run to that report. With a target resolved, a run that reports
#      no model call, or calls it cannot account for, exits non-zero. Step 6 has
#      always printed the defect; until step 7 existed it printed it and returned
#      success, which is how `TOTAL: 0 model call(s)` passed a deploy gate.
#
# WHO IT RUNS AS, AND WHERE. The tier authenticates as the `eval-service`
# account and points at the staging deployment. Both are resolved once, by
# scripts/eval-credentials.ts over packages/test-utils/src/eval-identity.ts:
#
#   KINU_EVAL_TOKEN   the eval-service credential. Mint it against staging:
#                          kinu auth --origin https://staging.kinu.run
#                          kinu tokens create --name evals --scopes ai.proxy
#                        Staging synthesizes one fixed identity for every request
#                        (env.staging's DEV_USER_EMAIL), so that session IS
#                        eval-service and no person's account is involved.
#   KINU_EVAL_ORIGIN  optional. Defaults to the staging origin; a loopback dev
#                        server is the other accepted value.
#
# The resolved pair is exported as KINU_ORIGIN + KINU_TOKEN, which is what
# `resolveLiveModel` reads. An origin outside that allowlist is REFUSED and this
# script stops — production is reachable only by naming the exception,
# KINU_EVAL_ALLOW_PROD=1. That guard is not decoration: this pair reaches the
# deployment's whole API, and until it existed the tier ran against production on
# the owner's own session, leaving 23 test workspaces on the account among his 28.
#
# For models the account proxy does not front, an AI Gateway is still accepted
# directly: AI_GATEWAY_BASE_URL + AI_GATEWAY_AUTH (KINU_BASE_URL + KINU_AUTH are
# read as the same pair — `LIVE_MODEL_ENV` knows both spellings). A gateway
# fronts a model and no Kinu deployment, so it creates nothing and is not
# target-checked.
#
# A value in either variable that names a DEPLOYMENT is target-checked, though.
# `eval-identity.ts`'s `evalModelEndpointVerdict` rules on the origin first and
# falls back to the deployment's own inference route, and
# `scripts/eval-credentials.ts` stops this script when the answer is a refusal.
# Until that existed, `KINU_BASE_URL=https://kinu.run/api/user/ai/v1` announced
# itself as an AI Gateway and set EXPECT_LIVE=1 while pointing at production.
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
# KINU_HOME that keeps a suite out of the developer's real ~/.kinu) and
# pathIgnorePatterns (which is what stops bun walking the gitignored external/
# `./tests/` recurses, so it already selects tests/evals/** — naming both would
# run every eval twice and double the bill for nothing.
TARGETS=(./tests/)

# The LIVE SWARM arm, named as one file because it is billed as one.
#
# It is a `*.eval.ts` and so invisible to the bun arm above, which is what makes a
# THIRD arm possible at all: it gets its own process, therefore its own
# KINU_EVAL_SPEND_FILE, therefore its own liveness assertion. That last step is
# the reason it is separate rather than tidy — `livenessVerdict` sums the lines in
# the file it is given, so a swarm eval sharing a spend file with five paid suites
# could stop calling a model entirely and the tier would still report `proven`. The
# arm whose whole subject is a live search is the one arm whose zero has to be its
# own failure.
#
# Named here rather than twice below: the behaviour arm EXCLUDES this path and this
# arm SELECTS it, and the two spellings have to be one string or the file runs twice
# and is billed twice.
SWARM_EVAL=tests/evals/swarm.eval.ts

# The two SINGLE-FAMILY arms, named once for the same reason as the swarm file:
# the behaviour arm EXCLUDES each path and its own arm SELECTS it, and the two
# spellings have to be one string or the file runs twice and is billed twice.
#
# Each is an arm rather than a file inside the behaviour invocation for the
# reason the swarm eval is: an arm is the unit a spend file is written per, so
# an arm is the unit liveness can be asserted per — and each of these has ONE
# subject whose silent zero must be its own failure. The research eval's whole
# claim is a live retrieval from a controlled MCP source; the optimization
# eval's is a live episode against a metered instrument. Summed into the
# behaviour arm's spend, either could stop reaching a model and hide behind
# whatever the corpus episodes spent.
RESEARCH_EVAL=tests/evals/research.eval.ts
OPTIMIZATION_EVAL=tests/evals/optimization.eval.ts

# Per ARM, because "what did the tier cost" is not one number and reporting it as
# one hides the arm that dominates it: measured here, the bun arm is ~54 minutes
# and the vitest behaviour arm is the larger half, and until each was timed
# separately the tier's declared cost carried "add roughly an hour" for the second
# — a guess standing in for a measurement.
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kinu-eval-tier-XXXXXX")"
JUNIT="$REPORT_DIR/junit-bun.xml"
JUNIT_EVALS="$REPORT_DIR/junit-vitest.xml"
JUNIT_SWARM="$REPORT_DIR/junit-swarm.xml"
JUNIT_RESEARCH="$REPORT_DIR/junit-research.xml"
JUNIT_OPTIMIZATION="$REPORT_DIR/junit-optimization.xml"
SPEND_BUN="$REPORT_DIR/spend-bun.jsonl"
SPEND_EVALS="$REPORT_DIR/spend-vitest.jsonl"
SPEND_SWARM="$REPORT_DIR/spend-swarm.jsonl"
SPEND_RESEARCH="$REPORT_DIR/spend-research.jsonl"
SPEND_OPTIMIZATION="$REPORT_DIR/spend-optimization.jsonl"
SPEND="$REPORT_DIR/spend.jsonl"
: > "$SPEND_BUN"
: > "$SPEND_EVALS"
: > "$SPEND_SWARM"
: > "$SPEND_RESEARCH"
: > "$SPEND_OPTIMIZATION"
trap 'rm -rf "$REPORT_DIR"' EXIT

# The ONE place this is set. `liveModelTarget` refuses to spend without it, so a
# credential exported in a developer's shell can no longer make the commit hook
# bill the owner's account — being driven by this script is the consent.
export KINU_EVAL_LIVE=1

# Resolve the eval-service identity and put it where `resolveLiveModel` looks.
# MUST be here rather than inside a suite: `scripts/test-scratch-home.ts` strips
# the credential variables at preload in every test process, so a resolver
# running under `bun test` sees an empty environment. Two lines on stdout or
# none; the token never reaches argv or the log.
#
# A NON-ZERO EXIT IS FATAL. It means a credential was aimed at a deployment the
# allowlist refuses — production, unless KINU_EVAL_ALLOW_PROD=1 names the
# exception — and continuing would run the whole tier against whatever the
# environment happened to say. `set -e` is still in force here deliberately:
# this is the one failure that must abort before anything spends or writes.
# A COMMAND SUBSTITUTION, not `< <(…)`: `set -e` observes the exit status of an
# assignment's substitution, but a process substitution's status is discarded —
# `mapfile` succeeds on an empty stream, so the refusal would have been silent.
RESOLVED_OUT="$(bun scripts/eval-credentials.ts)"
mapfile -t RESOLVED <<< "$RESOLVED_OUT"
if [[ ${#RESOLVED[@]} -eq 2 ]]; then
  export KINU_ORIGIN="${RESOLVED[0]}"
  export KINU_TOKEN="${RESOLVED[1]}"
fi

# EXPECT_LIVE is this script's answer to the only question `scripts/eval-spend.ts`
# cannot answer for itself: was a target resolved. It is set beside the banner
# rather than recomputed later, so the line a reader sees and the assertion the
# run is held to can never disagree.
EXPECT_LIVE=0
echo "── eval tier ─────────────────────────────────────────────"
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

# `set +e`: a live failure must still reach the ratchet and the spend report,
# because "what did it cost before it failed" is exactly what a reader needs.
# The recorded status is re-raised at the end.
set +e

# Per-arm wall clock, taken here rather than derived from a reporter's own total.
# A vitest or bun summary times the tests it collected; the number a reader needs
# is what the tier costs them, which includes collection, credential resolution
# and teardown.
ARM_STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND_BUN"
bun test "${TARGETS[@]}" --reporter=junit --reporter-outfile="$JUNIT"
TEST_STATUS=$?
BUN_SECONDS=$((SECONDS - ARM_STARTED))

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
#
# `--reporter=junit` is not optional here either, and its absence was a hole
# rather than an omission: without a report from this arm the skip ratchet below
# governed the bun suites alone, and this arm reported 36 tests of which 35
# skipped, credential-free, exiting 0 with nothing declaring any of them. The
# default reporter is named alongside it because a JUnit-only run prints no
# progress at all, and this arm takes hours.
ARM_STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND_EVALS"
# `--exclude` PER SINGLE-FAMILY FILE: each is a `*.eval.ts` too, so this config's
# own `include` selects them, and without the exclusions each would run in this
# arm as well as its own — one episode, two bills, and a spend file per arm that
# double-counts. The arms below are where they run.
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts \
  --exclude "$SWARM_EVAL" --exclude "$RESEARCH_EVAL" --exclude "$OPTIMIZATION_EVAL" \
  --reporter=default --reporter=junit --outputFile="$JUNIT_EVALS"
EVAL_STATUS=$?
EVALS_SECONDS=$((SECONDS - ARM_STARTED))
if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$EVAL_STATUS; fi

# The live swarm arm: `agents({action:'swarm'})` through the real tool surface,
# graded by the caller's own verifier. One file, selected by path, so the arm's
# spend file holds exactly this suite's line and the assertion below is about this
# suite and nothing else.
#
# Same runner and same config as the arm above — it needs `bun:sqlite` for the agent
# store, the hook timeout for opening a workspace, and `fileParallelism: false` so a
# tree of real tool-using nodes is not racing another suite's model calls against one
# account — so this is a second INVOCATION rather than a second config. Its status is
# captured and never allowed to abort for the reason both arms above are: what a
# failed run cost before it failed is what a reader needs.
ARM_STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND_SWARM"
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$SWARM_EVAL" \
  --reporter=default --reporter=junit --outputFile="$JUNIT_SWARM"
SWARM_STATUS=$?
SWARM_SECONDS=$((SECONDS - ARM_STARTED))
if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$SWARM_STATUS; fi

# The research arm: one agent episode against the controlled MCP archive,
# scored by exact match on what that archive plants. Same runner and config as
# the arms above for the same reasons; its own invocation so its spend file
# holds exactly this family's lines.
ARM_STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND_RESEARCH"
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$RESEARCH_EVAL" \
  --reporter=default --reporter=junit --outputFile="$JUNIT_RESEARCH"
RESEARCH_STATUS=$?
RESEARCH_SECONDS=$((SECONDS - ARM_STARTED))
if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$RESEARCH_STATUS; fi

# The optimization arm: one agent episode against the metered corpus instrument,
# held to its pre-registered threshold, with swarm use recorded rather than
# dictated.
ARM_STARTED=$SECONDS
export KINU_EVAL_SPEND_FILE="$SPEND_OPTIMIZATION"
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$OPTIMIZATION_EVAL" \
  --reporter=default --reporter=junit --outputFile="$JUNIT_OPTIMIZATION"
OPTIMIZATION_STATUS=$?
OPTIMIZATION_SECONDS=$((SECONDS - ARM_STARTED))
if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$OPTIMIZATION_STATUS; fi

for arm in "bun suites:$JUNIT" "behaviour evals:$JUNIT_EVALS" "live swarm:$JUNIT_SWARM" \
  "research:$JUNIT_RESEARCH" "optimization:$JUNIT_OPTIMIZATION"; do
  if [[ ! -f "${arm#*:}" ]]; then
    echo "eval-tier: the ${arm%%:*} arm produced no JUnit report (exit $TEST_STATUS) — nothing to" \
      "measure, and an unmeasured arm is what this tier exists to make impossible" >&2
    exit 1
  fi
done

echo
# BOTH reports, and `--expect-live` when a target was resolved. One report
# governed one arm; the flag is what stops a locked skip that RAN — which is the
# tier working — from being read as the lock owing an update, a verdict that made
# this script unable to exit 0 on any machine holding a credential.
RATCHET_ARGS=(--junit "$JUNIT" --junit "$JUNIT_EVALS" --junit "$JUNIT_SWARM"
  --junit "$JUNIT_RESEARCH" --junit "$JUNIT_OPTIMIZATION")
if [[ $EXPECT_LIVE -eq 1 ]]; then RATCHET_ARGS+=(--expect-live); fi
bun scripts/skip-ratchet.ts "${RATCHET_ARGS[@]}"
RATCHET_STATUS=$?

echo
echo "── per arm ───────────────────────────────────────────────"
printf 'bun suites       %5ds  %s\n' "$BUN_SECONDS" "$(bun scripts/eval-spend.ts "$SPEND_BUN" \
  | sed -n 's/^  TOTAL: //p')"
printf 'behaviour evals  %5ds  %s\n' "$EVALS_SECONDS" "$(bun scripts/eval-spend.ts "$SPEND_EVALS" \
  | sed -n 's/^  TOTAL: //p')"
printf 'live swarm       %5ds  %s\n' "$SWARM_SECONDS" "$(bun scripts/eval-spend.ts "$SPEND_SWARM" \
  | sed -n 's/^  TOTAL: //p')"
printf 'research         %5ds  %s\n' "$RESEARCH_SECONDS" "$(bun scripts/eval-spend.ts "$SPEND_RESEARCH" \
  | sed -n 's/^  TOTAL: //p')"
printf 'optimization     %5ds  %s\n' "$OPTIMIZATION_SECONDS" "$(bun scripts/eval-spend.ts "$SPEND_OPTIMIZATION" \
  | sed -n 's/^  TOTAL: //p')"
printf 'tier             %5ds\n' \
  "$((BUN_SECONDS + EVALS_SECONDS + SWARM_SECONDS + RESEARCH_SECONDS + OPTIMIZATION_SECONDS))"
echo "──────────────────────────────────────────────────────────"

echo
# EACH ARM'S OWN LIVENESS, before the tier-wide one. A tier-wide total cannot
# fail on one arm's behalf because another arm's spend can hide it. The same
# `EXPECT_LIVE` value controls the banner and every assertion.
echo "── bun suites arm ─────────────────────────────────────────"
BUN_SPEND_ARGS=("$SPEND_BUN")
if [[ $EXPECT_LIVE -eq 1 ]]; then BUN_SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${BUN_SPEND_ARGS[@]}"
BUN_SPEND_STATUS=$?
echo "──────────────────────────────────────────────────────────"

echo
echo "── behaviour evals arm ────────────────────────────────────"
EVALS_SPEND_ARGS=("$SPEND_EVALS")
if [[ $EXPECT_LIVE -eq 1 ]]; then EVALS_SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${EVALS_SPEND_ARGS[@]}"
EVALS_SPEND_STATUS=$?
echo "──────────────────────────────────────────────────────────"

echo
echo "── live swarm arm ────────────────────────────────────────"
SWARM_SPEND_ARGS=("$SPEND_SWARM")
if [[ $EXPECT_LIVE -eq 1 ]]; then SWARM_SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${SWARM_SPEND_ARGS[@]}"
SWARM_SPEND_STATUS=$?
echo "──────────────────────────────────────────────────────────"

echo
echo "── research arm ──────────────────────────────────────────"
RESEARCH_SPEND_ARGS=("$SPEND_RESEARCH")
if [[ $EXPECT_LIVE -eq 1 ]]; then RESEARCH_SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${RESEARCH_SPEND_ARGS[@]}"
RESEARCH_SPEND_STATUS=$?
echo "──────────────────────────────────────────────────────────"

echo
echo "── optimization arm ──────────────────────────────────────"
OPTIMIZATION_SPEND_ARGS=("$SPEND_OPTIMIZATION")
if [[ $EXPECT_LIVE -eq 1 ]]; then OPTIMIZATION_SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${OPTIMIZATION_SPEND_ARGS[@]}"
OPTIMIZATION_SPEND_STATUS=$?
echo "──────────────────────────────────────────────────────────"

echo
# `--expect-live` turns a resolved target into an obligation: the tier must show
# a model call and a token count or exit non-zero. Without it, this reports and
# returns 0 — which is what let `TOTAL: 0 model call(s)` pass a deploy gate.
cat "$SPEND_BUN" "$SPEND_EVALS" "$SPEND_SWARM" "$SPEND_RESEARCH" "$SPEND_OPTIMIZATION" > "$SPEND"
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
# The per-arm verdicts before the tier-wide one: "the research arm reached no model"
# is a sharper sentence than "the tier reached no model", and each is the only one
# a paid behaviour arm cannot mask.
if [[ $BUN_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the bun suites arm proved no liveness (exit $BUN_SPEND_STATUS)" >&2
  exit "$BUN_SPEND_STATUS"
fi
if [[ $EVALS_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the behaviour evals arm proved no liveness (exit $EVALS_SPEND_STATUS)" >&2
  exit "$EVALS_SPEND_STATUS"
fi
if [[ $SWARM_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the live swarm arm proved no liveness (exit $SWARM_SPEND_STATUS)" >&2
  exit "$SWARM_SPEND_STATUS"
fi
if [[ $RESEARCH_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the research arm proved no liveness (exit $RESEARCH_SPEND_STATUS)" >&2
  exit "$RESEARCH_SPEND_STATUS"
fi
if [[ $OPTIMIZATION_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the optimization arm proved no liveness (exit $OPTIMIZATION_SPEND_STATUS)" >&2
  exit "$OPTIMIZATION_SPEND_STATUS"
fi
if [[ $SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the run proved no liveness (exit $SPEND_STATUS)" >&2
  exit "$SPEND_STATUS"
fi
exit 0
