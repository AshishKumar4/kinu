#!/usr/bin/env bash
# ONE TRIAL OF EVERY EVAL TASK, on the deployment that just went up.
#
# The deploy runs it in its one wave, beside the tiers against the deployment
# and every local gate (L18), so an eval task that fails outright is a red in
# that deploy's report. One trial has no statistics: those are
# .github/workflows/evals.yml's, which the deploy dispatches against the same
# deployment and whose green run a promotion waits for.
#
# The harness (evals/) runs the task files five at a time, on Muse by default, as eval-service at KINU_EVAL_ORIGIN, with the
# identity `evalWebIdentityEnv` names for that origin. A failed trial exits 1
# and prints its reason; each trial's evidence goes beside the deploy's report
# when there is one.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/repo-runtime.sh
: "${KINU_EVAL_ORIGIN:?names the deployment this pass drives; the deploy exports it}"
export KINU_EVAL_TRIALS=1
# evals.yml's 20 Muse calls run beside it on the same opencode-go key (its KINU_EVAL_FILES).
export KINU_EVAL_FILES=5 KINU_EVAL_CONCURRENCY=1
unset KINU_EVAL_MODELS
if [[ -n "${KINU_DEPLOY_REPORT:-}" ]]; then
  export BENCH_ARTIFACTS="$KINU_DEPLOY_REPORT/evals"
fi
# The eval accounts' provider keys are stored by the deploy before it starts this row (deploy.sh, provision_eval_keys).
exec bun run evals
