#!/usr/bin/env bash
#
# THE DURABILITY CANARY — hours of agent work with nobody connected, then rest.
#
# Runs `scripts/durability-canary.ts` as the `scripted` eval account, on the
# scripted model (zero model tokens), against the deployment KINU_EVAL_ORIGIN
# names, which it requires: hours of load are never sent to a default. Staging's
# numbers on today's build are the baseline the durable-execution redesign is
# judged against (kinu-logs/onstart/DESIGN.md, S0). It resolves the
# account exactly as the first-run tier does, and fails without a credential,
# for the same reason: a canary that measured nothing must not exit 0.
#
#   bash scripts/durability-canary.sh --plan
#   KINU_EVAL_ORIGIN=https://staging.kinu.run bash scripts/durability-canary.sh --steps 540 --sleep 20 ...
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/repo-runtime.sh

for arg in "$@"; do
  if [[ "$arg" == --plan ]]; then
    exec bun scripts/durability-canary.ts "$@"
  fi
done

CANARY_BUN=(bun)
if [[ -f "$HOME/.config/kinu/secrets.env" ]]; then
  CANARY_BUN+=("--env-file=$HOME/.config/kinu/secrets.env")
fi

export KINU_EVAL_BACKEND=cloud
export KINU_EVAL_LIVE=1

if [[ -z "${KINU_EVAL_ORIGIN:-}" ]]; then
  echo "canary: KINU_EVAL_ORIGIN names no deployment, and the canary takes no default." >&2
  exit 2
fi
mapfile -t TARGET <<< "$(bun scripts/eval-target.ts)"
if [[ ${#TARGET[@]} -ne 2 ]]; then
  echo "canary: $KINU_EVAL_ORIGIN is no deployment to load (scripts/eval-target.ts said why)." >&2
  exit 1
fi
export KINU_EVAL_ORIGIN="${TARGET[0]}"

ACCOUNT=scripted
KINU_EVAL_ACCOUNT=$ACCOUNT "${CANARY_BUN[@]}" scripts/eval-session-mint.ts || exit 1
RESOLVED_OUT="$(KINU_EVAL_ACCOUNT=$ACCOUNT "${CANARY_BUN[@]}" scripts/eval-credentials.ts)"
mapfile -t RESOLVED <<< "$RESOLVED_OUT"
if [[ ${#RESOLVED[@]} -ne 2 || "${RESOLVED[0]}" != "$KINU_EVAL_ORIGIN" ]]; then
  echo "canary: no CLI bearer for the $ACCOUNT eval account at $KINU_EVAL_ORIGIN." >&2
  exit 1
fi
export KINU_ORIGIN="${RESOLVED[0]}"
export KINU_TOKEN="${RESOLVED[1]}"
KINU_TOKEN=$KINU_TOKEN "${CANARY_BUN[@]}" scripts/scripted-tier.ts "$KINU_ORIGIN" "$ACCOUNT" || exit 1

KINU_EVAL_ACCOUNT=$ACCOUNT "${CANARY_BUN[@]}" scripts/durability-canary.ts "$@"
