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

# ── WHICH TARGET THIS RUN MEASURES ────────────────────────────────────────────
#
# `--backend local` (the default) drives the in-process cli-backend runtime.
# `--backend cloud` drives a real workspace on the staging deployment, through
# the shipped CloudAgentClient and the AGENT_RPC_ACCESS RPC surface. Tests and
# evals are ONE suite; which of the two an arm runs against is configuration,
# and `packages/test-utils/src/eval-target.ts` is that configuration's type.
#
# CLOUD IS EXPLICIT AND MANUAL, never reached by a gate tier. It costs model
# calls AND creates workspaces on a shared account, so it is named on the
# command line (`bun run evals:cloud`) on top of everything the live tier
# already requires. Nothing here changes what the default invocation does.
#
# IT ADDS AN ARM, IT DOES NOT FOLD INTO ONE. Every report and spend file below
# carries the backend in its name, so a cloud run cannot overwrite a local run's
# evidence and `eval-spend.ts --expect-live` still asserts liveness per arm — a
# flag that merged the two would let a silent zero in one target hide behind the
# other's spend.
#
# WHY THE CLOUD ARM RUNS A NAMED SUBSET. Only the suites that provision through
# `resolveEvalTarget` can answer both targets' questions; the rest are local by
# construction (they open a `bun:sqlite` store or a `CLIRuntime` directly).
# Running one of those under a cloud banner would report a local measurement as a
# cloud one, which is the error the seam exists to remove. The list is the
# `TARGETS` / `RUN_*_ARM` block below, and it is the ONE list.
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
    # Measure the DEPLOYED build on purpose — a bisect, or reproducing a
    # production report — rather than this branch. Passed through to the
    # preflight so the choice is recorded in the command somebody ran.
    --allow-stale)
      ALLOW_STALE=(--allow-stale)
      shift
      ;;
    *)
      echo "eval-tier: unknown argument '$1' — expected --backend local|cloud [--allow-stale]" >&2
      exit 2
      ;;
  esac
done
if [[ "$BACKEND" != local && "$BACKEND" != cloud ]]; then
  echo "eval-tier: --backend must be 'local' or 'cloud', not '$BACKEND'" >&2
  exit 2
fi
export KINU_EVAL_BACKEND="$BACKEND"

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

# The BEHAVIOUR arm's identity. It is the only arm that SELECTS BY EXCLUSION —
# the config's `include` minus the three files above — so it passes no path to
# vitest and this string is never argv. It is here because the skip ratchet
# proves one target per arm non-empty, and an arm with no name cannot be proven:
# before the arms carried their targets, this file's path lived only inside
# `SKIP_RATCHET_VITEST_TARGETS` and the two could disagree about which arm
# existed. `scripts/ladder.test.ts` holds the four names here equal to the
# `*.eval.ts` files on disk, so a fifth cannot join the behaviour arm silently.
BEHAVIOUR_EVAL=tests/evals/behaviour.eval.ts

# ── WHICH ARMS THIS BACKEND CAN MEASURE ───────────────────────────────────────
#
# THE ONE LIST, and it is a list of what READS THE KNOB rather than of what is
# affordable. A suite can answer both targets' questions only once it provisions
# through `resolveEvalTarget` and asserts over `AgentEvalTarget`; a suite that
# calls `provisionLocalTarget` itself is local whatever this variable says.
# Naming one here anyway is worse than omitting it: the run gets a CLOUD banner,
# `-cloud` report and spend filenames, and an in-process measurement inside all
# three. That is the confusion the seam exists to remove, so an arm that cannot
# read the knob is SKIPPED and named, never run and relabelled.
#
# `tests/e2e-lifecycle.test.ts` WAS named here and could not honour it: every
# assertion in it drives `generateText`, `EvolutionEngine` and `runMCTS` over a
# `CLIRuntime`, and a deployed workspace hands out no runtime. It now reads the
# knob and skips itself under `=cloud`, so removing it here and the refusal there
# say the same thing from both ends.
#
# The bun arm's cloud target is a FILE LIST rather than `./tests/`: that
# directory is ~54 minutes of suites that cannot read the knob, and paying for a
# deployment while running them would buy nothing.
#
# Add a migrated suite here in the same commit that migrates it, and only once
# its own provisioning goes through the plan. A suite on the seam that nobody
# added is a target the tier never exercises.
if [[ "$BACKEND" == cloud ]]; then
  TARGETS=(tests/live-smoke.test.ts)
  RUN_EVALS_ARM=0
  # The swarm arm's CROSS-TARGET test provisions through the plan, so it drives a
  # real staging workspace here — the only arm in the tree that reaches
  # `@cloudflare/think`, the loop that carries the step cap. That suite's
  # in-process arms skip themselves under this backend and print why.
  RUN_SWARM_ARM=1
  RUN_RESEARCH_ARM=0
  RUN_OPTIMIZATION_ARM=0
  SKIPPED_ARMS="behaviour evals, research, optimization (not on the target seam yet); \
e2e-lifecycle and the swarm suite's in-process arms (they drive a CLIRuntime, which no \
deployed workspace hands out)"
else
  RUN_EVALS_ARM=1
  RUN_SWARM_ARM=1
  RUN_RESEARCH_ARM=1
  RUN_OPTIMIZATION_ARM=1
  SKIPPED_ARMS=""
