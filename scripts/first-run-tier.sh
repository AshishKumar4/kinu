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
#                             the pty client.
#   KINU_EVAL_WEB_IDENTITY    the deployment's DEV_IDENTITY_SECRET. The browser
#                             plane's authority: the REST create, the run-event
#                             and file routes, the consent and revoke routes,
#                             and the Chrome page all act as it.
#   KINU_EVAL_ORIGIN          which deployment. Defaults to staging.
#   KINU_EVAL_ALLOW_PROD=1    required to point any of this at production, which
#                             is what a post-deploy production run is. Named on
#                             the command line so the choice is recorded in what
#                             somebody ran.
#
# WITH A CREDENTIAL MISSING IT FAILS. That is the opposite of the eval tier's
# rule and it is deliberate: the eval tier must be reproducible on a machine
# that cannot pay, so its live cases skip and its ratchet proves the skips are
# declared. This tier exists to answer one question about one deployment — does
# the product a user meets work — and a run that skipped every case answers it
# with silence while exiting 0. A deploy gate that can pass having measured
# nothing is the defect this whole tier was built to name.
#
#   bash scripts/first-run-tier.sh                    # against KINU_EVAL_ORIGIN
#   KINU_EVAL_ALLOW_PROD=1 KINU_EVAL_ORIGIN=https://kinu.run \
#     bash scripts/first-run-tier.sh                  # against production
set -euo pipefail

cd "$(dirname "$0")/.."

# The knob the suites gate on, before anything reads a credential.
export KINU_EVAL_BACKEND=cloud
# The consent that lets a live model be called at all, exactly as the eval tier
# spells it: being driven by this script is the consent.
export KINU_EVAL_LIVE=1

REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kinu-first-run-XXXXXX")"
JUNIT="$REPORT_DIR/junit-first-run.xml"
SPEND="$REPORT_DIR/spend-first-run.jsonl"
: > "$SPEND"
export KINU_EVAL_SPEND_FILE="$SPEND"
trap 'rm -rf "$REPORT_DIR"' EXIT

# Resolve the identity and put it where `resolveLiveModel` looks. MUST be here
# rather than inside a suite: `scripts/test-scratch-home.ts` strips the
# credential variables at preload in every test process. A non-zero exit is
# fatal — it means the credential is aimed at a deployment the allowlist refuses,
# and continuing would run the whole tier against whatever the environment
# happened to say.
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
  echo "  (the deployment's DEV_IDENTITY_SECRET), and KINU_EVAL_ALLOW_PROD=1 for production." >&2
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
echo "cases:    $(ls tests/first-run/*.first-run.ts | wc -l | tr -d ' ') (one per defect found by hand)"
echo "──────────────────────────────────────────────────────────"

# `bun --bun` is REQUIRED, not stylistic: the pty case spawns through
# `Bun.spawnSync` and the public session opens a header-carrying WebSocket,
# neither of which exists under node-hosted vitest.
bun --bun vitest run --config vitest.first-run.config.ts \
  --reporter=default --reporter=junit --outputFile="$JUNIT"
STATUS=$?

# WHAT IT SPENT, and the assertion that it spent anything. Two of the five cases
# call a model; a run reporting no model call at all measured no agent, whatever
# its exit code said.
bun scripts/eval-spend.ts "$SPEND" --expect-live
SPEND_STATUS=$?

if [[ $STATUS -ne 0 ]]; then exit "$STATUS"; fi
exit "$SPEND_STATUS"
