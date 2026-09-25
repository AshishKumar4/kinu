#!/usr/bin/env bash
# The product flows (scripts/product-flows.ts) in real Chrome against the
# deployment that just went up, as the eval identity, on its real model. The
# same file runs before the deploy against the local dev server
# (scripts/with-dev-server.ts) on the flows' scripted model; the origin arrives
# as KINU_ORIGIN either way.
set -euo pipefail
cd "$(dirname "$0")/.."

# The live consent the test preload asks for before a suite may read
# KINU_ORIGIN (scripts/test-scratch-home.ts); these rows spend real turns.
export KINU_EVAL_LIVE=1
export KINU_ORIGIN="${KINU_ORIGIN:-$(bun -e "import { EVAL_DEPLOYMENT_ORIGIN } from '@kinu.run/test-utils'; console.log(EVAL_DEPLOYMENT_ORIGIN)")}"

if [[ -z "${KINU_EVAL_WEB_IDENTITY:-}" ]]; then
  echo "product-flows: KINU_EVAL_WEB_IDENTITY is not set, so the browser has no authority at $KINU_ORIGIN." >&2
  echo "  Its value is the deployment's DEV_IDENTITY_SECRET, sent as x-kinu-dev-identity on every request." >&2
  exit 1
fi

echo "── product flows ─────────────────────────────────────────"
echo "target:   $KINU_ORIGIN"
exec bun test --timeout=0 scripts/product-flows.test.ts
