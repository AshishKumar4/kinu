#!/usr/bin/env bash
#
# THE TRAJECTORY TIER AT DEPLOY — does the agent still act, on the model users
# have, before the next build goes up.
#
# It runs from `scripts/deploy.sh` as the LAST pre-deploy gate, and it is the
# one gate in Step 1 whose subject is the DEPLOYED product rather than this tree.
# `scripts/first-run-tier.sh` asks the same kind of question AFTER the upload,
# about the build that just shipped; this asks it BEFORE, about the build that
# is serving now. The two are not redundant: an agent that stopped acting on an
# explicit instruction — that surveys, asks, and writes nothing — is invisible
# to every source gate, and a first-run red after the publish is a defect users
# already have. A red here holds the upload.
#
# ONE ARM, ONE MODEL. It runs `tests/evals/trajectory.eval.ts` and nothing else,
# under `KINU_EVAL_TIER=product`, which the suite resolves to
# `EVAL_MODELS.product` — the product's own default model, imported from core.
# The flash and pro arms measure a model the owner chose for statistics; this
# arm measures the one a new workspace gets when nobody chooses, because a red
# on any other model is a red on a model users do not have.
#
# WHAT IT NEEDS, and what it does with nothing — the first-run tier's rule,
# for the first-run tier's reason. The eval tier must stay reproducible on a
# machine that cannot pay, so its live cases skip and its ratchet proves the
# skips are declared. A DEPLOY gate that can pass having measured nothing is
# the defect this whole tier exists to name, so with a credential missing it
# FAILS.
#
#   KINU_EVAL_BACKEND=cloud   set here. The suite refuses every other backend
#                             before consulting a credential: there is no
#                             public REST or WebSocket surface in front of an
#                             in-process runtime.
#   KINU_EVAL_TOKEN           the CLI bearer, resolved by
#                             `scripts/eval-credentials.ts` exactly as the eval
#                             tier resolves it, or minted from the web identity
#                             when absent.
#   KINU_EVAL_WEB_IDENTITY    the deployment's DEV_IDENTITY_SECRET. The browser
#                             plane's authority: the REST create, the run-event
#                             and file routes all act as it.
#   KINU_EVAL_ORIGIN          which deployment. Defaults to the origin
#                             `eval-credentials.ts` resolves.
#
#   bash scripts/trajectory-tier.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# The knob the suite gates on, before anything reads a credential.
export KINU_EVAL_BACKEND=cloud
# The consent that lets a live model be called at all, exactly as the eval tier
# spells it: being driven by this script is the consent.
export KINU_EVAL_LIVE=1
# The arm: the product's default model, never the statistics model.
export KINU_EVAL_TIER=product

TRAJECTORY_EVAL=tests/evals/trajectory.eval.ts

REPORT_DIR="$(bun scripts/bench-retention.ts --family eval --backend cloud)"
echo "retained reports: $REPORT_DIR"
JUNIT="$REPORT_DIR/junit-trajectory-product.xml"
SPEND="$REPORT_DIR/spend-trajectory-product.jsonl"
: > "$SPEND"
export KINU_EVAL_SPEND_FILE="$SPEND"

# Resolve the identity and put it where `resolveLiveModel` looks. MUST be here
# rather than inside the suite: `scripts/test-scratch-home.ts` strips the
# credential variables at preload in every test process. A non-zero exit is
# fatal — it means the credential is aimed at a deployment the allowlist refuses,
# and continuing would run the tier against whatever the environment happened
# to say. The eval-service bearer may not exist on this machine yet; the web
# identity can approve the device flow that mints one, and a persisted session
# is reused.
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
  echo "trajectory: no deployment credential resolved, so this tier would measure nothing." >&2
  echo "  It drives the DEPLOYED product on its default model; a skip here is a deploy gate" >&2
  echo "  passing over an agent nobody looked at. Export KINU_EVAL_TOKEN (the CLI bearer) and" >&2
  echo "  KINU_EVAL_WEB_IDENTITY (the deployment's DEV_IDENTITY_SECRET)." >&2
  exit 1
fi
if [[ -z "${KINU_EVAL_WEB_IDENTITY:-}" ]]; then
  echo "trajectory: KINU_EVAL_WEB_IDENTITY is not set, so the browser plane has no authority." >&2
  echo "  Every case creates its workspace over /api/user/workspaces and reads its evidence" >&2
  echo "  over the public routes; the CLI bearer reaches neither. Its value is the" >&2
  echo "  deployment's DEV_IDENTITY_SECRET." >&2
  exit 1
fi

echo "── trajectory tier (product model) ───────────────────────"
echo "target:   $KINU_ORIGIN"
echo "arm:      KINU_EVAL_TIER=$KINU_EVAL_TIER ($TRAJECTORY_EVAL)"
echo "──────────────────────────────────────────────────────────"

# `bun --bun` is REQUIRED, not stylistic: the public session opens a
# header-carrying WebSocket, which is Bun's constructor and does not exist
# under node-hosted vitest. A failing suite must still report the spend it
# incurred.
set +e
ARM_STARTED=$SECONDS
bun --bun ./node_modules/.bin/vitest run --config vitest.evals.config.ts "$TRAJECTORY_EVAL" \
  --reporter=default --reporter=junit --outputFile="$JUNIT"
STATUS=$?
echo "trajectory tier wall: $((SECONDS - ARM_STARTED))s"

# WHAT IT SPENT, and the assertion that it spent anything: a run reporting no
# model call at all measured no agent, whatever its exit code said.
bun scripts/eval-spend.ts "$SPEND" --expect-live
SPEND_STATUS=$?

if [[ $STATUS -ne 0 ]]; then exit "$STATUS"; fi
exit "$SPEND_STATUS"