fi

# Per ARM, because "what did the tier cost" is not one number and reporting it as
# one hides the arm that dominates it: measured here, the bun arm is ~54 minutes
# and the vitest behaviour arm is the larger half, and until each was timed
# separately the tier's declared cost carried "add roughly an hour" for the second
# — a guess standing in for a measurement.
# The backend is in every filename, so a cloud run cannot overwrite a local
# run's evidence in the same tree and `eval-spend.ts --expect-live` keeps
# asserting liveness per arm rather than over a merged total.
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kinu-eval-tier-XXXXXX")"
JUNIT="$REPORT_DIR/junit-bun-$BACKEND.xml"
JUNIT_EVALS="$REPORT_DIR/junit-vitest-$BACKEND.xml"
JUNIT_SWARM="$REPORT_DIR/junit-swarm-$BACKEND.xml"
JUNIT_RESEARCH="$REPORT_DIR/junit-research-$BACKEND.xml"
JUNIT_OPTIMIZATION="$REPORT_DIR/junit-optimization-$BACKEND.xml"
SPEND_BUN="$REPORT_DIR/spend-bun-$BACKEND.jsonl"
SPEND_EVALS="$REPORT_DIR/spend-vitest-$BACKEND.jsonl"
SPEND_SWARM="$REPORT_DIR/spend-swarm-$BACKEND.jsonl"
SPEND_RESEARCH="$REPORT_DIR/spend-research-$BACKEND.jsonl"
SPEND_OPTIMIZATION="$REPORT_DIR/spend-optimization-$BACKEND.jsonl"
SPEND="$REPORT_DIR/spend-$BACKEND.jsonl"
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

# THE CLOUD ARM'S PREFLIGHT, before anything spends and before any workspace is
# created. A cloud run's whole claim is that it measures the product, so which
# BUILD it measures is the first thing that has to be true: a run against a
# week-old deployment reports that deployment's behaviour under this branch's
# name, and the branch is where a reader will look for the cause. Measured on
# 2026-08-24, the deployed sha was 27 commits behind the checkout.
#
# It REFUSES rather than warning, because the alternative is a paid run whose
# subject nobody can establish afterwards. `--allow-stale` is the recorded way to
# measure the deployed build on purpose. `set -e` is still in force: like the
# credential refusal above, this must abort before anything writes.
#
# A CREDENTIAL IS REQUIRED for this arm and only this arm. The local arm runs and
# passes with no credential anywhere — every live test skips and the ratchet
# proves the skips are declared — but a cloud arm with nothing to authenticate as
# cannot create the workspace it exists to drive, and reporting that as a skip
# would let `evals:cloud` exit 0 having measured nothing.
if [[ "$BACKEND" == cloud ]]; then
  if [[ -z "${KINU_TOKEN:-}" || -z "${KINU_ORIGIN:-}" ]]; then
    echo "eval-tier: REFUSED — --backend cloud needs an eval-service credential for a Kinu" >&2
    echo "  deployment, and none resolved. Mint one against staging:" >&2
    echo "    kinu auth --origin https://staging.kinu.run" >&2
    echo "    kinu tokens create --name evals --scopes ai.proxy" >&2
    echo "  then export it as KINU_EVAL_TOKEN. The local arm needs none:" >&2
    echo "    bun run test:eval" >&2
    exit 1
  fi
  bun scripts/staging-preflight.ts "${ALLOW_STALE[@]}" "$KINU_ORIGIN"
