#!/usr/bin/env bash
#
# THE FIRST-RUN TIER — what a new user meets, on the build that just deployed.
#
# It runs from `scripts/deploy.sh` AFTER the post-deploy smoke gate, and it is
# the only tier in this repository whose subject is the DEPLOYED product rather
# than this tree. Every other gate runs before the upload, over inputs their
# authors wrote; this one drives the deployment the way a person does — a fresh
# workspace over the public REST, the real model, a real browser click, two real
# daemons, real pty bytes — and it is RED on any of the five defects the owner
# found by hand.
#
# WHAT IT NEEDS, and what it does with nothing:
#
#   KINU_EVAL_BACKEND=cloud   set here. The suites refuse every other backend
#                             before consulting a credential: there is no public
#                             REST or WebSocket surface in front of an
#                             in-process runtime.
#   KINU_EVAL_TOKEN           the CLI bearer, resolved by
#                             `scripts/eval-credentials.ts` exactly as the eval
#                             tier resolves it. It registers devices and drives
#                             the pty client. `scripts/eval-session-mint.ts` mints
#                             it when none is persisted.
#   KINU_EVAL_WEB_IDENTITY    the deployment's DEV_IDENTITY_SECRET. The browser
#                             plane's authority: the REST create, the run-event
#                             and file routes, the consent and revoke routes,
#                             and the Chrome page all act as it.
#   KINU_EVAL_ORIGIN          which deployment. Defaults to https://kinu.run, and
#                             the allowlist admits that and loopback dev servers
#                             only.
#
# WITH A CREDENTIAL MISSING IT FAILS. That is the opposite of the eval tier's
# rule and it is deliberate: the eval tier must be reproducible on a machine
# that cannot pay, so its live cases skip and its ratchet proves the skips are
# declared. This tier exists to answer one question about one deployment — does
# the product a user meets work — and a run that skipped every case answers it
# with silence while exiting 0. A deploy gate that can pass having measured
# nothing is the defect this whole tier was built to name.
#
#   bash scripts/first-run-tier.sh                    # against https://kinu.run
set -euo pipefail

cd "$(dirname "$0")/.."

# The knob the suites gate on, before anything reads a credential.
export KINU_EVAL_BACKEND=cloud
# The consent that lets a live model be called at all, exactly as the eval tier
# spells it: being driven by this script is the consent.
export KINU_EVAL_LIVE=1

REPORT_DIR="$(bun scripts/bench-retention.ts --family first-run --backend cloud)"
echo "retained reports: $REPORT_DIR"
SPEND="$REPORT_DIR/spend-first-run.jsonl"
: > "$SPEND"
export KINU_EVAL_SPEND_FILE="$SPEND"

# Resolve the identity and put it where `resolveLiveModel` looks. MUST be here
# rather than inside a suite: `scripts/test-scratch-home.ts` strips the
# credential variables at preload in every test process. A non-zero exit is
# fatal — it means the credential is aimed at a deployment the allowlist refuses,
# and continuing would run the whole tier against whatever the environment
# happened to say.
# The tier runs inside the deploy, against the build it just shipped, so the
# eval-service bearer for THIS deployment may not exist yet. The web identity
# can approve the device flow that mints one; a persisted session is reused.
if [[ -n "${KINU_EVAL_WEB_IDENTITY:-}" && -z "${KINU_EVAL_TOKEN:-}" ]]; then
  bun scripts/eval-session-mint.ts || exit 1
fi
RESOLVED_OUT="$(bun scripts/eval-credentials.ts)"
mapfile -t RESOLVED <<< "$RESOLVED_OUT"
if [[ ${#RESOLVED[@]} -eq 2 ]]; then
  export KINU_ORIGIN="${RESOLVED[0]}"
  export KINU_TOKEN="${RESOLVED[1]}"
fi

if [[ -z "${KINU_TOKEN:-}" || -z "${KINU_ORIGIN:-}" ]]; then
  echo "first-run: no deployment credential resolved, so this tier would measure nothing." >&2
  echo "  It drives the DEPLOYED product; a skip here is a deploy gate passing over a product" >&2
  echo "  nobody looked at. Export KINU_EVAL_TOKEN (the CLI bearer) and KINU_EVAL_WEB_IDENTITY" >&2
  echo "  (the deployment's DEV_IDENTITY_SECRET). scripts/eval-session-mint.ts mints the bearer." >&2
  exit 1
fi
if [[ -z "${KINU_EVAL_WEB_IDENTITY:-}" ]]; then
  echo "first-run: KINU_EVAL_WEB_IDENTITY is not set, so the browser plane has no authority." >&2
  echo "  Every case creates its workspace over /api/user/workspaces and one of them clicks a" >&2
  echo "  button in Chrome; the CLI bearer reaches neither. Its value is the deployment's" >&2
  echo "  DEV_IDENTITY_SECRET." >&2
  exit 1
fi

echo "── first-run tier ────────────────────────────────────────"
echo "target:   $KINU_ORIGIN"
echo "declared cases: $(ls tests/first-run/*.first-run.ts | wc -l | tr -d ' ') (executed/skipped cases are listed in JUnit)"
echo "──────────────────────────────────────────────────────────"
echo "Operator-only checks need their explicit target and authority; skipped cases remain unverified."

# `bun --bun` is REQUIRED, not stylistic: the pty case spawns through
# `Bun.spawnSync` and the public session opens a header-carrying WebSocket,
# neither of which exists under node-hosted vitest.
#
# TWO PROCESSES, SIDE BY SIDE (vitest.first-run.config.ts states why): the
# cases that attach machines to the account's device fleet run one at a time in
# `first-run-fleet`, and every other case runs concurrently in
# `first-run-cases`. Two processes because vitest runs its projects one after
# another inside one; each writes its own JUnit, and a red in either is the
# tier's red.
#
# Positional arguments are case file filters, passed straight to vitest — a
# targeted re-drive of a named subset needs no second runner, and the spend
# and JUnit assertions below apply to it the same way. A filter may name cases
# of one project only, so a filtered run lets the other select nothing; the
# whole tier passes no filter, and there each project must select its cases.
# A failing suite must still report the spend it incurred.
EMPTY_SELECTION=()
if [[ $# -gt 0 ]]; then EMPTY_SELECTION=(--passWithNoTests); fi
run_project() {
  local project="$1"
  shift
  bun --bun vitest run --config vitest.first-run.config.ts --project "$project" \
    --reporter=default --reporter=junit --outputFile="$REPORT_DIR/junit-$project.xml" \
    "${EMPTY_SELECTION[@]}" "$@"
}
set +e
run_project first-run-fleet "$@" &
FLEET_PID=$!
run_project first-run-cases "$@" &
CASES_PID=$!
wait "$FLEET_PID"
FLEET_STATUS=$?
wait "$CASES_PID"
CASES_STATUS=$?
STATUS=$FLEET_STATUS
if [[ $STATUS -eq 0 ]]; then STATUS=$CASES_STATUS; fi

# WHAT IT SPENT, and the assertion that it spent anything. Two of the five cases
# call a model; a run reporting no model call at all measured no agent, whatever
# its exit code said.
bun scripts/eval-spend.ts "$SPEND" --expect-live
SPEND_STATUS=$?

if [[ $STATUS -ne 0 ]]; then exit "$STATUS"; fi
exit "$SPEND_STATUS"
