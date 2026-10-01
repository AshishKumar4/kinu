#!/usr/bin/env bash
# ONE TRIAL OF EVERY EVAL TASK, on the deployment that just went up.
#
# The deploy runs it in its one wave, beside the tiers against the deployment
# and every local gate (L18), so an eval task that fails outright is a red in
# that deploy's report. One trial has no statistics: those are
# .github/workflows/evals.yml's, which the deploy dispatches against the same
# deployment and whose green run a promotion waits for.
#
# The harness (evals/) runs every task file at once and every trial of a file
# at once, on its default models, as eval-service at KINU_EVAL_ORIGIN, with the
# identity `evalWebIdentityEnv` names for that origin. A failed trial exits 1
# and prints its reason; each trial's evidence goes beside the deploy's report
# when there is one.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${KINU_EVAL_ORIGIN:?names the deployment this pass drives; the deploy exports it}"
export KINU_EVAL_TRIALS=1
if [[ -n "${KINU_DEPLOY_REPORT:-}" ]]; then
  export BENCH_ARTIFACTS="$KINU_DEPLOY_REPORT/evals"
fi
exec bun run evals