fi

# EXPECT_LIVE is this script's answer to the only question `scripts/eval-spend.ts`
# cannot answer for itself: was a target resolved. It is set beside the banner
# rather than recomputed later, so the line a reader sees and the assertion the
# run is held to can never disagree.
EXPECT_LIVE=0
echo "── eval tier ─────────────────────────────────────────────"
# WHICH AGENT RAN, printed first. "The behaviour eval passed" is a different
# claim about the local runtime than about the deployed Worker — they are two
# turn loops, and one of them carried a ten-step cap the other did not for weeks
# while every suite in the tree stayed green. A run whose output does not say
# which agent it drove is not evidence.
if [[ "$BACKEND" == cloud ]]; then
  echo "agent:   CLOUD — a real workspace on the staging deployment, driven"
  echo "         through the shipped CloudAgentClient (the @cloudflare/think loop)"
  echo "         workspaces are eval-prefixed and deleted in teardown"
  echo "         arms that drive a CLIRuntime skip themselves here and print why"
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
EVAL_STATUS=0
EVALS_SECONDS=0
export KINU_EVAL_SPEND_FILE="$SPEND_EVALS"
if [[ $RUN_EVALS_ARM -eq 1 ]]; then
  # `--exclude` PER SINGLE-FAMILY FILE: each is a `*.eval.ts` too, so this
  # config's own `include` selects them, and without the exclusions each would
  # run in this arm as well as its own — one episode, two bills, and a spend file
  # per arm that double-counts. The arms below are where they run.
  bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts \
    --exclude "$SWARM_EVAL" --exclude "$RESEARCH_EVAL" --exclude "$OPTIMIZATION_EVAL" \
    --reporter=default --reporter=junit --outputFile="$JUNIT_EVALS"
  EVAL_STATUS=$?
  EVALS_SECONDS=$((SECONDS - ARM_STARTED))
  if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$EVAL_STATUS; fi
fi

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
SWARM_STATUS=0
SWARM_SECONDS=0
export KINU_EVAL_SPEND_FILE="$SPEND_SWARM"
if [[ $RUN_SWARM_ARM -eq 1 ]]; then
  bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$SWARM_EVAL" \
    --reporter=default --reporter=junit --outputFile="$JUNIT_SWARM"
  SWARM_STATUS=$?
  SWARM_SECONDS=$((SECONDS - ARM_STARTED))
  if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$SWARM_STATUS; fi
fi

# The research arm: one agent episode against the controlled MCP archive,
# scored by exact match on what that archive plants. Same runner and config as
# the arms above for the same reasons; its own invocation so its spend file
# holds exactly this family's lines.
ARM_STARTED=$SECONDS
RESEARCH_STATUS=0
RESEARCH_SECONDS=0
export KINU_EVAL_SPEND_FILE="$SPEND_RESEARCH"
if [[ $RUN_RESEARCH_ARM -eq 1 ]]; then
  bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$RESEARCH_EVAL" \
    --reporter=default --reporter=junit --outputFile="$JUNIT_RESEARCH"
  RESEARCH_STATUS=$?
  RESEARCH_SECONDS=$((SECONDS - ARM_STARTED))
  if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$RESEARCH_STATUS; fi
fi

# The optimization arm: one agent episode against the metered corpus instrument,
# held to its pre-registered threshold, with swarm use recorded rather than
# dictated.
ARM_STARTED=$SECONDS
OPTIMIZATION_STATUS=0
OPTIMIZATION_SECONDS=0
export KINU_EVAL_SPEND_FILE="$SPEND_OPTIMIZATION"
if [[ $RUN_OPTIMIZATION_ARM -eq 1 ]]; then
  bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$OPTIMIZATION_EVAL" \
    --reporter=default --reporter=junit --outputFile="$JUNIT_OPTIMIZATION"
  OPTIMIZATION_STATUS=$?
  OPTIMIZATION_SECONDS=$((SECONDS - ARM_STARTED))
  if [[ $TEST_STATUS -eq 0 ]]; then TEST_STATUS=$OPTIMIZATION_STATUS; fi
