#!/usr/bin/env bash
# One trial per task on the named deployment. The same native armada map/artifacts path as statistical evals;
# PASS_FIRST_SLOT keeps the soak's accounts separate even when an operator requests another run by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/repo-runtime.sh
exec bun scripts/evals-map.ts --pass --out="${BENCH_ARTIFACTS:-$PWD/bench-artifacts/evals-pass}"
