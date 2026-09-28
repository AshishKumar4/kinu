#!/usr/bin/env bash
# The product flows (scripts/product-flows.ts) in real Chrome against the
# deployment that just went up, as the `scripted` eval account on the tiers'
# scripted model (scripts/tier-model.ts), which plays each row's calls. The same
# file runs before the deploy against the local dev server
# (scripts/with-dev-server.ts) on that model; the origin arrives as KINU_ORIGIN
# either way. On the account's real model the rows measured the model instead:
# on staging 7dd73e1ac9 (2026-09-27) the slate row spent 425 s in 47
# rate-limit backoffs and 32 steps and was killed. Whether a real model makes the
# calls a row names is the evals' question (evals/).
set -euo pipefail
cd "$(dirname "$0")/.."

# The live consent the test preload asks for before a suite may read
# KINU_ORIGIN (scripts/test-scratch-home.ts); these rows drive a deployment.
export KINU_EVAL_LIVE=1
export KINU_ORIGIN="${KINU_ORIGIN:-$(bun -e "import { EVAL_DEPLOYMENT_ORIGIN } from '@kinu.run/test-utils'; console.log(EVAL_DEPLOYMENT_ORIGIN)")}"

# Each deployment's secret arrives in its own variable (evalWebIdentityEnv).
IDENTITY_ENV="$(bun -e "import { evalWebIdentityEnv } from '@kinu.run/test-utils'; console.log(evalWebIdentityEnv(process.argv[1]))" "$KINU_ORIGIN")" \
  && [[ -n "$IDENTITY_ENV" ]] \
  || { echo "product-flows: cannot name the variable holding $KINU_ORIGIN's DEV_IDENTITY_SECRET." >&2; exit 1; }
if [[ -z "${!IDENTITY_ENV:-}" ]]; then
  echo "product-flows: $IDENTITY_ENV is not set, so the browser has no authority at $KINU_ORIGIN." >&2
  echo "  Its value is that deployment's DEV_IDENTITY_SECRET, sent as x-kinu-dev-identity on every request." >&2
  exit 1
fi

# The first-run tier sets the same account up beside this one; both steps are
# idempotent. scripted-tier.ts proves a hosted turn answers from the script
# before any row runs, so a row's red is the product's.
export KINU_EVAL_ACCOUNT=scripted
bun scripts/eval-session-mint.ts || exit 1
mapfile -t RESOLVED <<< "$(bun scripts/eval-credentials.ts)"
if [[ ${#RESOLVED[@]} -ne 2 || "${RESOLVED[0]}" != "$KINU_ORIGIN" ]]; then
  echo "product-flows: no CLI bearer for the $KINU_EVAL_ACCOUNT eval account at $KINU_ORIGIN." >&2
  exit 1
fi
KINU_EVAL_BACKEND=cloud KINU_TOKEN="${RESOLVED[1]}" bun scripts/scripted-tier.ts "$KINU_ORIGIN" "$KINU_EVAL_ACCOUNT" || exit 1

echo "── product flows ─────────────────────────────────────────"
echo "target:   $KINU_ORIGIN as $KINU_EVAL_ACCOUNT"
exec bun test --timeout=0 tests/browser/product-flows.test.ts