fi

# THE ACTIVE ARMS, as one indexed list.
#
# Five arms used to be spelled five times each in the three blocks below — a
# report check, a timing line and a liveness assertion — so adding an arm meant
# four edits and forgetting one meant an arm nobody measured. That is the shape
# of the hole this tier was built to close, one level up: the set the assertions
# govern and the set the run produced must be the same set. Now they are one
# array, and an arm this backend cannot measure is simply absent from it.
#
# `SKIPPED_ARMS` is printed rather than left implicit: an arm missing from the
# report because it was never run and one missing because it crashed look
# identical afterwards, and only one of them is fine.
#
# EACH ARM CARRIES ITS RATCHET TARGET, because that is the fifth thing that used
# to be spelled somewhere else: `skip-ratchet.ts` proved every target it knows
# about non-empty, and this backend runs a SUBSET of them. Under `--backend
# cloud` the behaviour, research and optimization arms are deliberately absent,
# so all three of their targets reported missing and the ratchet exited 1 — the
# tier could not pass while doing exactly what it was told. Now the arm array is
# also the target list, so the set the ratchet governs is the set this run
# produced, by construction rather than by two lists agreeing.
ARM_NAMES=()
ARM_JUNITS=()
ARM_SPENDS=()
ARM_SECONDS=()
ARM_TARGETS=()

arm() {
  ARM_NAMES+=("$1")
  ARM_JUNITS+=("$2")
  ARM_SPENDS+=("$3")
  ARM_SECONDS+=("$4")
  ARM_TARGETS+=("$5")
}

# The bun arm's target is its OWN argv, not a fixed `./tests/`: under cloud that
# argv is one file, and claiming the directory would let the ratchet pass over a
# target the run never selected.
#
# ONE entry, refused rather than truncated. `arm` carries one target per arm, so
# a second bun target would be silently dropped and the ratchet would prove the
# first non-empty while the run selected two. This is the check, not a comment.
if [[ ${#TARGETS[@]} -ne 1 ]]; then
  echo "eval-tier: the bun arm names ${#TARGETS[@]} targets and the ratchet takes one prefix per" \
    "arm — either split it into its own arm (its own JUnit and spend file) or give \`arm\` a" \
    "target list" >&2
  exit 1
fi
arm 'bun suites' "$JUNIT" "$SPEND_BUN" "$BUN_SECONDS" "${TARGETS[0]}"
if [[ $RUN_EVALS_ARM -eq 1 ]]; then arm 'behaviour evals' "$JUNIT_EVALS" "$SPEND_EVALS" "$EVALS_SECONDS" "./$BEHAVIOUR_EVAL"; fi
if [[ $RUN_SWARM_ARM -eq 1 ]]; then arm 'live swarm' "$JUNIT_SWARM" "$SPEND_SWARM" "$SWARM_SECONDS" "./$SWARM_EVAL"; fi
if [[ $RUN_RESEARCH_ARM -eq 1 ]]; then arm 'research' "$JUNIT_RESEARCH" "$SPEND_RESEARCH" "$RESEARCH_SECONDS" "./$RESEARCH_EVAL"; fi
if [[ $RUN_OPTIMIZATION_ARM -eq 1 ]]; then arm 'optimization' "$JUNIT_OPTIMIZATION" "$SPEND_OPTIMIZATION" "$OPTIMIZATION_SECONDS" "./$OPTIMIZATION_EVAL"; fi

for index in "${!ARM_NAMES[@]}"; do
  if [[ ! -f "${ARM_JUNITS[$index]}" ]]; then
    echo "eval-tier: the ${ARM_NAMES[$index]} arm produced no JUnit report (exit $TEST_STATUS) — nothing to" \
      "measure, and an unmeasured arm is what this tier exists to make impossible" >&2
    exit 1
  fi
done

echo
# EVERY ACTIVE ARM'S REPORT AND ITS TARGET, and `--expect-live` when a target was
# resolved. One report governed one arm; the flag is what stops a locked skip
# that RAN — which is the tier working — from being read as the lock owing an
# update, a verdict that made this script unable to exit 0 on any machine holding
# a credential.
#
# `--target` per arm is what makes `--backend cloud` runnable. The ratchet's own
# list names five arms; this backend runs two, and the three absent targets read
# as "the gate looked at an empty set" — exit 1 for a run that measured exactly
# what it was asked to. Both flags come off the same array, so the reports and
# the targets cannot describe different arms.
RATCHET_ARGS=()
for junit in "${ARM_JUNITS[@]}"; do RATCHET_ARGS+=(--junit "$junit"); done
for target in "${ARM_TARGETS[@]}"; do RATCHET_ARGS+=(--target "$target"); done
if [[ $EXPECT_LIVE -eq 1 ]]; then RATCHET_ARGS+=(--expect-live); fi
bun scripts/skip-ratchet.ts "${RATCHET_ARGS[@]}"
RATCHET_STATUS=$?

echo
echo "── per arm ($BACKEND) ────────────────────────────────────"
TIER_SECONDS=0
for index in "${!ARM_NAMES[@]}"; do
  printf '%-16s %5ds  %s\n' "${ARM_NAMES[$index]}" "${ARM_SECONDS[$index]}" \
    "$(bun scripts/eval-spend.ts "${ARM_SPENDS[$index]}" | sed -n 's/^  TOTAL: //p')"
  TIER_SECONDS=$((TIER_SECONDS + ARM_SECONDS[index]))
done
printf '%-16s %5ds\n' 'tier' "$TIER_SECONDS"
if [[ -n "$SKIPPED_ARMS" ]]; then echo "not run:         $SKIPPED_ARMS"; fi
echo "──────────────────────────────────────────────────────────"

# EACH ARM'S OWN LIVENESS, before the tier-wide one. A tier-wide total cannot
# fail on one arm's behalf because another arm's spend can hide it. The same
# `EXPECT_LIVE` value controls the banner and every assertion.
ARM_SPEND_STATUS=0
FAILED_ARM=''
for index in "${!ARM_NAMES[@]}"; do
  echo
  echo "── ${ARM_NAMES[$index]} arm ───────────────────────────────"
  SPEND_ARGS=("${ARM_SPENDS[$index]}")
  if [[ $EXPECT_LIVE -eq 1 ]]; then SPEND_ARGS+=(--expect-live); fi
  bun scripts/eval-spend.ts "${SPEND_ARGS[@]}"
  STATUS=$?
  echo "──────────────────────────────────────────────────────────"
  # FIRST failing arm, kept: "the research arm reached no model" is a sharper
  # sentence than "the tier reached no model", and every arm still reports so a
  # reader sees all of them before the exit.
  if [[ $STATUS -ne 0 && $ARM_SPEND_STATUS -eq 0 ]]; then
    ARM_SPEND_STATUS=$STATUS
    FAILED_ARM="${ARM_NAMES[$index]}"
  fi
done

echo
# `--expect-live` turns a resolved target into an obligation: the tier must show
# a model call and a token count or exit non-zero. Without it, this reports and
# returns 0 — which is what let `TOTAL: 0 model call(s)` pass a deploy gate.
cat "${ARM_SPENDS[@]}" > "$SPEND"
SPEND_ARGS=("$SPEND")
if [[ $EXPECT_LIVE -eq 1 ]]; then SPEND_ARGS+=(--expect-live); fi
bun scripts/eval-spend.ts "${SPEND_ARGS[@]}"
SPEND_STATUS=$?

# Precedence, most informative first. A suite failure names a behaviour or an
# outage and is what a reader should see; an undeclared skip is next; a tier that
# passed every assertion it made without reaching a model is last only because
# the two above already explain themselves.
if [[ $TEST_STATUS -ne 0 ]]; then
  echo "eval-tier: suites failed on the $BACKEND target (exit $TEST_STATUS)" >&2
  exit "$TEST_STATUS"
fi
if [[ $RATCHET_STATUS -ne 0 ]]; then exit "$RATCHET_STATUS"; fi
if [[ $ARM_SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the $FAILED_ARM arm proved no liveness on the $BACKEND target" \
    "(exit $ARM_SPEND_STATUS)" >&2
  exit "$ARM_SPEND_STATUS"
fi
if [[ $SPEND_STATUS -ne 0 ]]; then
  echo "eval-tier: the run proved no liveness on the $BACKEND target (exit $SPEND_STATUS)" >&2
  exit "$SPEND_STATUS"
fi
exit 0
